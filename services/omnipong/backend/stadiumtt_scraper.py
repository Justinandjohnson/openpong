"""Public league-match scraper for STADIUM (stadiumtt.com).

This replaces the old credential-based ``stadium_league_scraper.py`` path for the
new public STADIUM site. Everything here is login-free:

* headless Playwright Chromium (bundled browser, optional ``channel`` override),
* navigate to a configured league/tournament URL,
* dismiss the cookie-consent dialog,
* open the MATCHES tab,
* click "Load More" until every match is rendered,
* expand submitted match cards to read individual game scores,
* parse the DOM with BeautifulSoup into normalised records,
* upsert into ``matches`` with ``source='stadium_league'`` and an idempotent key.

No league URL, player name, or credential is hard-coded. League URLs come from
``STADIUMTT_LEAGUE_URLS`` (comma-separated) and/or repeatable ``--league-url``
flags. The owner name comes from ``STADIUMTT_OWNER`` / ``OMNIPONG_OWNER`` /
``PLAYER_FULL_NAME`` or the local ``users`` table.

The legacy login scraper is still available through ``--legacy-login`` but is
never the default.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from datetime import date
from urllib.parse import urlsplit

try:  # optional at import time; tests do not need it
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - dotenv is in requirements.txt
    load_dotenv = None  # type: ignore[assignment]

from bs4 import BeautifulSoup

SOURCE = "stadium_league"

SERVICE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if load_dotenv is not None:
    load_dotenv(os.path.join(SERVICE_ROOT, ".env"))

MONTHS = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
    # the live site ships at least one misspelled month
    "octobor": 10,
    "septmber": 9,
    "febuary": 2,
}

DATE_RE = re.compile(
    r"(?P<month>[A-Za-z]{3,9})\.?\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?,?\s*(?P<year>\d{4})"
)
GROUP_RE = re.compile(r"Group\s+([A-Za-z0-9]+)", re.IGNORECASE)
PAIRING_RE = re.compile(r"\(([^()]*?vs\.?[^()]*?)\)", re.IGNORECASE)
TABLES_RE = re.compile(
    r"Tables?\s*:\s*([0-9][0-9\s,&]*(?:and\s+[0-9]+)?)", re.IGNORECASE
)
NO_TABLE_RE = re.compile(r"\bNo\s+Table\b", re.IGNORECASE)
STATE_RE = re.compile(r"\b([A-Z]{2,3})\s*\((?:USA|CAN|MEX|[A-Z]{3})\)")


# ---------------------------------------------------------------------------
# small text helpers (pure, unit-testable)
# ---------------------------------------------------------------------------
def squash(value) -> str:
    """Collapse all whitespace runs and trim."""
    if value is None:
        return ""
    return " ".join(str(value).replace("\xa0", " ").split())


def _element_text(element, separator: str = "") -> str:
    if element is None:
        return ""
    return squash(element.get_text(separator=separator))


def name_tokens(name: str) -> tuple[str, ...]:
    """Order-independent identity tokens for a player name.

    Handles ``Last, First`` and ``First Last``, accents, punctuation and extra
    spaces (the live site emits names like ``Shaheen-Vélez , Bahjat``).
    """
    text = unicodedata.normalize("NFKD", squash(name))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.casefold().replace(",", " ").replace(".", " ")
    tokens = [t for t in re.split(r"[^a-z0-9]+", text) if t]
    return tuple(sorted(tokens))


def name_matches_owner(candidate: str, owner: str) -> bool:
    """True when two player names identify the same person."""
    if not candidate or not owner:
        return False
    if squash(candidate).casefold() == squash(owner).casefold():
        return True
    return bool(name_tokens(candidate)) and name_tokens(candidate) == name_tokens(owner)


def to_last_first(name: str) -> str:
    """Normalise a name to ``Last, First`` form without changing it if already."""
    name = squash(name)
    if not name:
        return ""
    if "," in name:
        last, first = name.split(",", 1)
        return f"{squash(last)}, {squash(first)}".strip().strip(",")
    parts = name.split()
    if len(parts) >= 2:
        return f"{parts[-1]}, {' '.join(parts[:-1])}"
    return name


def normalize_owner_candidates(explicit: str | None = None, env=None) -> str | None:
    env = os.environ if env is None else env
    if explicit and squash(explicit):
        return squash(explicit)
    for key in (
        "STADIUMTT_OWNER",
        "OMNIPONG_OWNER",
        "PLAYER_FULL_NAME",
        "PLAYER_NAME",
    ):
        value = squash(env.get(key, ""))
        if value and not (key == "PLAYER_NAME" and value.casefold() == "the player"):
            return value
    return None


def parse_league_urls(cli_urls=None, env=None) -> list[str]:
    """Merge ``--league-url`` values with comma/space separated env values."""
    env = os.environ if env is None else env
    urls: list[str] = []
    raw = env.get("STADIUMTT_LEAGUE_URLS", "") or ""
    for item in re.split(r"[,\s]+", raw):
        if item.strip():
            urls.append(item.strip())
    for item in cli_urls or []:
        if item and item.strip():
            urls.append(item.strip())
    seen = set()
    clean: list[str] = []
    for url in urls:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError(f"Invalid league URL (must be http/https): {url!r}")
        if url not in seen:
            seen.add(url)
            clean.append(url)
    return clean


# ---------------------------------------------------------------------------
# DB / configuration helpers
# ---------------------------------------------------------------------------
def default_db_path() -> str:
    return os.environ.get("OMNIPONG_DB") or os.path.join(SERVICE_ROOT, "omnipong.db")


def resolve_owner(explicit: str | None = None, db_path: str | None = None, env=None) -> str | None:
    """Resolve the owner name, preferring explicit/env then the ``users`` row."""
    found = normalize_owner_candidates(explicit, env=env)
    if found:
        return found
    path = db_path or default_db_path()
    if path and os.path.exists(path):
        try:
            conn = sqlite3.connect(path)
            try:
                row = conn.execute(
                    "SELECT name FROM users WHERE name IS NOT NULL AND TRIM(name) <> '' "
                    "ORDER BY id LIMIT 1"
                ).fetchone()
            finally:
                conn.close()
            if row and squash(row[0]):
                return to_last_first(row[0])
        except sqlite3.Error:
            pass
    return None


def _ensure_matches_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY,
            activity_id INTEGER,
            date DATE,
            winner_name VARCHAR,
            loser_name VARCHAR,
            opponent_name VARCHAR,
            opponent_usatt_id VARCHAR,
            opponent_rating INTEGER,
            score_summary VARCHAR,
            result VARCHAR,
            source VARCHAR,
            set_scores TEXT
        )
        """
    )


# ---------------------------------------------------------------------------
# DOM parsing (fixture-testable; no browser required)
# ---------------------------------------------------------------------------
def parse_description(description: str) -> dict:
    """Parse ``"August 26, 2026 Round Robin • Group 3 (C vs. F)"``."""
    text = squash(description)
    out = {
        "date": None,
        "event_label": None,
        "group": None,
        "pairing": None,
    }
    match = DATE_RE.search(text)
    if match:
        month = MONTHS.get(match.group("month").casefold())
        if month:
            try:
                out["date"] = date(
                    int(match.group("year")), month, int(match.group("day"))
                ).isoformat()
            except ValueError:
                out["date"] = None
        rest = text[match.end():]
    else:
        rest = text
    rest = rest.strip(" \t•·-–—|")
    parts = [p.strip() for p in re.split(r"[•·|]", rest) if p.strip()]
    if parts:
        out["event_label"] = parts[0]
    group = GROUP_RE.search(rest)
    if group:
        out["group"] = f"Group {group.group(1)}"
    pairing = PAIRING_RE.search(rest)
    if pairing:
        out["pairing"] = squash(pairing.group(1))
    return out


def parse_status(status_attr: str, status_text: str = "") -> dict:
    """Normalise the card status badge."""
    raw = squash(status_attr).casefold()
    label = squash(status_text) or squash(status_attr).replace("-", " ").title()
    if not raw:
        if "not submitted" in label.casefold():
            raw = "unsubmitted"
        elif "verified" in label.casefold():
            raw = "submitted-verified"
        elif "submitted" in label.casefold():
            raw = "submitted-unverified"
    label_lower = label.casefold()
    if raw.startswith("submitted") or raw in ("certified", "confirmed", "verified"):
        submitted = True
    elif raw == "unsubmitted":
        submitted = False
    else:
        submitted = any(
            word in label_lower for word in ("submitted", "certified", "confirmed", "verified")
        ) and "not submitted" not in label_lower
    return {"status": raw or None, "status_label": label or None, "submitted": submitted}


def parse_tables(text: str) -> dict:
    """Return ``{"tables": "1, 2, & 3", "table_numbers": ["1","2","3"]}``."""
    value = squash(text)
    match = TABLES_RE.search(value)
    if match:
        raw = squash(match.group(1)).strip(" ,&")
        numbers = re.findall(r"\d+", raw)
        return {"tables": raw or None, "table_numbers": numbers}
    if NO_TABLE_RE.search(value):
        return {"tables": None, "table_numbers": []}
    return {"tables": None, "table_numbers": []}


def parse_affiliation(text: str) -> dict:
    """Parse ``"1353 • DALLAS TTC • OR (USA)"`` or legacy ``"1229 • OR"``."""
    value = squash(text)
    rating = None
    rm = re.match(r"(\d{3,5})\b", value)
    if rm:
        rating = int(rm.group(1))
    else:
        nums = re.findall(r"\b(\d{3,5})\b", value)
        if nums:
            rating = int(nums[0])
    state = None
    states = STATE_RE.findall(value)
    if states:
        state = states[-1]
    else:
        # Legacy cards render a bare state token after the rating bullet
        # (e.g. "1229 • OR"); "NO AFFILIATION" must not become state "NO".
        candidates = [
            token
            for token in re.findall(r"\b([A-Z]{2})\b", value)
            if token not in {"NO", "OF"}
        ]
        if candidates:
            state = candidates[-1]
        else:
            # Some affiliations are city-only, e.g. "AUSTIN (USA)" or
            # "AUSTIN TABLE TENNIS CLUB • AUSTIN (USA)".
            last_segment = value.split("•")[-1].strip()
            city = re.match(
                r"([A-Za-z][A-Za-z .'\-]*?)\s*\((?:USA|CAN|MEX|[A-Z]{3})\)",
                last_segment,
            )
            if city:
                words = city.group(1).split()
                if words and len(words[-1]) >= 3:
                    state = words[-1].upper()
    return {"rating": rating, "state": state, "affiliation": value or None}


def _score_int(value) -> int | None:
    text = squash(value)
    return int(text) if text.isdigit() else None


def extract_cards_from_html(html: str) -> list[dict]:
    """Parse a saved MATCHES-tab DOM snapshot into raw card dictionaries."""
    soup = BeautifulSoup(html, "html.parser")
    cards: list[dict] = []
    for card in soup.select(".TournamentMatchCard"):
        info = card.select_one(".TournamentMatchInfo")
        if info is None:
            continue
        description_el = info.select_one(".TournamentMatchDescription")
        status_el = info.select_one(".MatchStatusV2")
        info_text = _element_text(info, separator=" ")
        sides = []
        for side_el in card.select(".MatchCard-score-and-side"):
            score_el = side_el.select_one(".MatchCard-score")
            entry = side_el.select_one(".Entry")
            sides.append(
                {
                    "side": squash(side_el.get("data-side"))
                    or ("b" if len(sides) == 1 else "a"),
                    "score": _element_text(score_el),
                    "winning": squash(score_el.get("data-is-winning-score")).casefold()
                    == "true"
                    if score_el is not None
                    else False,
                    "name": _element_text(side_el.select_one(".Entry-name")),
                    "affiliation": _element_text(
                        side_el.select_one(".Entry-affiliation")
                    ),
                    "entry_id": squash(entry.get("data-entry-id")) if entry else None,
                }
            )
        games: list[list[str]] = []
        for row in card.select(".MatchScoresV2-game-scores"):
            values = [_element_text(v) for v in row.select(".MatchScoresV2-score")]
            if len(values) >= 2 and values[0] and values[1]:
                games.append([values[0], values[1]])
        cards.append(
            {
                "match_id": squash(info.get("data-id")) or None,
                "description": _element_text(description_el),
                "status_attr": squash(status_el.get("data-status")) if status_el else "",
                "status_text": _element_text(status_el),
                "tables_text": info_text,
                "sides": sides,
                "games": games,
                "expanded": squash(card.get("data-expanded")).casefold() == "true",
            }
        )
    return cards


# ---------------------------------------------------------------------------
# Record normalisation
# ---------------------------------------------------------------------------
def _winner_from_card(sides: list[dict], games: list[list[str]]) -> tuple[int | None, str]:
    scores = [_score_int(s.get("score")) for s in sides]
    if len(scores) == 2 and scores[0] is not None and scores[1] is not None:
        if scores[0] > scores[1]:
            return 0, "score"
        if scores[1] > scores[0]:
            return 1, "score"
    winning = [i for i, s in enumerate(sides) if s.get("winning")]
    if len(winning) == 1:
        return winning[0], "flag"
    if games:
        a = b = 0
        for left, right in games:
            lv, rv = _score_int(left), _score_int(right)
            if lv is None or rv is None:
                continue
            if lv > rv:
                a += 1
            elif rv > lv:
                b += 1
        if a > b:
            return 0, "games"
        if b > a:
            return 1, "games"
    return None, "none"


def build_records(
    cards: list[dict],
    owner: str,
    league_url: str,
    league_name: str | None = None,
) -> tuple[list[dict], list[dict]]:
    """Normalise raw cards.

    Returns ``(all_records, owner_records)``. ``all_records`` includes every
    card in the DOM; ``owner_records`` keeps only cards containing the owner.
    """
    all_records: list[dict] = []
    owner_records: list[dict] = []
    for card in cards:
        parsed = parse_description(card.get("description", ""))
        status = parse_status(card.get("status_attr", ""), card.get("status_text", ""))
        tables = parse_tables(card.get("tables_text", ""))
        sides = []
        for side in card.get("sides", []):
            aff = parse_affiliation(side.get("affiliation", ""))
            sides.append(
                {
                    **side,
                    "rating": aff["rating"],
                    "state": aff["state"],
                }
            )
        record = {
            "match_id": card.get("match_id"),
            "league_url": league_url,
            "league_name": league_name,
            "description": card.get("description"),
            "date": parsed["date"],
            "event_label": parsed["event_label"],
            "group": parsed["group"],
            "pairing": parsed["pairing"],
            "status": status["status"],
            "status_label": status["status_label"],
            "submitted": status["submitted"],
            "tables": tables["tables"],
            "table_numbers": tables["table_numbers"],
            "players": [
                {
                    "name": s.get("name"),
                    "rating": s.get("rating"),
                    "state": s.get("state"),
                    "score": _score_int(s.get("score")),
                    "entry_id": s.get("entry_id"),
                }
                for s in sides
            ],
            "games": card.get("games", []),
            "set_scores_raw": [f"{g[0]}-{g[1]}" for g in card.get("games", [])],
        }
        winner_index, winner_source = (
            _winner_from_card(sides, card.get("games", []))
            if status["submitted"]
            else (None, "none")
        )
        record["winner_index"] = winner_index
        record["winner_source"] = winner_source
        all_records.append(record)

        owner_index = None
        for index, side in enumerate(sides):
            if name_matches_owner(side.get("name", ""), owner):
                owner_index = index
                break
        if owner_index is None or len(sides) != 2:
            continue
        opp_index = 1 - owner_index
        owner_side, opp_side = sides[owner_index], sides[opp_index]
        owner_score = _score_int(owner_side.get("score")) if status["submitted"] else None
        opp_score = _score_int(opp_side.get("score")) if status["submitted"] else None

        # set scores are rendered side-A first; flip when the owner is side B
        set_scores = []
        if status["submitted"]:
            for left, right in card.get("games", []):
                set_scores.append(f"{left}-{right}" if owner_index == 0 else f"{right}-{left}")
        set_text = ", ".join(set_scores) if set_scores else None

        if winner_index is not None:
            result = "Win" if winner_index == owner_index else "Loss"
            winner_name = sides[winner_index].get("name")
            loser_name = sides[1 - winner_index].get("name")
        else:
            result = None
            winner_name = None
            loser_name = None

        record["owner_side"] = owner_index
        record["owner_name"] = owner_side.get("name")
        record["owner_rating"] = owner_side.get("rating")
        record["owner_state"] = owner_side.get("state")
        record["owner_score"] = owner_score
        record["opponent_score"] = opp_score
        record["result"] = result
        record["winner_name"] = winner_name
        record["loser_name"] = loser_name
        record["opponent_name"] = opp_side.get("name")
        record["opponent_rating"] = opp_side.get("rating")
        record["opponent_state"] = opp_side.get("state")
        record["opponent_entry_id"] = opp_side.get("entry_id")
        record["score_summary"] = (
            f"{owner_score}-{opp_score}"
            if owner_score is not None and opp_score is not None
            else None
        )
        record["set_scores"] = set_text
        record["source"] = SOURCE
        owner_records.append(record)
    return all_records, owner_records


def match_row(record: dict) -> dict:
    """Project a normalised record onto the ``matches`` table columns."""
    return {
        "activity_id": None,
        "date": record.get("date"),
        "winner_name": record.get("winner_name"),
        "loser_name": record.get("loser_name"),
        "opponent_name": record.get("opponent_name"),
        "opponent_usatt_id": None,
        "opponent_rating": record.get("opponent_rating"),
        "score_summary": record.get("score_summary"),
        "result": record.get("result"),
        "source": SOURCE,
        "set_scores": record.get("set_scores"),
    }


def dedupe_key(row: dict) -> tuple:
    """Stable idempotency key for a match row."""
    return (
        squash(row.get("date")),
        squash(row.get("opponent_name")).casefold(),
        squash(row.get("score_summary")),
        squash(row.get("set_scores")),
        squash(row.get("source")),
    )


def _set_pairs(text: str) -> list[tuple[int, int]]:
    return [
        (int(left), int(right))
        for left, right in re.findall(r"(\d+)\s*-\s*(\d+)", squash(text))
    ]


def sets_equivalent(old: str, new: str) -> bool:
    """True when two set-score strings describe the same games.

    The pre-existing rows were stored in *card* order (side A first), so for
    matches where the owner was side B the pairs are reversed relative to the
    owner-first order this scraper now emits. Treat that as the same match.
    """
    old_text, new_text = squash(old), squash(new)
    if old_text == new_text:
        return True
    if not old_text or not new_text:
        return False
    old_pairs, new_pairs = _set_pairs(old_text), _set_pairs(new_text)
    if not old_pairs or len(old_pairs) != len(new_pairs):
        return False
    return all(
        left[0] == right[1] and left[1] == right[0]
        for left, right in zip(old_pairs, new_pairs)
    )


def _legacy_equivalent(existing: dict, incoming: dict) -> bool:
    """True when an existing row is the same match in an older/partial shape.

    The pre-existing 26 ``stadium_league`` rows have ``score_summary = NULL``
    but carry ``set_scores``. A re-scrape now has a score summary as well; that
    is an enrichment of the same match, not a new one.
    """
    if squash(existing.get("date")) != squash(incoming.get("date")):
        return False
    if squash(existing.get("opponent_name")).casefold() != squash(
        incoming.get("opponent_name")
    ).casefold():
        return False
    old_sum = squash(existing.get("score_summary"))
    new_sum = squash(incoming.get("score_summary"))
    old_sets = squash(existing.get("set_scores"))
    new_sets = squash(incoming.get("set_scores"))
    if old_sum and new_sum and old_sum != new_sum:
        return False
    if old_sets and new_sets and not sets_equivalent(old_sets, new_sets):
        return False
    # no conflicting evidence -> same match
    return True


def upsert_rows(conn: sqlite3.Connection, rows: list[dict]) -> dict:
    """Idempotently insert normalised match rows.

    Returns ``{"inserted", "updated", "skipped_duplicates"}``. Running the same
    batch twice inserts nothing the second time.
    """
    _ensure_matches_table(conn)
    stats = {"inserted": 0, "updated": 0, "skipped_duplicates": 0}
    for row in rows:
        key = dedupe_key(row)
        existing_rows = conn.execute(
            "SELECT id, date, opponent_name, score_summary, set_scores, opponent_rating, "
            "result, winner_name, loser_name "
            "FROM matches WHERE source=? AND date IS ? AND opponent_name IS ?",
            (
                row.get("source"),
                row.get("date"),
                row.get("opponent_name"),
            ),
        ).fetchall()
        exact = None
        legacy = None
        for existing in existing_rows:
            current = {
                "id": existing[0],
                "date": existing[1],
                "opponent_name": existing[2],
                "score_summary": existing[3],
                "set_scores": existing[4],
                "opponent_rating": existing[5],
                "result": existing[6],
                "winner_name": existing[7],
                "loser_name": existing[8],
            }
            if dedupe_key(current) == key:
                exact = current
                break
            if legacy is None and _legacy_equivalent(current, row):
                legacy = current
        if exact is not None:
            stats["skipped_duplicates"] += 1
            continue
        if legacy is not None:
            fills = []
            params: list = []
            if not squash(legacy.get("score_summary")) and squash(row.get("score_summary")):
                fills.append("score_summary=?")
                params.append(row.get("score_summary"))
            old_sets = squash(legacy.get("set_scores"))
            new_sets = squash(row.get("set_scores"))
            if new_sets and not old_sets:
                fills.append("set_scores=?")
                params.append(row.get("set_scores"))
            elif (
                old_sets
                and new_sets
                and old_sets != new_sets
                and sets_equivalent(old_sets, new_sets)
            ):
                # same games in legacy card order -> normalise to owner-first
                fills.append("set_scores=?")
                params.append(row.get("set_scores"))
            if legacy.get("opponent_rating") is None and row.get("opponent_rating") is not None:
                fills.append("opponent_rating=?")
                params.append(row.get("opponent_rating"))
            old_result = squash(legacy.get("result"))
            new_result = squash(row.get("result"))
            if new_result and (
                not old_result or old_result in ("W", "L")
            ):
                fills.append("result=?")
                params.append(row.get("result"))
            for column in ("winner_name", "loser_name"):
                if not squash(legacy.get(column)) and squash(row.get(column)):
                    fills.append(f"{column}=?")
                    params.append(row.get(column))
            if fills:
                params.append(legacy["id"])
                conn.execute(f"UPDATE matches SET {', '.join(fills)} WHERE id=?", params)
                stats["updated"] += 1
            else:
                stats["skipped_duplicates"] += 1
            continue
        conn.execute(
            """
            INSERT INTO matches
                (activity_id, date, winner_name, loser_name, opponent_name,
                 opponent_usatt_id, opponent_rating, score_summary, result,
                 source, set_scores)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row.get("activity_id"),
                row.get("date"),
                row.get("winner_name"),
                row.get("loser_name"),
                row.get("opponent_name"),
                row.get("opponent_usatt_id"),
                row.get("opponent_rating"),
                row.get("score_summary"),
                row.get("result"),
                row.get("source"),
                row.get("set_scores"),
            ),
        )
        stats["inserted"] += 1
    conn.commit()
    return stats


# ---------------------------------------------------------------------------
# Playwright extraction (live network)
# ---------------------------------------------------------------------------
CONSENT_BUTTONS = ("Accept", "Accept All", "I Accept", "Decline")
MATCHES_TAB_RE = re.compile(r"^matches$", re.IGNORECASE)


def _base_url(league_url: str) -> str:
    parts = urlsplit(league_url)
    return f"{parts.scheme}://{parts.netloc}"


async def _dismiss_consent(page) -> str | None:
    for frame in page.frames:
        for label in CONSENT_BUTTONS:
            try:
                button = frame.get_by_role("button", name=label, exact=True)
                if await button.count():
                    await button.first.click(timeout=2500)
                    await page.wait_for_timeout(400)
                    return f"clicked {label}"
            except Exception:
                continue
    # The legacy host shows a MUI "table tennis has moved" dialog with only an
    # icon close button; the new host shows a Termly overlay. Try the dialog
    # close button, then strip both overlays so they cannot swallow clicks.
    try:
        close = page.locator(".MuiDialog-root .CloseButton")
        if await close.count():
            await close.first.click(timeout=2500)
            await page.wait_for_timeout(400)
            return "closed MUI dialog"
    except Exception:
        pass
    try:
        await page.evaluate(
            """() => {
                const selectors = [
                    '.termly-styles-module-root',
                    '[id^="termly-"]',
                    '[class*="termly-styles-module"]',
                    '.MuiDialog-root',
                ];
                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach(el => el.remove());
                }
            }"""
        )
        return "removed consent overlay"
    except Exception:
        return None


async def _open_matches_tab(page) -> bool:
    # DOM click first: it cannot be swallowed by the consent overlay.
    try:
        clicked = await page.evaluate(
            """() => {
                const tab = [...document.querySelectorAll('.TabbedView-tab')]
                    .find(el => /^matches$/i.test((el.innerText || '').trim()));
                if (!tab) return false;
                tab.click();
                return true;
            }"""
        )
        if clicked:
            await page.wait_for_timeout(1800)
            return True
    except Exception:
        pass
    candidates = page.locator(".TabbedView-tab")
    count = await candidates.count()
    for index in range(count):
        try:
            text = squash(await candidates.nth(index).inner_text())
        except Exception:
            continue
        if MATCHES_TAB_RE.match(text):
            await candidates.nth(index).click()
            await page.wait_for_timeout(1500)
            return True
    try:
        fallback = page.get_by_text(re.compile(r"^matches$", re.IGNORECASE))
        if await fallback.count():
            await fallback.first.click(timeout=5000)
            await page.wait_for_timeout(1500)
            return True
    except Exception:
        pass
    return False


CARD_SELECTORS = (
    ".TournamentMatchInfo",
    ".MatchCard",
    ".TournamentMatches-card",
)


async def _card_count(page) -> int:
    """Count rendered match cards, tolerating class-name drift between hosts.

    Selectors are tried in order of specificity and the first non-zero result
    wins; broad `[class*=...]` matches are deliberately avoided because they
    inflate the count with sub-elements and break the settle detection.
    """
    for selector in CARD_SELECTORS:
        try:
            count = await page.locator(selector).count()
        except Exception:
            continue
        if count:
            return count
    try:
        return len(extract_cards_from_html(await page.content()))
    except Exception:
        return 0


async def _wait_for_cards(page, attempts: int = 10, delay_ms: int = 800) -> int:
    """Wait until the MATCHES tab has actually rendered cards.

    The SPA renders this tab lazily, and reading the DOM too early made the
    result non-deterministic (0 cards on one run, 30 on the next). Re-clicking
    the tab midway also recovers a swallowed click.
    """
    for attempt in range(attempts):
        count = await _card_count(page)
        if count:
            return count
        if attempt == attempts // 2:
            try:
                await _open_matches_tab(page)
            except Exception:
                pass
        await page.wait_for_timeout(delay_ms)
    return 0


async def _wait_for_growth(page, previous: int, timeout_ms: int = 15000) -> int:
    """Wait for the rendered card count to grow past `previous`."""
    deadline = time.monotonic() + timeout_ms / 1000
    count = previous
    while time.monotonic() < deadline:
        await page.wait_for_timeout(400)
        count = await _card_count(page)
        if count > previous:
            return count
    return count


async def _load_more(
    page,
    max_rounds: int = 200,
    settle_ms: int = 1200,
    max_seconds: float = 240.0,
) -> int:
    """Click "Load More" until the control disappears or becomes disabled.

    Termination is driven by the BUTTON's state, not by a card-count settle
    heuristic. A slow lazy append can leave the count unchanged for several
    seconds, and an earlier "count unchanged twice" rule then stopped early —
    960 cards on one run vs 1,410 on the next, from identical input. The card
    count is now only a progress signal; the button decides when we are done.
    """
    clicks = 0
    failures = 0
    last_count = await _card_count(page)
    started = time.monotonic()
    while clicks < max_rounds:
        if time.monotonic() - started > max_seconds:
            break
        button = page.get_by_role("button", name=re.compile(r"load more", re.IGNORECASE))
        if not await button.count():
            break
        target = button.first
        try:
            if not await target.is_visible():
                break
            if await target.is_disabled():
                break
            if str(await target.get_attribute("aria-disabled")).lower() == "true":
                break
            await target.scroll_into_view_if_needed()
            await target.click(timeout=2500)
        except Exception:
            # A single transient failure (overlay, detached node) must not
            # truncate the league — retry a few times before giving up.
            failures += 1
            if failures >= 3:
                break
            await page.wait_for_timeout(600)
            continue
        clicks += 1
        failures = 0
        last_count = await _wait_for_growth(page, last_count)
        await page.wait_for_timeout(settle_ms)
    return clicks


async def _load_more_exhausted(page) -> bool:
    """True when a Load More control is still present and clickable.

    Used as the *completion* signal for one segment: if the button is still
    enabled after a pass, that segment was cut short (usually the wall-clock
    budget) and must be retried rather than reported as complete.
    """
    button = page.get_by_role("button", name=re.compile(r"load more", re.IGNORECASE))
    try:
        if not await button.count():
            return False
        target = button.first
        if not await target.is_visible():
            return False
        if await target.is_disabled():
            return False
        return str(await target.get_attribute("aria-disabled")).lower() != "true"
    except Exception:
        return False


async def _click_show_all(page) -> bool:
    """Clear the site's own filters when scraping every match."""
    try:
        button = page.get_by_role("button", name=re.compile(r"^show all$", re.IGNORECASE))
        if await button.count():
            await button.first.click(timeout=5000)
            await page.wait_for_timeout(1200)
            return True
    except Exception:
        pass
    return False


async def _clear_filters(page) -> int:
    """Clear every active MUI filter chip so all segments are reachable."""
    cleared = 0
    for _ in range(8):
        chips = page.locator(".ClearableValue-clear")
        if not await chips.count():
            break
        try:
            await chips.first.click(timeout=3000)
            cleared += 1
            await page.wait_for_timeout(500)
        except Exception:
            break
    return cleared


async def _select_by_label(page, label: str) -> bool:
    selects = page.locator(".TournamentMatches-filters .MuiSelect-select")
    for index in range(await selects.count()):
        try:
            if squash(await selects.nth(index).inner_text()).casefold() == label.casefold():
                await selects.nth(index).click(timeout=5000)
                await page.wait_for_timeout(700)
                return True
        except Exception:
            continue
    return False


async def _option_values(page) -> list[str]:
    options = page.get_by_role("option")
    values = []
    for index in range(await options.count()):
        try:
            values.append(squash(await options.nth(index).inner_text()))
        except Exception:
            continue
    return values


async def _choose_option(page, value: str) -> bool:
    options = page.get_by_role("option")
    for index in range(await options.count()):
        try:
            if squash(await options.nth(index).inner_text()) == value:
                await options.nth(index).click(timeout=5000)
                await page.wait_for_timeout(1400)
                return True
        except Exception:
            continue
    return False


async def _segment_values(page, label: str) -> list[str]:
    if not await _select_by_label(page, label):
        return []
    values = await _option_values(page)
    await page.keyboard.press("Escape")
    await page.wait_for_timeout(300)
    return [v for v in values if v and v.casefold() != label.casefold()]


async def _apply_segment(page, label: str, value: str) -> bool:
    await _clear_filters(page)
    if not await _select_by_label(page, label):
        return False
    return await _choose_option(page, value)


async def _enumerate_segments(
    page,
    label: str,
    owner: str,
    *,
    max_load_more: int = 200,
    collect_cards: bool = False,
    league_url: str = "",
) -> tuple[dict, list[dict]]:
    """Walk every value of one MUI filter and record a per-segment card count.

    Returns ``(report, cards)``. ``cards`` is the de-duplicated union of parsed
    cards when ``collect_cards`` is set; otherwise it is empty. This is the
    completeness path for pages without "Load More" (the legacy host caps the
    bare list at 30 cards).
    """
    values = await _segment_values(page, label)
    merged: dict[str, dict] = {}
    union_ids: set[str] = set()
    report = {
        "filter": label,
        "segments": [],
        "union_count": 0,
        "sum_counts": 0,
    }
    for value in values:
        cards: list[dict] = []
        clicks = 0
        truncated = False
        applied = False
        # A segment is small (45-180 cards), so retrying the whole segment is
        # cheap and turns a transient hiccup into a correct result.
        for _ in range(3):
            if not await _apply_segment(page, label, value):
                break
            applied = True
            clicks += await _load_more(page, max_rounds=max_load_more)
            truncated = await _load_more_exhausted(page)
            cards = extract_cards_from_html(await page.content())
            if not truncated:
                break
            await page.wait_for_timeout(700)
        if not applied:
            report["segments"].append(
                {"value": value, "count": 0, "error": "filter value could not be applied"}
            )
            continue
        segment_ids = {card["match_id"] for card in cards if card.get("match_id")}
        union_ids.update(segment_ids)
        if collect_cards and cards:
            _, owner_cards = build_records(cards, owner, league_url)
            expand_ids = [
                record["match_id"]
                for record in owner_cards
                if record.get("match_id") and record.get("submitted")
            ]
            if expand_ids:
                await _expand_cards(page, expand_ids)
                cards = extract_cards_from_html(await page.content())
            for card in cards:
                if card.get("match_id"):
                    merged[card["match_id"]] = card
        entry = {"value": value, "count": len(cards), "load_more_clicks": clicks}
        if truncated:
            entry["truncated"] = True
        report["segments"].append(entry)
    report["truncated_segments"] = [
        segment["value"] for segment in report["segments"] if segment.get("truncated")
    ]
    await _clear_filters(page)
    report["union_count"] = len(merged) if collect_cards else len(union_ids)
    report["sum_counts"] = sum(segment.get("count", 0) for segment in report["segments"])
    return report, list(merged.values())


async def _owner_entry_id(page, owner: str) -> str | None:
    """Look the owner up in the tournament's PLAYERS tab."""
    tabs = page.locator(".TabbedView-tab")
    for index in range(await tabs.count()):
        try:
            if squash(await tabs.nth(index).inner_text()).casefold() == "players":
                await tabs.nth(index).click()
                await page.wait_for_timeout(2500)
                break
        except Exception:
            continue
    try:
        entries = await page.locator(".Entry").evaluate_all(
            """els => els.map(e => ({
                id: e.dataset.entryId || null,
                name: (e.querySelector('.Entry-name') || {}).innerText || '',
            }))"""
        )
    except Exception:
        return None
    for entry in entries:
        if entry.get("id") and name_matches_owner(entry.get("name", ""), owner):
            return entry["id"]
    return None


async def _expand_cards(page, match_ids: list[str], settle_ms: int = 350) -> int:
    expanded = 0
    for match_id in match_ids:
        try:
            clicked = await page.evaluate(
                """(id) => {
                    const info = [...document.querySelectorAll('.TournamentMatchInfo')]
                        .find(el => el.dataset.id === id);
                    if (!info) return false;
                    const card = info.closest('.MatchCard');
                    if (!card) return false;
                    if (card.getAttribute('data-expanded') === 'true') return true;
                    const toggle = card.querySelector('.MatchCard-toggle');
                    (toggle || card).click();
                    return true;
                }""",
                match_id,
            )
        except Exception:
            clicked = False
        if clicked:
            expanded += 1
            await page.wait_for_timeout(settle_ms)
    return expanded


async def scrape_league(
    league_url: str,
    owner: str,
    *,
    headless: bool = True,
    channel: str | None = None,
    max_load_more: int = 200,
    all_matches: bool = False,
    segments: bool = False,
    timeout_ms: int = 60000,
    include_unsubmitted: bool = True,
) -> dict:
    """Scrape one public league/tournament URL. Returns a per-league summary."""
    from playwright.async_api import async_playwright

    result: dict = {
        "league_url": league_url,
        "league_name": None,
        "player_filtered": False,
        "owner_entry_id": None,
        "cards_seen": 0,
        "matches_seen": 0,
        "owner_matches": 0,
        "expanded": 0,
        "load_more_clicks": 0,
        "mode": None,
        "pagination_available": None,
        "pagination_count": None,
        "segments": [],
        "errors": [],
        "records": [],
        "all_records": [],
    }
    async with async_playwright() as pw:
        launch_kwargs = {
            "headless": headless,
            "args": ["--no-sandbox", "--disable-dev-shm-usage"],
        }
        if channel:
            launch_kwargs["channel"] = channel
        browser = await pw.chromium.launch(**launch_kwargs)
        context = await browser.new_context(viewport={"width": 1400, "height": 1000})
        page = await context.new_page()
        try:
            await page.goto(league_url, wait_until="domcontentloaded", timeout=timeout_ms)
            await page.wait_for_timeout(5000)
            result["consent"] = await _dismiss_consent(page)

            if not all_matches:
                entry_id = await _owner_entry_id(page, owner)
                result["owner_entry_id"] = entry_id
                if entry_id:
                    filtered_url = (
                        f"{_base_url(league_url)}{urlsplit(league_url).path}"
                        f"?filter:playerId={entry_id}#matches"
                    )
                    await page.goto(
                        filtered_url, wait_until="domcontentloaded", timeout=timeout_ms
                    )
                    await page.wait_for_timeout(5000)
                    await _dismiss_consent(page)
                    result["player_filtered"] = True

            await _open_matches_tab(page)
            await _wait_for_cards(page)
            if all_matches:
                await _click_show_all(page)
                await _wait_for_cards(page)

            has_load_more = (
                await page.get_by_role(
                    "button", name=re.compile(r"load more", re.IGNORECASE)
                ).count()
                > 0
            )
            result["pagination_available"] = has_load_more

            cards: list[dict] = []
            event_values = await _segment_values(page, "Event")
            if len(event_values) >= 2:
                # Segment-first: the filter is the pagination unit, so the huge
                # lazy list never has to "settle". Deterministic and bounded —
                # termination depends on visiting every value, not on the DOM
                # happening to be quiet at the right moment.
                result["mode"] = "segments"
                report, cards = await _enumerate_segments(
                    page,
                    "Event",
                    owner,
                    max_load_more=max_load_more,
                    collect_cards=True,
                    league_url=league_url,
                )
                result["segments"].append(report)
                result["truncated"] = bool(report.get("truncated_segments"))
                if segments:
                    week_report, _ = await _enumerate_segments(
                        page,
                        "Week",
                        owner,
                        max_load_more=max_load_more,
                        collect_cards=False,
                        league_url=league_url,
                    )
                    result["segments"].append(week_report)
                    result["completeness"] = {
                        "event_union": report["union_count"],
                        "week_union": week_report["union_count"],
                        "agree": report["union_count"] == week_report["union_count"],
                    }
                if not cards:
                    week_report, cards = await _enumerate_segments(
                        page,
                        "Week",
                        owner,
                        max_load_more=max_load_more,
                        collect_cards=True,
                        league_url=league_url,
                    )
                    result["segments"].append(week_report)
            elif not has_load_more:
                # Legacy bare list (and any page without Load More) caps at 30.
                # Union every Event value; fall back to Week if Event is empty.
                result["mode"] = "segments"
                report, cards = await _enumerate_segments(
                    page,
                    "Event",
                    owner,
                    max_load_more=max_load_more,
                    collect_cards=True,
                    league_url=league_url,
                )
                result["segments"].append(report)
                if not cards:
                    report, cards = await _enumerate_segments(
                        page,
                        "Week",
                        owner,
                        max_load_more=max_load_more,
                        collect_cards=True,
                        league_url=league_url,
                    )
                    result["segments"].append(report)
                if segments and cards:
                    report, _ = await _enumerate_segments(
                        page,
                        "Week",
                        owner,
                        max_load_more=max_load_more,
                        collect_cards=False,
                        league_url=league_url,
                    )
                    result["segments"].append(report)
            else:
                result["mode"] = "pagination"
                result["load_more_clicks"] = await _load_more(
                    page, max_rounds=max_load_more
                )
                cards = extract_cards_from_html(await page.content())
                result["pagination_count"] = len(
                    {card["match_id"] for card in cards if card.get("match_id")}
                )
                if segments:
                    for label in ("Event", "Week"):
                        report, _ = await _enumerate_segments(
                            page,
                            label,
                            owner,
                            max_load_more=max_load_more,
                            collect_cards=False,
                            league_url=league_url,
                        )
                        result["segments"].append(report)

            if not cards:
                result["errors"].append(
                    "No match cards rendered: the MATCHES tab never loaded. "
                    "Treat this league as unread, not as empty."
                )

            result["cards_seen"] = len(cards)

            all_records, owner_records = build_records(cards, owner, league_url)
            # expand every submitted owner card to capture game scores
            ids = [
                record["match_id"]
                for record in owner_records
                if record.get("match_id") and record.get("submitted")
            ]
            if ids:
                result["expanded"] = await _expand_cards(page, ids)
                if result["mode"] == "pagination":
                    html = await page.content()
                    cards = extract_cards_from_html(html)
                    result["cards_seen"] = len(cards)
                    all_records, owner_records = build_records(
                        cards, owner, league_url
                    )

            result["matches_seen"] = len(all_records)
            result["owner_matches"] = len(owner_records)
            result["all_records"] = all_records
            records = owner_records
            if not include_unsubmitted:
                records = [r for r in records if r.get("submitted")]
                result["owner_matches"] = len(records)
            result["records"] = records
            titles = await page.title()
            result["league_name"] = titles if titles and titles != "STADIUM" else None
        except Exception as exc:  # keep one bad league from sinking the whole run
            result["errors"].append(f"{type(exc).__name__}: {exc}")
        finally:
            await browser.close()
    return result


async def scrape_leagues(
    league_urls: list[str],
    owner: str,
    *,
    headless: bool = True,
    channel: str | None = None,
    max_load_more: int = 200,
    all_matches: bool = False,
    segments: bool = False,
    include_unsubmitted: bool = True,
) -> dict:
    leagues = []
    for url in league_urls:
        leagues.append(
            await scrape_league(
                url,
                owner,
                headless=headless,
                channel=channel,
                max_load_more=max_load_more,
                all_matches=all_matches,
                segments=segments,
                include_unsubmitted=include_unsubmitted,
            )
        )
    return {"owner": owner, "leagues": leagues}


# ---------------------------------------------------------------------------
# Persistence + CLI
# ---------------------------------------------------------------------------
def save_summary(run: dict, db_path: str) -> dict:
    """Persist every owner record and fold per-league insert stats in."""
    rows: list[dict] = []
    for league in run["leagues"]:
        for record in league.get("records", []):
            rows.append(match_row(record))
    summary = {
        "owner": run.get("owner"),
        "db": db_path,
        "leagues": [],
        "matches_seen": 0,
        "owner_matches": 0,
        "inserted": 0,
        "updated": 0,
        "skipped_duplicates": 0,
        "errors": [],
    }
    conn = sqlite3.connect(db_path)
    try:
        stats = upsert_rows(conn, rows)
    finally:
        conn.close()
    for league in run["leagues"]:
        summary["leagues"].append(
            {
                "league_url": league.get("league_url"),
                "league_name": league.get("league_name"),
                "player_filtered": league.get("player_filtered"),
                "cards_seen": league.get("cards_seen", 0),
                "matches_seen": league.get("matches_seen", 0),
                "owner_matches": len(league.get("records", [])),
                "load_more_clicks": league.get("load_more_clicks", 0),
                "mode": league.get("mode"),
                "truncated": league.get("truncated"),
                "completeness": league.get("completeness"),
                "segments": league.get("segments", []),
                "expanded": league.get("expanded", 0),
                "mode": league.get("mode"),
                "pagination_available": league.get("pagination_available"),
                "pagination_count": league.get("pagination_count"),
                "segments": league.get("segments", []),
                "errors": league.get("errors", []),
            }
        )
        summary["matches_seen"] += league.get("matches_seen", 0)
        summary["owner_matches"] += len(league.get("records", []))
        summary["errors"].extend(league.get("errors", []))
    summary["inserted"] = stats["inserted"]
    summary["updated"] = stats["updated"]
    summary["skipped_duplicates"] = stats["skipped_duplicates"]
    summary["success"] = not summary["errors"]
    return summary


def _legacy_fallback(urls: list[str], owner: str | None) -> int:
    """Optional credential path for the legacy stadiumcompete site."""
    try:
        from backend.stadium_league_scraper import scrape_league_matches
    except Exception:
        try:
            from stadium_league_scraper import scrape_league_matches
        except Exception as exc:  # pragma: no cover - legacy only
            print(f"Legacy scraper unavailable: {exc}", file=sys.stderr)
            return 1
    for url in urls:
        asyncio.run(scrape_league_matches(url, player_name=owner))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--league-url",
        action="append",
        default=[],
        help="Public stadiumtt.com tournament/league URL (repeatable). "
        "Also read from STADIUMTT_LEAGUE_URLS.",
    )
    parser.add_argument(
        "--owner",
        default=None,
        help="Owner player name (e.g. 'Last, First'). "
        "Defaults to STADIUMTT_OWNER / OMNIPONG_OWNER / users table.",
    )
    parser.add_argument("--db", default=None, help="SQLite DB path (default: OMNIPONG_DB).")
    parser.add_argument("--headed", action="store_true", help="Show the browser (debug).")
    parser.add_argument(
        "--channel",
        default=os.environ.get("STADIUMTT_BROWSER_CHANNEL") or None,
        help="Playwright browser channel override (e.g. chrome).",
    )
    parser.add_argument(
        "--max-load-more", type=int, default=200, help="Maximum Load More clicks per league."
    )
    parser.add_argument(
        "--all-matches",
        action="store_true",
        help="Do not use the site's player filter; scrape every card then filter locally.",
    )
    parser.add_argument(
        "--segments",
        action="store_true",
        help="Enumerate every Event and Week filter value and report per-segment "
        "card counts (completeness cross-check).",
    )
    parser.add_argument(
        "--submitted-only",
        action="store_true",
        help="Persist only matches with a reported result.",
    )
    parser.add_argument(
        "--legacy-login",
        action="store_true",
        help="Use the optional credential-based legacy stadiumcompete scraper.",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument("--dry-run", action="store_true", help="Scrape but do not write DB.")
    return parser


def _print_summary(summary: dict, as_json: bool) -> None:
    payload = json.dumps(_jsonable(summary), ensure_ascii=False)
    if as_json:
        print(f"STADIUMTT_JSON:{payload}")
    else:
        print(json.dumps(_jsonable(summary), indent=2, ensure_ascii=False))


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        urls = parse_league_urls(args.league_url)
    except ValueError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2
    db_path = args.db or default_db_path()
    owner = resolve_owner(args.owner, db_path=db_path)

    if args.legacy_login:
        if not urls:
            print(
                "No league URL configured. Set STADIUMTT_LEAGUE_URLS or pass --league-url.",
                file=sys.stderr,
            )
            return 2
        return _legacy_fallback(urls, owner)

    if not urls:
        message = (
            "No league URL configured. Set STADIUMTT_LEAGUE_URLS to a public "
            "stadiumtt.com tournament/league URL (comma-separated), or pass "
            "--league-url. Refusing to guess a league."
        )
        _print_summary(
            {"success": False, "errors": [message], "leagues": [], "owner": owner},
            args.json,
        )
        print(message, file=sys.stderr)
        return 2
    if not owner:
        message = (
            "No owner player name resolved. Pass --owner, set STADIUMTT_OWNER, "
            "or add a row to the users table."
        )
        _print_summary(
            {"success": False, "errors": [message], "leagues": []}, args.json
        )
        print(message, file=sys.stderr)
        return 2

    if not args.json:
        print(f"Owner: {owner}")
        print(f"Leagues: {len(urls)}")
    run = asyncio.run(
        scrape_leagues(
            urls,
            owner,
            headless=not args.headed,
            channel=args.channel,
            max_load_more=args.max_load_more,
            all_matches=args.all_matches,
            segments=args.segments,
            include_unsubmitted=not args.submitted_only,
        )
    )
    if args.dry_run:
        summary = {
            "owner": owner,
            "db": db_path,
            "dry_run": True,
            "leagues": [
                {
                    "league_url": league["league_url"],
                    "matches_seen": league.get("matches_seen", 0),
                    "owner_matches": len(league.get("records", [])),
                    "mode": league.get("mode"),
                    "pagination_count": league.get("pagination_count"),
                    "segments": league.get("segments", []),
                    "errors": league.get("errors", []),
                }
                for league in run["leagues"]
            ],
            "inserted": 0,
            "updated": 0,
            "skipped_duplicates": 0,
            "errors": [e for league in run["leagues"] for e in league.get("errors", [])],
        }
        summary["success"] = not summary["errors"]
        _print_summary(summary, args.json)
        return 0 if summary["success"] else 1

    summary = save_summary(run, db_path)
    _print_summary(summary, args.json)
    for league in summary["leagues"]:
        for error in league.get("errors", []):
            print(f"League error ({league['league_url']}): {error}", file=sys.stderr)
    return 0 if summary["success"] else 1


def _jsonable(value):
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, date):
        return value.isoformat()
    return value


if __name__ == "__main__":
    raise SystemExit(main())
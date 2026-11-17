"""Offline tests for the public STADIUM (stadiumtt.com) league scraper.

No network and no Playwright browser is launched here: the DOM fixture was
saved from a live MATCHES tab (one win, one loss, one unsubmitted card) and all
normalisation/dedupe logic is exercised against it.
"""
import os
import sqlite3

import pytest

import stadiumtt_scraper as s

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "stadiumtt_matches.html")
LEGACY_FIXTURE = os.path.join(
    os.path.dirname(__file__), "fixtures", "stadiumtt_legacy_2025.html"
)
OWNER = "Johnson, Justin"


@pytest.fixture(scope="module")
def cards():
    with open(FIXTURE, encoding="utf-8") as handle:
        return s.extract_cards_from_html(handle.read())


@pytest.fixture(scope="module")
def records(cards):
    _, owner_records = s.build_records(
        cards, OWNER, "https://example.test/tournament/fixture"
    )
    return owner_records


def _by_opponent(records, fragment):
    for record in records:
        if fragment in (record.get("opponent_name") or ""):
            return record
    raise AssertionError(f"no record for opponent {fragment!r}")


# ---------------------------------------------------------------------------
# DOM extraction
# ---------------------------------------------------------------------------
def test_fixture_parses_every_card(cards):
    assert len(cards) == 3
    assert all(card["match_id"] for card in cards)
    statuses = {card["status_attr"] for card in cards}
    assert statuses == {"submitted-unverified", "certified", "unsubmitted"}


def test_description_date_group_and_pairing(cards):
    parsed = s.parse_description(cards[0]["description"])
    assert parsed == {
        "date": "2026-08-26",
        "event_label": "Round Robin",
        "group": "Group 3",
        "pairing": "C vs. F",
    }


def test_live_site_month_typo_is_tolerated():
    parsed = s.parse_description("Octobor 11, 2026 Round Robin • Group 1 (O vs. W)")
    assert parsed["date"] == "2026-10-11"
    assert parsed["group"] == "Group 1"


def test_card_players_ratings_and_state(cards):
    win = cards[0]
    names = [side["name"] for side in win["sides"]]
    assert names == ["Boy, Andrew", "Johnson, Justin"]
    assert [side["score"] for side in win["sides"]] == ["2", "3"]
    assert s.parse_affiliation(win["sides"][1]["affiliation"])["rating"] == 1353
    assert s.parse_affiliation(win["sides"][1]["affiliation"])["state"] == "OR"


def test_tables_are_parsed(cards):
    assert s.parse_tables(cards[0]["tables_text"])["table_numbers"] == ["1", "2", "3"]
    assert s.parse_tables("No Table") == {"tables": None, "table_numbers": []}


# ---------------------------------------------------------------------------
# Winner / loser / score normalisation (owner perspective)
# ---------------------------------------------------------------------------
def test_win_is_normalised_from_owner_perspective(records):
    win = _by_opponent(records, "Boy")
    assert win["owner_name"] == "Johnson, Justin"
    assert win["owner_side"] == 1
    assert win["result"] == "Win"
    assert win["winner_name"] == "Johnson, Justin"
    assert win["loser_name"] == "Boy, Andrew"
    assert win["score_summary"] == "3-2"
    # game scores are rendered side-A first; owner is side B so they are flipped
    assert win["set_scores"] == "14-12, 11-8, 6-11, 6-11, 11-7"
    assert win["opponent_rating"] == 1450
    assert win["opponent_state"] == "TX"
    assert win["tables"] == "1, 2, & 3"
    assert win["status"] == "submitted-unverified"
    assert win["submitted"] is True


def test_loss_is_normalised_from_owner_perspective(records):
    loss = _by_opponent(records, "Wang")
    assert loss["owner_side"] == 0
    assert loss["result"] == "Loss"
    assert loss["winner_name"] == "Wang, Leo"
    assert loss["loser_name"] == "Johnson, Justin"
    assert loss["score_summary"] == "0-3"
    assert loss["set_scores"] == "5-11, 9-11, 9-11"
    # "certified" is a submitted result even though it has no "submitted" prefix
    assert loss["status"] == "certified"
    assert loss["submitted"] is True


def test_unsubmitted_match_is_recorded_gracefully(records):
    pending = _by_opponent(records, "Chen")
    assert pending["submitted"] is False
    assert pending["result"] is None
    assert pending["winner_name"] is None
    assert pending["score_summary"] is None
    assert pending["set_scores"] is None
    assert pending["opponent_name"] == "Chen, Vincent"
    assert pending["opponent_rating"] == 1736


def test_owner_filter_drops_other_players_matches(cards):
    _, records = s.build_records(
        cards, "Someone Else", "https://example.test/tournament/fixture"
    )
    assert records == []


# ---------------------------------------------------------------------------
# Legacy 2025 fixture (state-only affiliations, reversed legacy set order)
# ---------------------------------------------------------------------------
def test_legacy_fixture_normalises_state_and_sets():
    with open(LEGACY_FIXTURE, encoding="utf-8") as handle:
        legacy_cards = s.extract_cards_from_html(handle.read())
    assert len(legacy_cards) == 2
    _, legacy_records = s.build_records(
        legacy_cards, OWNER, "https://example.test/tournament/legacy"
    )
    win = _by_opponent(legacy_records, "Xian")
    assert win["date"] == "2025-12-31"
    assert win["result"] == "Loss"
    assert win["score_summary"] == "0-3"
    assert win["owner_rating"] == 1229
    assert win["owner_state"] == "OR"
    assert win["opponent_rating"] == 1979
    assert win["opponent_state"] == "TX"
    assert win["set_scores"] == "3-11, 3-11, 10-12"
    pending = _by_opponent(legacy_records, "Kazemi")
    assert pending["submitted"] is False
    assert pending["result"] is None


def test_affiliation_handles_bare_state_and_no_affiliation():
    assert s.parse_affiliation("1229•OR") == {
        "rating": 1229,
        "state": "OR",
        "affiliation": "1229•OR",
    }
    assert s.parse_affiliation("NO AFFILIATION")["state"] is None
    assert s.parse_affiliation("1094 • TX (USA)")["state"] == "TX"
    assert s.parse_affiliation("AUSTIN (USA)")["state"] == "AUSTIN"
    assert (
        s.parse_affiliation("AUSTIN TABLE TENNIS CLUB • AUSTIN (USA)")["state"]
        == "AUSTIN"
    )


def test_description_without_space_after_comma_parses():
    parsed = s.parse_description("December 31,2025 Round Robin • Group 1 (A vs. M)")
    assert parsed["date"] == "2025-12-31"
    assert parsed["group"] == "Group 1"


def test_sets_equivalent_accepts_reversed_pairs():
    owner_first = "3-11, 3-11, 10-12"
    legacy_card_order = "11-3, 11-3, 12-10"
    assert s.sets_equivalent(owner_first, legacy_card_order)
    assert s.sets_equivalent(owner_first, owner_first)
    assert not s.sets_equivalent(owner_first, "11-3, 11-3, 10-12")


# ---------------------------------------------------------------------------
# Name handling
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "candidate",
    [
        "Johnson, Justin",
        "Justin Johnson",
        "johnson,  justin",
        "JOHNSON, JUSTIN.",
    ],
)
def test_owner_name_variants_match(candidate):
    assert s.name_matches_owner(candidate, "Johnson, Justin")


def test_similar_names_do_not_match():
    assert not s.name_matches_owner("Johnson, Charlie", "Johnson, Justin")
    assert not s.name_matches_owner("Johnson, Michel", "Johnson, Justin")
    assert not s.name_matches_owner("", "Johnson, Justin")


def test_accented_and_spaced_names_normalise():
    assert s.name_matches_owner(
        "Shaheen-Vélez , Bahjat", "Shaheen-Velez, Bahjat"
    )


def test_to_last_first_derives_from_users_table_shape():
    assert s.to_last_first("Justin Johnson") == "Johnson, Justin"
    assert s.to_last_first("Johnson, Justin") == "Johnson, Justin"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
def test_league_urls_merge_env_and_cli():
    env = {"STADIUMTT_LEAGUE_URLS": "https://a.test/tournament/1, https://b.test/tournament/2"}
    urls = s.parse_league_urls([], env=env)
    assert urls == ["https://a.test/tournament/1", "https://b.test/tournament/2"]
    merged = s.parse_league_urls(["https://c.test/tournament/3"], env=env)
    assert merged[-1] == "https://c.test/tournament/3"
    # de-duplicates
    assert s.parse_league_urls(["https://a.test/tournament/1"], env=env) == urls


def test_league_urls_default_to_empty():
    assert s.parse_league_urls([], env={}) == []


def test_invalid_league_url_rejected():
    with pytest.raises(ValueError):
        s.parse_league_urls(["not-a-url"], env={})


def test_owner_resolution_prefers_explicit_then_env():
    assert s.resolve_owner("Explicit Name", env={"STADIUMTT_OWNER": "Env Name"}) == "Explicit Name"
    assert s.resolve_owner(None, env={"STADIUMTT_OWNER": "Env Name"}) == "Env Name"


def test_owner_resolution_from_users_table(tmp_path):
    db = tmp_path / "t.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)")
    conn.execute("INSERT INTO users (name) VALUES ('Justin Johnson')")
    conn.commit()
    conn.close()
    assert s.resolve_owner(None, db_path=str(db), env={}) == "Johnson, Justin"


def test_module_has_no_hardcoded_league_url_or_owner():
    source = open(s.__file__, encoding="utf-8").read()
    assert "https://stadiumtt.com/tournament/" not in source
    assert "https://stadiumcompete.com/tournament" not in source
    assert "Johnson, Justin" not in source


# ---------------------------------------------------------------------------
# Dedupe
# ---------------------------------------------------------------------------
def _db():
    conn = sqlite3.connect(":memory:")
    s._ensure_matches_table(conn)
    return conn


def test_upsert_is_idempotent_on_second_run(records):
    conn = _db()
    rows = [s.match_row(record) for record in records]

    first = s.upsert_rows(conn, rows)
    assert first["inserted"] == 3
    assert first["updated"] == 0
    count_after_first = conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
    assert count_after_first == 3

    second = s.upsert_rows(conn, rows)
    assert second == {"inserted": 0, "updated": 0, "skipped_duplicates": 3}
    assert conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0] == 3
    conn.close()


def test_upsert_key_ignores_player_side_and_is_stable():
    row = {
        "date": "2026-08-26",
        "opponent_name": "Boy, Andrew",
        "score_summary": "3-2",
        "set_scores": "14-12, 11-8, 6-11, 6-11, 11-7",
        "source": s.SOURCE,
    }
    assert s.dedupe_key(row) == s.dedupe_key(dict(row))


def test_legacy_null_score_summary_row_is_enriched_not_duplicated(records):
    win = _by_opponent(records, "Boy")
    row = s.match_row(win)
    conn = _db()
    # Simulate the pre-existing shape: set scores known, no score summary.
    conn.execute(
        "INSERT INTO matches (date, opponent_name, opponent_rating, score_summary, "
        "result, source, set_scores) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        (row["date"], row["opponent_name"], row["opponent_rating"], row["result"],
         s.SOURCE, row["set_scores"]),
    )
    conn.commit()
    stats = s.upsert_rows(conn, [row])
    assert stats == {"inserted": 0, "updated": 1, "skipped_duplicates": 0}
    count, summary = conn.execute(
        "SELECT COUNT(*), MAX(score_summary) FROM matches"
    ).fetchone()
    assert count == 1
    assert summary == "3-2"
    conn.close()


def test_reversed_legacy_set_order_is_same_match():
    """The 26 pre-existing rows mix card-order set scores; they must not duplicate."""
    conn = _db()
    conn.execute(
        "INSERT INTO matches (date, opponent_name, opponent_rating, score_summary, "
        "result, source, set_scores) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        (
            "2025-12-31",
            "Xian, Alan",
            1979,
            "Loss",
            s.SOURCE,
            "11-3, 11-3, 12-10",  # legacy card order (opponent first)
        ),
    )
    conn.commit()
    incoming = {
        "date": "2025-12-31",
        "opponent_name": "Xian, Alan",
        "opponent_rating": 1979,
        "score_summary": "0-3",
        "result": "Loss",
        "source": s.SOURCE,
        "set_scores": "3-11, 3-11, 10-12",  # owner-first normalisation
    }
    first = s.upsert_rows(conn, [incoming])
    assert first == {"inserted": 0, "updated": 1, "skipped_duplicates": 0}
    sets = conn.execute("SELECT set_scores FROM matches").fetchone()[0]
    assert sets == "3-11, 3-11, 10-12"  # normalised to owner-first
    second = s.upsert_rows(conn, [incoming])
    assert second == {"inserted": 0, "updated": 0, "skipped_duplicates": 1}
    assert conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0] == 1
    conn.close()


def test_same_day_rematch_with_different_scores_is_kept():
    conn = _db()
    base = {
        "date": "2026-08-26",
        "opponent_name": "Boy, Andrew",
        "opponent_rating": 1450,
        "result": "Win",
        "source": s.SOURCE,
        "set_scores": "11-5, 11-7, 11-9",
        "score_summary": "3-0",
    }
    other = dict(base, score_summary="3-1", set_scores="11-5, 9-11, 11-7, 11-9")
    s.upsert_rows(conn, [base])
    stats = s.upsert_rows(conn, [base, other])
    assert stats["inserted"] == 1
    assert conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0] == 2
    conn.close()
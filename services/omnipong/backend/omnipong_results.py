"""Public OmniPong tournament-results reader (no login, no browser).

OmniPong serves event draws/results as server-rendered ASP tables at
``T-tourney.asp?t=<tid>&r=<eid>``. That page is public for most tournaments:
a plain HTTP GET with a normal desktop User-Agent is enough, so this module
deliberately does not touch Playwright or any browser session.

The results table has five columns::

    Event | First Place | Second Place | Third Place | Third/Fourth Place

but the table is also used for grouping. A row that carries no placements is a
heading, and its meaning depends on where the text sits:

* ``Giant Round Robin | Prelim Round | | |`` -> group/event heading plus a
  round heading ("Prelim Round")
* ``Division A | | | |`` -> division heading
* ``Under 2000 RR | A | B | C | 3rd-D`` -> a real result row

So every returned entry is flattened to
``{name, division, round, first, second, third, third_fourth}`` where ``name``
is the enclosing event/group ("Giant Round Robin") or, for flat tournaments,
the row's own event label ("Under 2000 RR").

A login shell (e.g. ``Members.asp?s=4``) or a DataFlex error page carries no
results table at all; those come back as ``{"error": "results are not public
for this event"}`` instead of raising. A results table with only its header
row is a legitimately empty event list and comes back as ``events: []``.
"""

from __future__ import annotations

import re

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://omnipong.com/T-tourney.asp"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
NO_RESULTS = "results are not public for this event"

COLUMNS = ("first", "second", "third", "third_fourth")

# Heading vocabulary seen on live pages.
_ROUND_RE = re.compile(
    r"(prelim|round|quarter|semi|final|consolation|play-?off|group)", re.IGNORECASE
)
_DIVISION_RE = re.compile(
    r"^(division|div\.?|group|flight|bracket|tier|class)\b", re.IGNORECASE
)
_TITLE_SUFFIX_RE = re.compile(r"\s*-\s*Event Draws and Results\s*$", re.IGNORECASE)


def _clean(text: str | None) -> str:
    """Collapse whitespace (incl. &nbsp;) and strip a table cell."""
    if not text:
        return ""
    return " ".join(text.replace("\xa0", " ").split())


def _is_division(label: str) -> bool:
    return bool(_DIVISION_RE.match(label or ""))


def _is_round(label: str) -> bool:
    return bool(_ROUND_RE.search(label or ""))


def _decode(response: requests.Response) -> str:
    """Decode the ASP page honouring the page's own iso-8859-1 declaration.

    OmniPong sends ``charset=iso-8859-1`` in the HTML meta tag but not always
    in the HTTP header, so trusting requests' default guess produces mojibake
    in player names.
    """
    declared = re.search(
        rb"charset=['\"]?([\w-]+)", (response.content or b"")[:2048], re.IGNORECASE
    )
    encoding = None
    if declared:
        try:
            encoding = declared.group(1).decode("ascii")
        except UnicodeDecodeError:
            encoding = None
    encoding = encoding or response.encoding or "utf-8"
    try:
        return response.content.decode(encoding, errors="replace")
    except LookupError:
        return response.content.decode("utf-8", errors="replace")


def _results_table(soup: BeautifulSoup):
    """Find the results table by its own header row, not by page position.

    The page wraps the results in a layout table, and ``get_text`` on the
    outer table contains the inner header too — so only a table whose *direct*
    header row reads "Event | First Place | Second Place | ..." qualifies.
    """
    for table in soup.find_all("table"):
        header_row = table.find("tr", recursive=False)
        if header_row is None:
            continue
        cells = [cell.lower() for cell in _row_cells(header_row)]
        if "first place" in cells and "second place" in cells:
            # Prefer the table whose own header row is exactly the results
            # header (layout tables can swallow the inner table's rows).
            if len(cells) == 5 and cells[1] == "first place":
                return table
    for table in soup.find_all("table"):
        header_row = table.find("tr", recursive=False)
        if header_row is None:
            continue
        cells = [cell.lower() for cell in _row_cells(header_row)]
        if "first place" in cells and "second place" in cells:
            return table
    return None


def _row_cells(row) -> list[str]:
    cells = [_clean(cell.get_text(" ")) for cell in row.find_all(["th", "td"])]
    return cells


def parse_results_html(html: str, tid: str, eid: str) -> dict:
    """Parse a saved/live OmniPong results page into the public result dict."""
    soup = BeautifulSoup(html, "html.parser")
    table = _results_table(soup)

    if table is None:
        return {"error": NO_RESULTS}

    heading = soup.find("h3")
    title = _clean(heading.get_text(" ")) if heading else ""
    title = _TITLE_SUFFIX_RE.sub("", title)

    events: list[dict] = []
    event: str | None = None  # enclosing group heading, e.g. "Giant Round Robin"
    division: str | None = None  # enclosing division heading, e.g. "Division A"
    round_name: str | None = None  # e.g. "Prelim Round"

    for row in table.find_all("tr"):
        cells = _row_cells(row)
        if not cells or len(cells) > 5:
            # Empty row, or a malformed/layout row that swallowed the sheet.
            continue
        cells += [""] * (5 - len(cells))
        label, places = cells[0], cells[1:5]
        filled = [place for place in places if place]

        # Header row ("Event - Click for ... | First Place | ...").
        if len(places) > 1 and "first place" in places[0].lower() and "second place" in places[1].lower():
            continue

        if not label and not filled:
            continue

        if not filled:
            # Pure heading: division ("Division A") or group/event title.
            if _is_division(label):
                division = label
            elif _is_round(label):
                round_name = label
            else:
                event, division, round_name = label, None, None
            continue

        # Heading row that only carries the round in the second column, e.g.
        # "Giant Round Robin | Prelim Round | | |".
        if len(filled) == 1 and filled[0] is places[0] and _is_round(places[0]):
            if label and _is_division(label):
                division = label
            elif label:
                event, division = label, None
            round_name = places[0]
            continue

        # Real result row.
        if label and _is_division(label):
            division = label
            name = event or label
        elif label:
            name, division = label, None
        else:
            name = event or division or ""

        entry = {"name": name, "division": division, "round": round_name}
        entry.update(dict(zip(COLUMNS, places)))
        events.append(entry)

    return {
        "tid": str(tid),
        "eid": str(eid),
        "title": title,
        "events": events,
        "raw_len": len(html),
    }


def fetch_event_results(tid: str, eid: str, *, timeout: int = 20) -> dict:
    """Fetch + parse the public results page for one OmniPong event round.

    ``tid`` is the tournament id and ``eid`` the event/round id, i.e. the
    ``t`` and ``r`` query parameters of ``T-tourney.asp``. Returns the parsed
    dict, or ``{"error": ...}`` when the page is not public (login shell,
    error page, no results table). Network/HTTP failures are left to the
    caller so the API layer can report them.
    """
    response = requests.get(
        BASE_URL,
        params={"t": str(tid), "r": str(eid)},
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=timeout,
    )
    response.raise_for_status()
    return parse_results_html(_decode(response), tid, eid)
"""Offline tests for backend/omnipong_results.py (public OmniPong results).

No network: every case runs against an HTML fixture saved inline below from
the live pages (``T-tourney.asp`` for a real multi-division event, a
header-only event, and the ``Members.asp`` login shell). The one test that
goes through ``fetch_event_results`` swaps ``requests.get`` for a fake, so the
fetch/decode path is covered without leaving the machine.
"""
import requests

import omnipong_results as m


MULTI_DIVISION_HTML = """\
<html>
  <head>
    <meta http-equiv="content-type" content="text/html;charset=iso-8859-1" />
    <title>T-Tourney</title>
  </head>
  <body class="background" id="regular">
    <table class="omnipong-header">
      <tr><td class="omnipong-image"><img src="images/o-logo3.png"></td>
      <td class="omnipong-text">Tournaments</td></tr>
    </table>
    <table border="1" width="100%">
      <tr>
        <td class="omnipong" valign="top" >
          <center>
          <h3>2026 Butterfly Houston Fall Giant Round Robin - Event Draws and Results</h3>
          <input type="submit" name="Action" value="Event Results" />
          <br><br><table width="97%" class="omnipong" >
          <tr><th Align="Left">Event - Click for available draws and results</th>
          <th Align="Left" Width="20%">First Place</th>
          <th Align="Left" Width="20%">Second Place</th>
          <th Align="Left" Width="20%">Third Place</th>
          <th Align="Left" Width="20%">Third/Fourth Place</th></tr>
          <tr><td Align="Left"><a href="T-tourney.asp?t=112&r=6266&ev=1&st=1&dv=0"
          target="_self">Giant Round Robin</a></td><td Align="Left">Prelim Round</td>
          <td Align="Left">&nbsp;</td><td Align="Left">&nbsp;</td><td Align="Left">&nbsp;</td></tr>
          <tr><td Align="Left"><a href="T-tourney.asp?t=112&r=6266&ev=2&st=2&dv=0"
          target="_self">Division A</a></td><td Align="Left">Johan Hagberg</td>
          <td Align="Left">Ojo Onaolapo</td><td Align="Left">Sunday Agboke</td>
          <td Align="Left">3rd-Masood Hyder</td></tr>
          <tr><td Align="Left">Division B</td><td Align="Left">Chibao Nguyen</td>
          <td Align="Left">  Tariq   Khan  </td><td Align="Left">Yilun Li</td>
          <td Align="Left">3rd-Arya Sankar</td></tr>
          <tr><td Align="Left">Division C</td><td Align="Left">Adesina Saka</td>
          <td Align="Left">Angel Jr Santiago</td></tr>
          </table>
          </center>
        </td>
      </tr>
    </table>
  </body>
</html>
"""

LOGIN_SHELL_HTML = """\
<html>
  <head>
    <meta http-equiv="content-type" content="text/html;charset=iso-8859-1" />
    <title>OmniPong</title>
  </head>
  <body>
    <table border="1" width="100%">
      <tr>
        <td class="omnipong" valign="top">
          <form action="Members.asp?s=4" method="post">
            Login ID: <input type="text" name="LoginID" />
            Password: <input type="password" name="Password" />
            <input type="submit" value="Login" />
          </form>
        </td>
        <td class="omnipong" valign="top" >
          <center>
            <img src="images/player1.jpg" Class="floatLeft">
            <h1><br>Member Login</h1>
            <h4><br><br>Please log in using your Member Login ID and Password</h4>
          </center>
        </td>
      </tr>
    </table>
  </body>
</html>
"""

EMPTY_TABLE_HTML = """\
<html>
  <head><meta http-equiv="content-type" content="text/html;charset=iso-8859-1" /></head>
  <body>
    <table border="1" width="100%">
      <tr>
        <td class="omnipong" valign="top" >
          <center>
          <h3>2026 Fremont Thanksgiving Teams - Event Draws and Results</h3>
          <table width="97%" class="omnipong" >
          <tr><th Align="Left">Event - Click for available draws and results</th>
          <th Align="Left" Width="20%">First Place</th>
          <th Align="Left" Width="20%">Second Place</th>
          <th Align="Left" Width="20%">Third Place</th>
          <th Align="Left" Width="20%">Third/Fourth Place</th></tr>
          </table>
          </center>
        </td>
      </tr>
    </table>
  </body>
</html>
"""

RESULT_KEYS = {"tid", "eid", "title", "events", "raw_len"}
EVENT_KEYS = {"name", "division", "round", "first", "second", "third", "third_fourth"}


class _FakeResponse:
    """Minimal stand-in for requests.Response (content + encoding only)."""

    def __init__(self, html: str, encoding: str = "iso-8859-1", status_code: int = 200):
        self.content = html.encode(encoding)
        self.encoding = encoding
        self.status_code = status_code
        self.headers = {"content-type": f"text/html; charset={encoding}"}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} error")


def test_multi_division_results_table():
    parsed = m.parse_results_html(MULTI_DIVISION_HTML, "103", "6266")

    assert set(parsed) == RESULT_KEYS
    assert parsed["tid"] == "103" and parsed["eid"] == "6266"
    assert parsed["title"] == "2026 Butterfly Houston Fall Giant Round Robin"
    assert parsed["raw_len"] == len(MULTI_DIVISION_HTML)

    events = parsed["events"]
    assert [e["division"] for e in events] == ["Division A", "Division B", "Division C"]
    for entry in events:
        assert set(entry) == EVENT_KEYS

    first = events[0]
    assert first == {
        "name": "Giant Round Robin",
        "division": "Division A",
        "round": "Prelim Round",
        "first": "Johan Hagberg",
        "second": "Ojo Onaolapo",
        "third": "Sunday Agboke",
        "third_fourth": "3rd-Masood Hyder",
    }

    # Inner whitespace is collapsed, not just outer-stripped.
    assert events[1]["second"] == "Tariq Khan"
    # A short row keeps its known columns and pads the missing ones as "".
    assert events[2]["first"] == "Adesina Saka"
    assert events[2]["second"] == "Angel Jr Santiago"
    assert events[2]["third"] == "" and events[2]["third_fourth"] == ""
    # The header row and the round heading never become results.
    assert all(e["first"] not in {"First Place", "Prelim Round"} for e in events)


def test_login_shell_returns_error_instead_of_raising(monkeypatch):
    calls = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        calls.update(url=url, params=params, headers=headers, timeout=timeout)
        return _FakeResponse(LOGIN_SHELL_HTML)

    monkeypatch.setattr(m.requests, "get", fake_get)

    result = m.fetch_event_results("103", "6266")

    assert result == {"error": "results are not public for this event"}
    # Plain HTTP GET of the public ASP page, no browser, desktop UA, no login.
    assert calls["url"] == "https://omnipong.com/T-tourney.asp"
    assert calls["params"] == {"t": "103", "r": "6266"}
    assert calls["timeout"] == 20
    assert calls["headers"]["User-Agent"].startswith("Mozilla/5.0")


def test_empty_results_table_is_empty_event_list(monkeypatch):
    monkeypatch.setattr(
        m.requests, "get", lambda *a, **kw: _FakeResponse(EMPTY_TABLE_HTML)
    )

    result = m.fetch_event_results("103", "5827")

    assert set(result) == RESULT_KEYS
    assert result["events"] == []
    assert result["title"] == "2026 Fremont Thanksgiving Teams"
    assert result["raw_len"] == len(EMPTY_TABLE_HTML)


def test_parse_results_html_login_shell_directly():
    assert m.parse_results_html(LOGIN_SHELL_HTML, "1", "2") == {
        "error": "results are not public for this event"
    }


def test_parse_results_html_error_page_without_results_table():
    # DataFlex error page shape: an outer table, no results header anywhere.
    html = (
        '<html><body><table border="1"><tr><td>Find past end of table '
        "Table = tournmnt (2), Record = 999999</td></tr></table></body></html>"
    )

    assert m.parse_results_html(html, "103", "999999") == {
        "error": "results are not public for this event"
    }
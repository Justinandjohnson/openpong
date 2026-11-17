# OmniPong service (vendored)

A faithful, runnable vendor of the OmniPong Python service, copied out of
`~/Desktop/omnipong` (Apache-2.0). It is the FastAPI backend plus the Python
domain modules it imports, laid out so it boots with one command and answers a
health/probe request **without any personal data**.

This is a **vendor + minimal run-glue** copy: domain logic is unchanged. The
only edits are:

- SQLite path is overridable via `OMNIPONG_DB` (defaults to `./omnipong.db`).
- An optional shared-secret gate on `/agent/*` via `OMNIPONG_SERVICE_TOKEN`.
- Path adjustments for the one-level-shallower layout (see *Layout* below).

## Layout

The source app lived at `<repo>/rubberr/backend/`, with the Python domain
modules at the repo root. That made the repo root **two** levels above the
app. Here the app is at `services/omnipong/backend/`, so the module root is
**one** level up. Relative paths that used `../..` were changed to `..`:

```
services/omnipong/
├── backend/                 # FastAPI package (was rubberr/backend/)
│   ├── __init__.py
│   ├── main.py              # FastAPI app: backend.main:app
│   ├── ai_handler.py
│   ├── rating_engine.py
│   ├── tournament_intelligence.py
│   ├── browser_agent.py
│   ├── stadiumtt_scraper.py  # public, login-free league scraper (default)
│   ├── stadium_league_scraper.py  # legacy credential fallback (opt-in)
│   ├── scrape_existing_browser.py
│   └── seed.py
├── models.py                # SQLAlchemy models
├── omnipong_scraper.py
├── browser_manager.py
├── omnipong_config.py
├── omnipong_agent.py        # ACTION_MAP / run_action
├── daily_check.py
├── autoscrape.py
├── init_db.py
├── ingest_tournaments.py
├── sync_omnipong_players.py
├── sync_rating.py
├── sync_tournaments.py
├── requirements.txt         # copied from the source repo root, unpinned minimums
├── Dockerfile
└── README.md
```

Not vendored: the personal `omnipong.db`, `.env`, credentials, `entry_forms/`
data, frontend, relay, and one-off migration scripts. The DB is created empty
on first boot.

## Requirements

Python 3.13 (verified against the source venv, Python 3.13.9). The browser
scraping features need Playwright browsers (`playwright install chromium`);
the API and the health/probe endpoints do **not** — they boot without them.

## Run locally

```bash
cd services/omnipong

python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Optional, only for browser scraping:
#   playwright install chromium

# Create the SQLite schema (uses OMNIPONG_DB if set, else ./omnipong.db)
python init_db.py

# Boot the API
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Then:

```bash
curl -s localhost:8000/agent/actions
# {"actions":["check","matches","search","signup","sync","tournaments"]}

curl -s localhost:8000/openapi.json | head
```

`main.py` also creates any missing tables at import, so `init_db.py` is a
convenience rather than a hard prerequisite.

## Run with Docker

```bash
cd services/omnipong
docker build -t omnipong-service .
docker run --rm -p 8000:8000 -v omnipong-data:/data omnipong-service
```

## Environment variables

The service boots with **none** of these set. Everything below is optional and
only unlocks specific features.

| Variable | Purpose |
| --- | --- |
| `OMNIPONG_DB` | **Added for OpenPong.** Path to the SQLite file. Default: `<service>/omnipong.db`. No personal DB is required or shipped. |
| `DATABASE_URL` | Full SQLAlchemy URL. If set, overrides `OMNIPONG_DB` in `main.py`/`seed.py` (e.g. Postgres; `postgres://` is auto-normalized). |
| `OMNIPONG_SERVICE_TOKEN` | **Added for OpenPong.** When set, every `/agent/*` request must send `Authorization: Bearer <token>`. When unset, `/agent/*` behaves exactly as before (open, minus any existing key checks). |
| `RUBBERR_API_KEY` | When set, require `X-Api-Key: <value>` on `/chat`, `/players/*/scouting`, and `/agent/action`. |
| `OPERATOR_TOKEN` | Owner gate for the Tier-3 browser sync + Tier-1 lookup endpoints (`/tools/sync/*`, `/tools/lookup/usatt`). Fails closed (503) if unset. |
| `ANTHROPIC_API_KEY` | Used by `/chat`, player scouting, and tournament intelligence. |
| `OPENAI_API_KEY` | Used by audio transcription / multimodal helper paths. |
| `OPENROUTER_API_KEY` | BYOK fallback key for browser-agent runs. |
| `BROWSER_AGENT_MODEL`, `BROWSER_AGENT_FALLBACK_MODEL` | Browser-agent model selection. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Inbound SMS at `POST /webhooks/twilio`: the webhook verifies `X-Twilio-Signature` (403 without a valid one, fails closed when the auth token is unset) and answers `MATCHES`, `TOURNAMENTS`, `RATING`, `SYNC` or `HELP` by rule. No model is called, so a text cannot spend the owner's budget. `TWILIO_PUBLIC_HOST` / `TWILIO_PUBLIC_SCHEME` override the signed URL behind a proxy. |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_PHONE_NUMBER` | Legacy keys for the practice-reminder sender. |
| `USER_PHONE_NUMBER`, `PLAYER_NAME`, `PLAYER_FULL_NAME`, `PLAYER_EMAIL` | Generic identity/contact defaults. |
| `AREA_REGION`, `AREA_CITIES`, `AREA_STATES` | OmniPong region/area filter for the agent (defaults: region `8` = Texas). |
| `STADIUMTT_LEAGUE_URLS` | **Added for OpenPong.** Comma-separated public `stadiumtt.com/tournament/<uuid>` URLs to sync league matches from. Unset = no league configured (the sync tells you to set one). |
| `STADIUMTT_OWNER` | Owner player name ("Last, First"). Falls back to `OMNIPONG_OWNER` / `PLAYER_FULL_NAME` / the first `users` row. |
| `STADIUMTT_BROWSER_CHANNEL` | Optional Playwright channel override (e.g. `chrome`) for the public scraper. Defaults to bundled Chromium. |
| `OMNIPONG_USER`, `OMNIPONG_PASS`, `STADIUM_USER`, `STADIUM_PASS` | Legacy stadiumcompete credentials, used only by `--legacy-login` / `legacy=true`. Not needed for the default public scraper. |
| `RELAY_BASE_URL`, `RELAY_REGISTER_TOKEN`, `RELAY_PUBLIC_REGISTER_TOKEN`, `RELAY_OPERATOR_TOKEN`, `RELAY_GATE_TTL_S` | Browser-agent relay bridge (Tier-3). Superseded by the names below; still accepted. |
| `OMNIPONG_BROWSER` | **Added for OpenPong.** `local` (default) or `relay`. `relay` drives the user's own logged-in Chrome through the relay + companion and never reads `.credentials.json`. |
| `OMNIPONG_ALLOW_STORED_CREDENTIALS` | **Added for OpenPong.** The legacy `.credentials.json` / env credential path is used ONLY when this is `true`. Default off. |
| `RELAY_URL`, `RELAY_TOKEN`, `RELAY_OWNER`, `RELAY_PAIRING_TOKEN` | **Added for OpenPong.** Relay base URL, operator token, the owner this service drives, and an optional pinned pairing token. `RELAY_URL`/`RELAY_TOKEN` are also read by the dashboard server. |

The app reads a `.env` next to this README (`services/omnipong/.env`) if present.

## Endpoints

Defined in `backend/main.py` (46 OpenAPI paths). Highlights:

- `GET /` — liveness: `{"status":"Rubberr Backend Running"}`
- `GET /demo`, `GET /user`, `GET /matches`, `GET /matches/summary`, `GET /rating_history`
- `GET /tournaments`, `POST /tournaments/signup`, `GET /notifications`, `POST /notifications/{id}/read`
- `GET /agent/actions`, `POST /agent/action` — the OmniPong agent surface (`check|signup|search|sync|matches|tournaments`)
- `GET /stats`, `GET /tools/stats`, `GET /tools/analysis`, `GET /tools/context`
- `POST /chat`, `POST /tools/check-tournaments`, `POST /tools/query/*`, `POST /tools/search/players`
- `GET /tools/tournament_intelligence`, `GET /tools/practice_partners`, `GET /training/recommendations`
- `POST /tools/sync/omnipong` (+ SSE `/tools/sync/omnipong/events/{id}`), `POST /tools/sync/stadium` (+ SSE), `POST /tools/sync/league` (public STADIUM leagues, no login by default), `POST /tools/sync/tournaments`
- `POST /tools/lookup/usatt`, `GET /players/{player_name}/scouting`
- `POST /webhooks/twilio`
- `POST /arcade/*` (transcribe, process, lookup_player, submit_score)

## CLI helpers

The domain modules are also importable scripts, e.g.:

```bash
OMNIPONG_DB=/tmp/omnipong.db python omnipong_agent.py tournaments
python -m backend.seed          # seed a showcase player/match dataset
```

## Relay + companion (no stored credentials)

The **write** path — tournament registration and logged-in scraping — can drive
the user's own, already-logged-in Chrome through the relay and companion
instead of storing a password. See [`docs/RELAY_ARCHITECTURE.md`](../../docs/RELAY_ARCHITECTURE.md).

```
services/omnipong/
├── relay/        # the relay server (FastAPI + Starlette WS) — one per deployment
│   ├── server.py         # routes: /companion/*, /session/*, /cdp/*, /pairing, /companions/*
│   ├── registry.py       # in-memory sessions + the persisted PairingStore
│   ├── protocol.py, errors.py, config.py
│   └── test_relay.py     # protocol / pairing / owner-mismatch / TTL tests
├── companion/    # runs on the person's own computer
│   ├── companion.py      # one outbound WS to the relay; proxies localhost:9222
│   ├── chrome.py, gate_ui.py, companion_protocol.py
│   └── test_companion.py # integration test against a fake CDP endpoint + fake relay
└── browser_backend.py    # env-selected seam: relay (no creds) vs local (opt-in)
```

- **relay**: run it once (`cd relay && RELAY_OPERATOR_TOKEN=… ./run.sh`).
- **companion**: the dashboard mints a pairing command
  (Settings → Your computer) and the person runs it on the computer that stays
  logged in to OmniPong.
- **seam**: set `OMNIPONG_BROWSER=relay` + `RELAY_URL`/`RELAY_TOKEN`/`RELAY_OWNER`.
  With relay mode on, `.credentials.json` is never read. If relay mode is
  requested but no companion is connected, the service returns a typed
  `no_companion_connected` error ("No companion connected — open OpenPong on
  your computer and pair it") instead of hanging.
- **per-user pairing**: a companion is paired to exactly one owner and the
  relay refuses a session whose owner does not match the pairing (403
  `OwnerMismatch`). The pairing is revocable from the dashboard.

Tests: `python -m pytest relay companion tests/test_browser_backend.py -q`.

## Notes / caveats

- `requirements.txt` is copied verbatim from the source repo root; the source
  pins minimum versions (`>=`) rather than exact versions, so those are kept
  as found.
- Browser scraping paths (Playwright, `browser-use`) are vendored but were not
  exercised in Phase 0; only the API boot + `/agent/*` probe were verified.
- The source repo is read-only and was never modified.

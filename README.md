<div align="center">

# OpenPong

**An open, agent-first table tennis manager — keep track of everything, and let it manage everything for you.**

Ratings, matches, tournaments and coaching in one place, with an agent that does the work:
it reads your area's tournament calendar, syncs your league results, prepares a signup, and
keeps watching while you play.

</div>

Built by fusing two open projects:

- **[OpenMuse](https://github.com/CopilotKit/openmuse)** (MIT) — the agent harness: CopilotKit runtime, durable task engine with leases and approvals, Playwright browser worker, and the native app.
- **[OmniPong](https://github.com/Justinandjohnson/omnipong)** (Apache-2.0) — the table tennis domain: USATT ratings, area tournament discovery, league match history, event matching and signups.

Both stay open source here. OpenPong itself is Apache-2.0 with the upstream MIT notices preserved.

---

## What it is

Three surfaces, one runtime:

| Surface | What it is |
| --- | --- |
| **Dashboard** (`apps/web`) | Next.js + Tailwind + shadcn-style UI. Tournaments, matches, analytics, player lookup, profile/settings, and a coach panel on every screen. Installable as a PWA on a phone or tablet. |
| **Coach** (built-in chat) | The same thread and the same tools as the dashboard and the native app. Ask in plain language; long work becomes a durable task you can watch, pause, and approve. |
| **Native app** (`apps/mobile`) | Expo / React Native for iOS and Android. Same server, same threads, same workspace. |

Everything the agent knows about you comes from **your profile**: name, USATT number, home
region, cities, states, clubs, and the league pages you follow. Nothing is hard-coded — the
same download works for someone in Ohio as it does for the first user in Texas.

### What the agent can do

| Capability | Tool | Notes |
| --- | --- | --- |
| Your identity and rating | `get_my_profile` | Reads your saved profile plus the live rating from the domain service. |
| Anyone's rating | `search_player`, `get_player_profile` | Public USATT lookups; no login. |
| Tournaments near you | `list_tournaments` | Filtered to your saved area. `deep: true` scrapes each event's divisions and fees. |
| Your match history | `list_my_matches`, `get_analytics` | League, USATT and arcade results together; win rate, rating trend, patterns. |
| League sync | `sync_league` | Scrapes your public league pages (Stadium TT) into your history. No credentials. |
| Full data sync | `sync_data` | Durable task: tournaments, leagues, camps, events, details. |
| Tournament signup | `signup_tournament` | **Dry run by default.** A real registration needs `OMNIPONG_ALLOW_REAL_SIGNUP=true` *and* an explicit approval in the app. |
| Watch a tournament | `watch_tournament` | Recurring check with deduplicated alerts. |
| Log a match | `record_match` | Writes an arcade/club result to your ledger; re-posting the same match is a no-op. |
| Daily scout | scout task | Once a day it diffs your area's tournaments and pings you only for new ones. |
| Calendar hub | `sync_pong_calendar`, `add_pong_event`, `list_pong_events` | Writes your tournaments, approved registrations and results into one **Pong** calendar. Google gets a real secondary calendar via OAuth; Apple and Outlook subscribe to a private iCal feed. The agent can only touch Pong. |

### Trust model

- **No third-party credentials are stored.** League data comes from public pages. Anything that needs your login (registration, private history) runs through your own browser via the relay + companion: the user logs in themselves and a human gate handles any login/2FA. With `OMNIPONG_BROWSER=relay`, no credential file is read at all — the legacy stored-credential path is opt-in only (`OMNIPONG_ALLOW_STORED_CREDENTIALS=true`). See `docs/RELAY_ARCHITECTURE.md`.
- **Signups are never silent.** The tool previews, the task waits for approval, and the receipt is saved.
- **Read tools are read-only.** Chat cannot change your record through a query tool.
- **Your bearer stays server-side.** The dashboard's BFF mints the session; the browser only holds an httpOnly cookie.
- **Scraped text is data, not instructions.** The coach is told never to obey instructions found in a page.

---

## Quick start

**Requirements**

- Node 22+ (24 LTS recommended) and pnpm 11.19.0
- Python 3.13 for the OmniPong domain service
- A CopilotKit Intelligence project key (`CPK_INTELLIGENCE_API_KEY`) — optional; without it chat
  still works but threads are not persisted (`/api/health` reports `threadsConfigured: false`)
- A model provider key (OpenAI, Anthropic, Google, or OpenRouter)

```sh
git clone <your-fork-url> openpong
cd openpong
pnpm install
cp .env.example .env
```

Edit `.env` with at least:

```sh
CPK_INTELLIGENCE_API_KEY=cpk-...
AGENT_BACKEND=model
MODEL=openai/google/gemini-2.5-flash        # or any provider/model your key supports
OPENAI_API_KEY=sk-...                        # matching provider key
OPENAI_BASE_URL=https://openrouter.ai/api/v1 # only for OpenRouter
OPENAI_CHAT_COMPLETIONS=true                 # required for OpenRouter
```

Then run three processes:

```sh
# 1. The table tennis domain service (ratings, matches, tournaments)
cd services/omnipong
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# playwright install chromium   # needed for scraping and signups
uvicorn backend.main:app --host 127.0.0.1 --port 8000

# 2. The agent server
pnpm dev            # http://localhost:8787/api/health

# 3. The dashboard
pnpm dev:dashboard  # http://localhost:3000
```

Optional: `pnpm dev:web` runs the native app as a web build on
[localhost:8081](http://localhost:8081), and `pnpm --dir apps/mobile ios` opens it on a simulator.

On first run the dashboard shows a **Set up my profile** banner. Fill in your name and area —
that one record is what makes the tournament search and the coach yours.

---

## Try it

1. **“What's my USATT rating, and how did my last match go?”** — answers from the domain service, with the most recent result and set scores.
2. **“Find tournaments near me”** — filtered by your saved cities and states, not by a default region.
3. **“Sync my league matches”** — needs a league URL in Settings; the task shows its progress and refuses politely if none is saved.
4. **“Prepare a signup for <tournament>”** — returns a preview you can approve; nothing is registered unless real signups are enabled.
5. Open **Matches** and **Analytics** for the same data as charts, and **Player lookup** for anyone else's rating.
6. **Log a match** on `/matches/new` (or just tell the coach the score) — it lands in the ledger, the record ring and the form strip immediately.
7. **Text your OpenPong number** `MATCHES`, `TOURNAMENTS`, `RATING`, `SYNC` or `HELP` — the webhook verifies Twilio's signature and answers by rule, never by model.
8. **Save your mobile number** in Settings → *Text alerts*, then **Send a test text**. The daily scout texts you when a new tournament shows up in your area; if Twilio is not configured yet the card says so instead of pretending.

---

## Architecture

```
apps/web          Next.js dashboard (PWA) + BFF (holds the bearer, proxies the runtime)
apps/mobile       Expo app (iOS / Android / web)
apps/server       Hono API + CopilotKit runtime + durable task engine
  engine/         tools (chat + durable), task worker, service layer
  omnipong/       typed HTTP client for the domain service
  onboarding/     profile + area resolution (no literals)
apps/worker       Playwright browser worker (token-protected, persistent profiles)
services/omnipong Vendored OmniPong FastAPI service (Apache-2.0)
packages/domain   Shared schemas and types
docs/             Build plan, verification notes, and upstream documentation
```

The dashboard and the native app both speak to `apps/server`; the server speaks to
`services/omnipong` over HTTP (`POST /agent/action`, `/tools/*`). The agent never talks to a
scraper directly, so the domain logic stays in Python and the product stays portable.

Tool registration lives in two places, by design:

- `apps/server/src/engine/conversation.ts` — fast, read-only tools that answer a chat turn.
- `apps/server/src/engine/model.ts` — durable tools that become tasks with leases, retries,
  approvals, and receipts (`sync_data`, `sync_league`, `signup_tournament`, `watch_tournament`).

---

## Data and credentials

| Data | Where it comes from | Credentials |
| --- | --- | --- |
| USATT rating and number | OmniPong service / USATT lookups | none (public) |
| League matches and set scores | Stadium TT public league pages | none (public) |
| Tournament calendar, events, fees | omnipong.com public pages | none for reading |
| Tournament signup | OmniPong service | your own browser session, with approval; real signups are opt-in |

Your app state (profile, tasks, goals, watches, memories) lives in the agent server's data
directory (`.openmuse/` by default, PGlite or Postgres). Chat threads live in CopilotKit
Intelligence, keyed by your project.

---

## Testing

```sh
pnpm typecheck     # server + native app
pnpm test          # 550 tests
pnpm lint          # Biome

cd services/omnipong && .venv/bin/python -m pytest tests -q   # domain service
```

---

## Documentation

- [`docs/SETUP.md`](docs/SETUP.md) — **start here**: the five in-app steps, then the one-time host setup for Google Calendar and Twilio texts.
- [`docs/OPENPONG_BUILD_PLAN.md`](docs/OPENPONG_BUILD_PLAN.md) — locked decisions, phases, review findings, and the definition of done.
- [`services/omnipong/README.md`](services/omnipong/README.md) — the domain service: endpoints, environment, Docker.
- [`apps/web/README.md`](apps/web/README.md) — the dashboard and its BFF.
- Upstream docs for the inherited harness remain in [`docs/`](docs/) (computer, browser worker, Rich Threads, deployment).

## Deploying

The full recipe is in [`docs/DEPLOY.md`](docs/DEPLOY.md): three topologies (local dev, a single
VPS with Docker Compose, and a managed split), an env-var matrix for every process, health checks
and smoke tests, scaling/durability notes, and a security checklist. In short — the agent server
(Node, 8787), the dashboard (Next.js, 3000) and the Python domain service (8000) are independent
processes that talk over HTTP; the domain service bakes Chromium, so it must run on a real
container host, not Cloudflare Workers. The root [`render.yaml`](render.yaml) is now OpenPong's own
Blueprint (api + dashboard + private domain service + Postgres), not the inherited OpenMuse one.

Locally it is the three processes from the quick start (`pnpm dev`, `pnpm dev:dashboard`, and the
domain service). For the whole stack on one host, it is one command after you fill in `.env`:

```sh
docker compose --env-file .env -f infra/compose.yaml up -d --build
```

## License

MIT (see [`LICENSE`](LICENSE)) for the OpenPong harness, with Apache-2.0 components
vendored from OmniPong. See [`NOTICE`](NOTICE) for the full attribution; upstream notices are
preserved.
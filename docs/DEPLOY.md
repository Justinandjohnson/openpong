# Deploying OpenPong

OpenPong is three processes and a database. Nothing here assumes you have seen the
project before.

| Process | Language | Default port | What it is |
| --- | --- | --- | --- |
| **Agent server** (`apps/server`) | Node 22+ | 8787 | Hono API + CopilotKit runtime + durable task engine. Owns the profile, tasks, goals, watches and the Pong calendar feed. |
| **Dashboard** (`apps/web`) | Next.js 16 | 3000 | The PWA UI and a small BFF. It holds the bearer and proxies the agent server, so the browser only ever sees an httpOnly cookie. |
| **Domain service** (`services/omnipong`) | Python 3.13 | 8000 | Vendored OmniPong FastAPI: ratings, matches, tournaments, league sync, inbound SMS. **Ships Chromium** for scraping. |

Plus storage: the agent server's data directory (embedded PGlite by default, or
Postgres) and the domain service's SQLite file / Playwright profiles.

There are three sane topologies. Pick one; you can move between them later.

- **A. Local development** — three processes on your laptop. Best for trying it or hacking on it.
- **B. Single small VPS with Docker Compose** — the recommended self-host. One box, TLS, Postgres.
- **C. Managed split** — agent server + dashboard on a Node host, domain service on a host that can run Chromium. This is what the root `render.yaml` describes.

---

## Prerequisites

- **Node 22+** (24 LTS recommended) and **pnpm 11.19.0** (`corepack enable` or the standalone pnpm).
- **Python 3.13** for the domain service (Playwright needs a real OS; see *What can't be hosted where*).
- A model provider key (OpenAI, Anthropic, Google, or OpenRouter) for a real agent.
- Optional: a **CopilotKit Intelligence** project key. It only enables cross-device chat threads.
- Optional: **Docker** for topology B.

No third-party login is needed for the core product: league data comes from public
pages and ratings come from public lookups.

---

## Topology A — local development

### 1. Clone and install

```sh
git clone <your-fork-url> openpong
cd openpong
pnpm install
cp .env.example .env
```

`.env` is gitignored and read by the agent server only. The dashboard reads its own
`apps/web/.env.local` (also gitignored); the local defaults already point at the
right places, so you can skip it.

### 2. Configure `.env`

The defaults are a **sample** workspace: fictional data, loopback only, no keys.
That is enough to boot all three processes. For a real agent, set:

```sh
WORKSPACE_MODE=live
OPENMUSE_ACCESS_KEY=$(openssl rand -hex 24)      # 24+ chars
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)  # 32 bytes, base64
AGENT_BACKEND=model
MODEL=google/gemini-2.5-flash                    # or any provider/model you have
GOOGLE_API_KEY=...                               # the matching provider key
```

OpenRouter is OpenAI-compatible; OpenPong auto-routes when it sees
`OPENROUTER_API_KEY` and sets the Chat Completions wire format for you.

### 3. Run the three processes

**Terminal 1 — the domain service (port 8000):**

```sh
cd services/omnipong
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Optional, only for league sync / signup scraping:
#   playwright install chromium
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

From the repo root you can also run `pnpm dev:omnipong` once the venv is active.

**Terminal 2 — the agent server (port 8787):**

```sh
pnpm dev        # tsx watch; http://localhost:8787/api/health
```

**Terminal 3 — the dashboard (port 3000):**

```sh
pnpm dev:dashboard   # http://localhost:3000
```

The dashboard needs no env file locally: it defaults to
`OPENPONG_SERVER_URL=http://localhost:8787` and
`OMNIPONG_SERVICE_URL=http://127.0.0.1:8000`. If the agent server is in live mode,
put the same `OPENPONG_ACCESS_KEY` in `apps/web/.env.local` so the BFF can mint a
session.

### 4. Seed a demo database (optional)

There are two independent stores.

**Domain service** (ratings/matches/tournaments) — create the schema and insert a
fictional showcase player and matches. No personal data ships with the repo:

```sh
cd services/omnipong
source .venv/bin/activate
python init_db.py          # create tables (the app also creates them at import)
python -m backend.seed     # a showcase player, 10 matches, 3 events, rating history
```

**Agent server** (profile/tasks) — in `sample` mode the workspace seeds itself the
first time a session is minted; there is nothing to run. For a fully isolated,
scripted demo (mock model on port 8788, its own data dir, its own browser worker):

```sh
pnpm dev:demo
```

### 5. Get a session token

Every agent-server route needs `Authorization: Bearer <token>`. Mint one:

```sh
curl -s -X POST http://localhost:8787/api/session \
  -H 'content-type: application/json' -d '{}'
# {"token":"<base64url>","mode":"sample"}
```

In live mode pass the access key: `-d '{"accessKey":"<OPENMUSE_ACCESS_KEY>"}'`.
Use it like this:

```sh
TOKEN=<paste>
curl -s http://localhost:8787/api/agent/profile -H "Authorization: Bearer $TOKEN"
```

The dashboard does this for you behind the scenes; the browser never holds the token.

---

## Topology B — single small VPS with Docker Compose (recommended self-host)

`infra/compose.yaml` runs four containers on one private network: **Postgres**, the
**domain service**, the **agent server**, and the **dashboard**. Only the dashboard
is meant to be exposed; put TLS in front of it.

> The stack runs the agent server in **live** mode. Sample mode refuses a
> non-loopback `HOST`, which a container needs, so live is the only mode that works
> across the Docker network.

### 1. Prepare `.env`

```sh
git clone <your-fork-url> openpong
cd openpong
cp .env.example .env
```

Fill in at least these (Compose refuses to start without them and tells you which
one is missing):

```sh
WORKSPACE_MODE=live
OPENMUSE_ACCESS_KEY=$(openssl rand -hex 24)
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
OMNIPONG_SERVICE_TOKEN=$(openssl rand -hex 24)
OPENPONG_COOKIE_SECRET=$(openssl rand -hex 24)
POSTGRES_PASSWORD=$(openssl rand -hex 24)

AGENT_BACKEND=model
MODEL=google/gemini-2.5-flash
GOOGLE_API_KEY=...          # or OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY

# Set these to your real public origin(s):
PUBLIC_API_URL=https://api.pong.example.com
ALLOWED_ORIGINS=https://pong.example.com
```

`OPENPONG_COOKIE_SECRET` must be **identical on every dashboard instance**: it seals
the account bearer into the AES-GCM httpOnly cookie, so a restart or a second
instance could not read the cookie otherwise.

### 2. Start it

Run from the repository root, with `--env-file .env` so the `${VAR:?}` checks and the
container env both read the same file:

```sh
docker compose --env-file .env -f infra/compose.yaml up -d --build
docker compose --env-file .env -f infra/compose.yaml ps
```

The first build compiles the two Node images (a few minutes) and builds the domain
service image (Chromium is large). Later starts are cached.

### 3. Verify

```sh
curl -s http://localhost:3000/api/openpong/health   # {"ok":true,...}
curl -s http://localhost:3000/ -o /dev/null -w '%{http_code}\n'   # 200
```

### 4. Put TLS in front of it

Compose binds the dashboard to `127.0.0.1:3000` and the agent server to
`127.0.0.1:8787`. Terminate TLS at a reverse proxy and forward to the dashboard. A
Caddy example:

```
pong.example.com {
    reverse_proxy 127.0.0.1:3000
}
api.pong.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Two things depend on the agent server having its own public URL, so give it one (as
above) and set `PUBLIC_API_URL` to it:

- **Google Calendar OAuth** redirects to `PUBLIC_API_URL + /api/google/callback`.
- **Signed file / browser-console links** are absolute URLs built from `PUBLIC_API_URL`.

If you skip the API hostname, everything else still works through the dashboard; only
those two features break.

> **Use HTTPS.** In a production build the dashboard marks its cookies `Secure`, so a
> browser on `http://<vps-ip>:3000` will not store them. `http://localhost` is exempt
> (browsers treat it as a secure context), which is why local dev is fine.

---

## Topology C — managed split

Split the stack so each piece runs where it can:

1. **Agent server + dashboard** on a Node host (Render, Fly, Railway, or a plain VM).
   They only need Node 22 and network access to Postgres and the domain service.
2. **Domain service** on a host that can run Chromium: a VM with Docker, a Render
   *private service*, or any container host. It must be a **single long-lived
   instance** if it holds Playwright profiles (see *Scaling and durability*).
3. **Postgres instead of PGlite.** Set `DATABASE_URL` on the agent server. PGlite is
   embedded and single-process; Postgres is what makes the API stateless and
   scalable, and what `MULTI_TENANT=true` needs.

### The Render blueprint

The root `render.yaml` is a working Render Blueprint for this topology:

| Resource | Type | Notes |
| --- | --- | --- |
| `openpong-api` | web (node) | Builds `pnpm build:server`, runs `pnpm start`, health check `/api/health`, disk for `DATA_DIR`. |
| `openpong-web` | web (node) | Builds `pnpm --dir apps/web build`, runs `next start`, health check `/offline`. |
| `openpong-omnipong` | pserv (docker) | Built from `services/omnipong/Dockerfile`; private, Chromium baked in. |
| `openpong-db` | Postgres | `basic-256mb`, internal-only (`ipAllowList: []`). |

To use it: push this repo, create a new **Blueprint** in Render pointing at it, and
paste the `sync: false` secrets in the dashboard (`OPENAI_API_KEY`, the optional
`CPK_*`, and `TWILIO_*`). Everything else is generated or wired automatically.

**Things a Render Blueprint cannot express** (handled here, and why):

- **Private services only get a default TCP health check.** Render's `healthCheckPath`
  is web-services-only, so `openpong-omnipong` has no HTTP health check; Render still
  restarts it if it stops accepting TCP. Verify it with the smoke tests below.
- **A service can attach at most one disk.** The domain service keeps its Playwright
  profiles on that one disk and stores data in Postgres.
- **The domain service is private.** The API and dashboard reach it at
  `http://openpong-omnipong:8000` over Render's private network (same region +
  workspace). If your Render internal DNS ever differs, copy the `hostport` from the
  service's **Connect → Internal** tab and set `OMNIPONG_SERVICE_URL` by hand.
- **All resources must be in the same region** for the private network to resolve.
- **A disk keeps a service single-instance.** `openpong-api` holds `DATA_DIR` on a
  disk, so it will not autoscale. See *Scaling and durability* for what that implies
  and how to remove the constraint.

`MULTI_TENANT=true` is set in the blueprint: Render is public, so real accounts are
the right default. Set it to `"false"` for a single-owner instance (the dashboard then
never shows a login screen).

---

## Environment variable matrix

"Required" is per process. A blank value behaves like unset in most cases. Values
are read at boot; changing them needs a restart.

### Agent server (`apps/server`)

| Variable | Required | Default | What breaks without it |
| --- | --- | --- | --- |
| `WORKSPACE_MODE` | no | `sample` | `sample` is loopback-only and uses fictional data. `live` unlocks real workspaces; it then **requires** `OPENMUSE_ACCESS_KEY` (24+ chars) and `TOKEN_ENCRYPTION_KEY` or it refuses to boot. |
| `AGENT_BACKEND` | no | `sample` (`model` when live) | `sample` uses a scripted agent. `model` needs `MODEL` + a provider key. `agui` needs `AGENT_URL`. |
| `MODEL` | with `model` | — | No model: `agentConfigured` is false and chat fails; tasks that call the model fail. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` | with `model` | — | Provider calls 401; `agentConfigured` false. |
| `OPENROUTER_API_KEY` | no | — | Auto-routes the OpenAI adapter through OpenRouter (and forces Chat Completions). |
| `OPENAI_BASE_URL` | no | — | Needed for a non-OpenAI OpenAI-compatible endpoint. |
| `OPENAI_CHAT_COMPLETIONS` | no | false | Providers whose Responses tool loop is incomplete need `true`. |
| `PORT` | no | `8787` | — |
| `HOST` | no | `127.0.0.1` | `sample` **rejects** a non-loopback host. In a container use `0.0.0.0` + live mode. |
| `PUBLIC_API_URL` | no | `http://localhost:$PORT` | Google OAuth callback and signed links point at the wrong host. |
| `ALLOWED_ORIGINS` | no | `http://localhost:8081,http://127.0.0.1:8081` | A browser origin not in the list gets `403`. Add your dashboard origin. |
| `DATA_DIR` | no | `.openmuse` | — |
| `DATABASE_URL` | no | — | Uses embedded PGlite (single-process). Required for multi-instance and for a separate task worker. |
| `MULTI_TENANT` | no | false | **This is the switch for hosted accounts.** `true` mounts `/api/auth/*`, makes every record account-owned, and closes the shared access-key flow. |
| `OPENMUSE_ACCESS_KEY` | in live | — | Live mode refuses to boot without it (24+ chars). |
| `TOKEN_ENCRYPTION_KEY` | in live | — | Live mode refuses to boot without it (32 bytes, base64). Encrypts connector tokens at rest. |
| `CPK_INTELLIGENCE_API_KEY` | **optional** | — | Only Rich Threads (cross-device chat history/replay). Without it chat and tools still work; `/api/health` reports `threadsConfigured: false`. |
| `CPK_TELEMETRY_ID` | no | — | Runtime usage is not linked to your Intelligence project. |
| `TASK_WORKER_ENABLED` | no | true | Durable tasks do not run in this process (use a dedicated worker). |
| `WEB_SEARCH_ENABLED` | no | true | Keyless public web search is disabled. |
| `TRUST_PROXY` | no | false | Rate limiting keys on the socket address. Set `true` **only** behind a proxy that overwrites `X-Forwarded-For`. |
| `OMNIPONG_SERVICE_URL` | no | `http://127.0.0.1:8000` | Table-tennis tools error when the domain service is unreachable. |
| `OMNIPONG_SERVICE_TOKEN` | no | — | Without it the domain service's `/agent/*` is open (fine on a private network). Set the same value on both sides. |
| `OMNIPONG_ALLOW_REAL_SIGNUP` | no | false | Real tournament registration never happens. Even when `true`, a human approval is still required. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | — | No Google calendar connect (the private iCal feed still works). |
| `BROWSER_WORKER_URL` / `WORKER_TOKEN` | no | — | `browserConfigured: false`; browser tools are unavailable. |
| `STADIUMTT_LEAGUE_URLS` / `OMNIPONG_OWNER` | no | — | No default league; users set league URLs in Settings. |
| `TWILIO_*` | no | — | Inbound SMS webhook is not mounted/answers nothing. |
| `COMPUTER_ENABLED` and friends | no | false | The optional Linux computer stays off. |

### Dashboard (`apps/web`)

| Variable | Required | Default | What breaks without it |
| --- | --- | --- | --- |
| `OPENPONG_SERVER_URL` | no | `http://localhost:8787` | The BFF cannot reach the agent server; every proxied call 502s. |
| `OMNIPONG_SERVICE_URL` | no | `http://127.0.0.1:8000` | The dashboard's direct domain-service proxy fails. |
| `OMNIPONG_SERVICE_TOKEN` | no | — | Domain service rejects the dashboard's `/agent/*` calls (if the service requires it). |
| `OMNIPONG_API_KEY` | no | — | Domain service's protected write routes reject the dashboard. |
| `OPENPONG_ACCESS_KEY` | in live (single-owner) | — | The BFF cannot mint a session when the server is in live mode. |
| `OPENPONG_COOKIE_SECRET` | recommended | falls back to `OPENPONG_ACCESS_KEY` | Seals the account bearer into the AES-GCM cookie. Set a long random value and keep it **identical across instances**. |
| `OPENPONG_OMNIPONG_DB` | no | — | No read-only fallback SQLite corpus for first run / demo. |
| `PORT` | no | `3000` | — (`next start` reads it.) |

### Domain service (`services/omnipong`)

| Variable | Required | Default | What breaks without it |
| --- | --- | --- | --- |
| `OMNIPONG_DB` | no | `<service>/omnipong.db` | — (SQLite path). |
| `DATABASE_URL` | no | — | When set, overrides `OMNIPONG_DB` (Postgres). `postgres://` is normalized. |
| `OMNIPONG_SERVICE_TOKEN` | no | — | Without it `/agent/*` is open. Set the same value on the API and dashboard. |
| `OPERATOR_TOKEN` | no | — | Tier-3 browser sync + USATT lookup endpoints refuse to run (503, fails closed). |
| `RUBBERR_API_KEY` | no | — | Extra `X-Api-Key` gate on `/chat`, scouting, `/agent/action` is off. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | no | — | `/chat`, scouting and browser-agent paths fail. Core data routes are unaffected. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | no | — | `POST /webhooks/twilio` fails closed (403). |
| `TWILIO_PUBLIC_HOST` / `TWILIO_PUBLIC_SCHEME` | no | — | Behind a proxy, signature verification uses the wrong URL and rejects valid texts. |
| `STADIUMTT_LEAGUE_URLS` / `STADIUMTT_OWNER` | no | — | No default league for `sync_league`. |
| `PLAYER_*` / `AREA_*` | no | generic | Identity/area defaults for the domain-side agent. |

---

## Health checks and smoke tests

Run these after every deploy. Expected output is exactly what the code returns.

### Agent server

```sh
curl -s http://localhost:8787/api/health
# {"ok":true,"mode":"sample","agentConfigured":true,"browserConfigured":false,"threadsConfigured":false}
```

- `mode` is `sample` or `live`.
- `agentConfigured` is true in `sample`, or in `model` mode with `MODEL` + a provider key.
- `browserConfigured` is true only with `BROWSER_WORKER_URL` + `WORKER_TOKEN`.
- `threadsConfigured` is true only with a `CPK_INTELLIGENCE_API_KEY` (this is the
  optional one — see the matrix).

```sh
curl -s http://localhost:8787/
# {"name":"OpenPong","app":"http://localhost:8081","health":"/api/health"}

curl -s -X POST http://localhost:8787/api/session \
  -H 'content-type: application/json' -d '{}'
# {"token":"<base64url>","mode":"sample"}
```

### Dashboard

```sh
curl -s http://localhost:3000/api/openpong/health
# {"ok":true,"server":{"ok":true,"mode":"...","agentConfigured":...,...},"serverUrl":"http://localhost:8787"}

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/     # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/offline  # 200
```

### Domain service

```sh
curl -s http://localhost:8000/
# {"status":"Rubberr Backend Running"}

curl -s http://localhost:8000/agent/actions
# {"actions":["check","matches","search","signup","sync","tournaments"]}
```

If `OMNIPONG_SERVICE_TOKEN` is set, add `-H "Authorization: Bearer <token>"` to
`/agent/*` calls; without it you get `401`.

### End-to-end

```sh
# 1. the dashboard can reach the agent server
curl -s http://localhost:3000/api/openpong/health | grep -q '"ok":true' && echo dashboard-ok

# 2. the agent server can reach the domain service (after signing in)
TOKEN=$(curl -s -X POST http://localhost:8787/api/session -H 'content-type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s http://localhost:8787/api/agent/profile -H "Authorization: Bearer $TOKEN" >/dev/null && echo agent-ok
```

---

## Scaling and durability

**The agent server is stateless when it has Postgres.** All durable state lives in one
generic `records(owner, kind, id, data jsonb)` table; task leases are
compare-and-swap on `jsonb`, so several API instances can share the load and the task
worker. Keep `TASK_WORKER_ENABLED=true` on one instance (or run a dedicated worker
with `pnpm start:worker`, which **requires** `DATABASE_URL`).

**Postgres is required for multi-tenant.** `MULTI_TENANT=true` gives real accounts
(scrypt, DB-backed sessions, per-account isolation). Embedded PGlite is a single
process, so use `DATABASE_URL` for anything hosted or scaled.

**Two per-instance secrets you must share to scale the dashboard:**

- `OPENPONG_COOKIE_SECRET` — seals the account bearer. Different values = cookies from
  one instance are unreadable on another.
- The single-owner BFF session (`/api/openpong/session`) keeps the bearer in an
  in-process map, so it is **not** portable across instances. Account mode
  (`MULTI_TENANT=true`) is the scale-out path; single-owner mode expects one instance.

**Agent-server `DATA_DIR` holds:**

- `session-signing-key` — signs short-lived file/browser-console URLs. Copy it to every
  instance (or keep one instance) or signed links break across instances.
- `files/` — uploaded artifacts.
- `postgres/` — the PGlite data directory, **only when `DATABASE_URL` is unset**.

**Backups:**

- Postgres: `pg_dump` (managed hosts snapshot for you).
- PGlite: stop the API (or accept a cold copy) and archive `DATA_DIR/postgres`
  together with `DATA_DIR/session-signing-key`.
- Domain service: the SQLite file (`OMNIPONG_DB`) plus the Playwright profile
  directory, if you scrape.

**The domain service must be one long-lived instance if it holds Playwright
profiles.** `browser_manager.py` uses a persistent `./playwright_data` profile
directory; two replicas would fight over it and break logins. It is also single-owner:
`OPERATOR_TOKEN` gates the Tier-3 endpoints, so it is not a per-tenant service. Scale
it by giving it more RAM/CPU, not replicas.

**Disk-backed services are single-instance.** On Render (and similar), attaching a
disk disables autoscaling and zero-downtime deploys. To scale the API on Render, move
`DATA_DIR` to a shared/durable store and drop the disk — but keep the
`session-signing-key` shared as described above.

---

## Security checklist

- [ ] **Rotate every secret** you did not generate yourself. `OPENMUSE_ACCESS_KEY`,
      `TOKEN_ENCRYPTION_KEY`, `OPENPONG_COOKIE_SECRET`, `OMNIPONG_SERVICE_TOKEN`,
      `OPERATOR_TOKEN`, `WORKER_TOKEN`, `POSTGRES_PASSWORD`.
- [ ] **TLS everywhere.** The dashboard's cookies are `Secure` in production, so plain
      HTTP on a real hostname will not hold a session.
- [ ] **Lock `ALLOWED_ORIGINS`** to your dashboard origin(s). Anything else gets `403`.
- [ ] **Set `MULTI_TENANT=true`** for anything hosted for more than one person.
      Without it the shared access key *is* the account.
- [ ] **Keep the agent server and domain service off the public internet.** Front the
      dashboard; give the agent server its own hostname only if you need Google OAuth
      or signed links.
- [ ] **`TRUST_PROXY=true` only behind a proxy** that overwrites `X-Forwarded-For`,
      otherwise callers can spoof their address past the rate limiter.
- [ ] **Twilio signature verification needs the real public URL.** Set
      `TWILIO_PUBLIC_HOST` / `TWILIO_PUBLIC_SCHEME` when you sit behind a proxy, and
      point the number's *A message comes in* webhook at
      `https://<host>/webhooks/twilio`. The webhook fails closed without
      `TWILIO_AUTH_TOKEN`.
- [ ] **Do not place a `.credentials.json` anywhere.** The vendored
      `browser_manager.py` will read `<service>/.credentials.json` if present. It is
      gitignored and dockerignored, and the default public league scraper needs no
      credentials. A separate workstream is removing this legacy credential path
      entirely; until then, keep the file absent and never bake it into an image.
- [ ] **Protect `DATA_DIR`, the SQLite file, Playwright profiles and database
      backups** as private data. A signed URL is a credential until it expires.
- [ ] **Treat scraped page text as data, not instructions** — the coach is instructed
      never to obey instructions found in a page, but keep that in mind if you extend
      the tools.

---

## What can't be hosted where

- **Cloudflare Workers cannot run the domain service.** It needs Playwright and a
  Chromium binary, and a persistent filesystem for SQLite and browser profiles. There
  is no Chromium and no durable local disk in a Worker.
- **Cloudflare Workers cannot run the agent server either.** It uses Node APIs
  (`node:fs`, `node:child_process` for the optional Linux computer, embedded PGlite)
  that a Worker runtime does not provide.
- **Cloudflare Pages/Workers are fine for the static dashboard export or a read-only
  demo** — for example a Pages-hosted bundle that talks to a remote API. They are not
  a home for the domain service.
- **PGlite is embedded.** It needs a Node filesystem and is single-process. Use
  Postgres for serverless hosts, multiple instances, or multi-tenant.
- **The domain service is stateful.** It wants a persistent disk/volume and a single
  long-lived instance, not an ephemeral serverless function.

---

## Troubleshooting

- **"Live mode requires OPENMUSE_ACCESS_KEY … and TOKEN_ENCRYPTION_KEY"** — you set
  `WORKSPACE_MODE=live` without both secrets. Generate them with `openssl`.
- **"Sample workspace is local-only. HOST must be a loopback address."** — you are
  running sample mode in a container. Use live mode (`infra/compose.yaml` does).
- **Dashboard health is 502** — the BFF cannot reach `OPENPONG_SERVER_URL`. Check the
  agent server is up and the URL is right for the network (in Compose it is
  `http://api:8787`, not localhost).
- **`threadsConfigured: false`** — expected without `CPK_INTELLIGENCE_API_KEY`; chat
  still works, threads just do not sync across devices.
- **A browser origin is rejected with 403** — add it to `ALLOWED_ORIGINS`.
- **Domain service `/agent/*` returns 401** — set the same `OMNIPONG_SERVICE_TOKEN` on
  the caller and the service.
- **A sign-in cookie does not stick over HTTP** — the cookie is `Secure` in
  production; use HTTPS (or `localhost`).

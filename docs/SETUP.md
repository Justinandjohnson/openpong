# Set up OpenPong

Two audiences live in this file:

- **[Part 1 — Anyone with the app open](#part-1--set-up-in-the-app)** — five steps, all inside the
  dashboard, no terminal. This is what the **Install** button and the **Get set up** page walk you
  through.
- **[Part 2 — Whoever runs the server](#part-2--one-time-host-setup)** — the two optional
  connections (Google Calendar, Twilio texts) that a host enables once for everybody.

---

## Part 1 — Set up in the app

Open the dashboard and click **Get set up** (or **Install app** in the header on a phone). The page
shows progress as *N of 5*. Everything is stored per person, so two people on the same server never
see each other's name, area, league or calendar.

### 1. Install the app

Click **Install OpenPong**. The browser installs it like a native app: full screen, its own icon,
and an offline shell that still opens when your signal drops.

- **Chrome / Edge (desktop or Android):** the button appears in the header and on step 1.
- **iPhone / iPad:** Safari has no install prompt. Tap **Share → Add to Home Screen** — step 1 says
  exactly that when it detects iOS.
- **Already installed:** step 1 shows *Done* and the button disappears.

### 2. Your name and area

Click **Set up my profile** and fill in:

| Field | Why it matters |
| --- | --- |
| Display name | How the coach addresses you, and the name matched inside league pages. |
| USATT ID | Optional; lets the coach read your official rating and history. |
| Home region / states / cities | Every tournament search and the daily scout filter to these, so you never see another area's events. |
| Clubs | Used for practice-partner and club notes. |

Save. The dashboard, the scout and the coach all switch to your area immediately.

### 3. Your league

Paste the public page of your league — one URL per line. For Stadium TT leagues that is a link like
`https://stadiumtt.com/tournament/<uuid>`; the wizard accepts a bare host and adds `https://`.

This is a **public page**: OpenPong never asks for a league password, and nothing is stored on the
server. Once saved, the **Sync now** button on the dashboard pulls every match from that league, and
the daily scout keeps it current.

### 4. Your calendar

Click **Connect a calendar**:

- **Google (host configured):** you go to Google's consent screen, approve, and come back. OpenPong
  creates a **secondary** calendar named **Pong** and asks only for
  `calendar.app.created` — it can never see or edit your other calendars.
- **Anywhere else:** the wizard hands you a private `webcal://` link. Add it once in Apple Calendar
  (**File → New Calendar Subscription**), Google Calendar (**Other calendars → From URL**) or
  Outlook. OpenPong keeps writing to that link; the calendar app picks the changes up.

Everything OpenPong knows lands in Pong: upcoming area tournaments, registrations you approved,
league nights and match results. Re-syncing updates events instead of duplicating them, because each
one carries a stable key.

### 5. Text alerts

Type your mobile number and press **Save number**, then **Send a test text**.

- If the host has Twilio configured, the test text arrives and the daily scout will text you when a
  new tournament appears in your area.
- If not, the card says so plainly instead of pretending.

Texts you send back are answered by **rule** — `MATCHES`, `TOURNAMENTS`, `RATING`, `SYNC`, `HELP` —
never by the language model, so a stray text can never spend your model credits.

### 6. Your computer (optional)

Pair the OpenPong companion on a computer you are already signed in on, and the coach can use *that*
browser for pages that need a login (tournament sign-ups, Cloudflare-protected pages). Nothing is
stored on the server; when a login or captcha appears, the agent pauses and a small local page tells
you to finish it in your own Chrome tab, then click **Continue**.

Open **Settings → Your computer** to see the state and pair it.

---

## Part 2 — One-time host setup

Only the person running the server does this, once. Every step is optional: OpenPong boots and works
without any of it, minus the corresponding feature.

### Boot the three processes

```bash
# 1. Domain service — ratings, matches, tournaments (Python/FastAPI)
pnpm dev:omnipong

# 2. Agent server — runtime, tasks, tools (Node)
cp .env.example .env      # then fill in what you want
pnpm dev

# 3. Dashboard — the app you install (Next.js)
pnpm dev:dashboard
```

`docs/DEPLOY.md` covers the same thing for a VPS, Docker Compose and a managed split (Render
blueprint, or Cloudflare for the read-only demos).

### Google Calendar (enables the one-button *Connect Google*)

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick) a project.
2. **APIs & Services → Library → Google Calendar API → Enable.**
3. **OAuth consent screen:** type External, add yourself under **Test users** (a test-mode app needs
   no verification for personal use).
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorised redirect URI, exactly:

   ```
   http://localhost:8787/api/google/callback
   ```

   Add your production URL's equivalent later (`https://your-host/api/google/callback`).
5. Put the client ID and secret in `.env` and restart the agent server:

   ```bash
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

Now step 4 of the wizard offers the Google path. OpenPong requests
`calendar.app.created` (+ `calendarlist.readonly`) and creates the **Pong** calendar itself.

### Twilio texts

1. In the [Twilio console](https://console.twilio.com/), buy (or use) a number that can send SMS.
2. Add to `.env` and restart the domain service:

   ```bash
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM_NUMBER=+1...
   ```

3. Point the number's **Messaging → A message comes in** webhook at

   ```
   POST https://<your-public-host>/webhooks/twilio
   ```

   Behind a tunnel, also set `TWILIO_PUBLIC_HOST` and `TWILIO_PUBLIC_SCHEME` so the signature check
   sees the URL Twilio actually signed. A request with a bad or missing `X-Twilio-Signature` is
   rejected with `403`.

Inbound commands are answered by rule; outbound alerts are sent by the daily scout when it finds a
new tournament in your area.

### Hosting more than one person

By default OpenPong runs as a single owner with no login screen. To host accounts:

```bash
# agent server
MULTI_TENANT=true
OPENMUSE_ACCESS_KEY=<24+ random characters>     # shared secret the dashboard presents
OPENPONG_ACCESS_KEY=<the same value>            # read by the dashboard (Next.js)
OPENPONG_COOKIE_SECRET=<a different long random string>   # seals the account cookie
```

(The access-key variable keeps its original name on the agent server and is read as
`OPENPONG_ACCESS_KEY` by the dashboard; set both to the same value.)

Then `/login` creates real accounts (email + password, scrypt-hashed, DB-backed sessions, login rate
limiting), and every record, task, thread and connector token is scoped to the account that owns it.
Set the same `OPENPONG_COOKIE_SECRET` on every instance so a session survives a restart or a
scale-out. The domain ledger (matches, ratings, tournaments) stays a shared cache — documented in
`docs/OPENPONG_BUILD_PLAN.md` §8.2.

### Optional: CopilotKit Intelligence

`CPK_INTELLIGENCE_API_KEY` adds hosted thread persistence and replay across devices. It is not
required: `/api/health` reports `threadsConfigured: false` and chat still works.

# Connecting Google Calendar

OpenPong's "Connect Google Calendar" button is one click when the server has a
Google app of its own: the person clicks the button, sees Google's consent
screen, clicks **Allow**, and is done. This guide is for whoever runs the
server. There are two lanes.

- **Lane A** — your own Google client. Enough for a self-host, a demo, or
  testing. Two limits apply while the app is unpublished (see below).
- **Lane B** — publish the app and pass OAuth verification. This is what makes
  the button one click for anyone, with no weekly reconnects.

The only thing that differs between the lanes is Google's configuration; the
OpenPong code, the button, and the environment variables are the same.

---

## Lane A — your own client (self-host / testing)

### 1. Create a Google Cloud project and an OAuth client

1. Open **APIs & Services → Credentials**:
   <https://console.cloud.google.com/apis/credentials>
2. If prompted, create a project (any name).
3. Click **Create credentials → OAuth client ID**.
4. Application type: **Web application**.
5. Under **Authorised redirect URIs**, add exactly:

   ```
   <PUBLIC_API_URL>/api/google/callback
   ```

   For local development that is `http://localhost:8787/api/google/callback`.
   `PUBLIC_API_URL` is the OpenPong API's public base URL, the same value the
   server already uses to build its own links.
6. Save, then copy the **Client ID** and **Client secret**.

### 2. Enable the Calendar API

Google refuses the consent until the API is on for the project:

<https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>

Click **Enable**.

### 3. Configure the OAuth consent screen

1. Open the OAuth consent screen / Google Auth Platform:
   <https://console.cloud.google.com/apis/credentials/consent>
2. Choose **External** if the dashboard is open to anyone, or **Internal** if
   it is a single organisation.
3. Fill in the app name, a support email, and a developer contact email.
4. Add the scopes OpenPong asks for (see [The scopes we request](#the-scopes-we-request)).
5. While the app is in **Testing**, add every Google account that will use it
   under **Test users**.

### 4. Set the environment variables

On the OpenPong API service:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

`TOKEN_ENCRYPTION_KEY` must also be set — OpenPong encrypts the refresh token
it stores, and the connect route refuses to start without it. See
`docs/DEPLOY.md` for generating it.

If the dashboard and the API live on different hosts, also set:

```
PUBLIC_APP_URL=https://your-dashboard-host
```

After a consent Google redirects the browser back here; without it OpenPong
returns the person to the first entry in `ALLOWED_ORIGINS`, which is often a
native app or an old dev port rather than the dashboard they were using.

Restart the API. `GET /api/google/status` now reports `configured: true`, and
the dashboard shows the one-click button.

### Two limits of an app left in Testing

Until the app is published (Lane B), Google caps it:

- **At most 100 test users.** Accounts not on the test-user list cannot
  consent.
- **Authorisations expire after 7 days.** The refresh token stops working after
  a week, so the person has to press **Reconnect** weekly.

For a quick demo that is fine. For anyone outside the test-user list, publish
the app.

The app never lies about this. Once a week, when the refresh token dies, `/calendar`
stops saying "Connected" and says **"Google expired this connection"** with a
one-click Reconnect, because a green badge over a dead token is the fastest way
to convince someone their calendar is broken.

---

## What a brand-new person sees

Three situations, three amounts of work. Pick the lane once, and every person who
installs the build gets that experience.

| The person | Their setup | Clicks |
| --- | --- | --- |
| Uses a build whose author published the app (Lane B) | Install → open → **Connect Google Calendar** → Allow | **2** |
| Self-hosts and creates their own client (Lane A) | Cloud Console once (~10 min), then Connect → Allow | 6 once, then 2 |
| Self-hosts and skips Google entirely | Paste the private iCal feed into Apple/Google Calendar | 2, write-only |

After Google is connected, nothing else is needed: the **Pong** calendar is
created automatically, and tournaments, sign-ups, league nights and results sync
into it with one button.

The wizard at `/setup` covers the rest — name and area, league, calendar, text
alerts, your AI key, and the browser — and every step is skippable. A person who
skips Google still gets the coach, the league data and the iCal feed; the only
thing they lose is the coach *reading* their schedule, which a write-only feed
cannot support.

---

## Lane B — publish it (what makes it one click for anyone)

Publishing removes both limits: anyone can consent, and refresh tokens no longer
expire weekly. Nothing in the OpenPong code changes.

1. On the OAuth consent screen, click **Publish app**.
2. Because the scopes below are **sensitive**, Google asks for OAuth
   verification: a homepage, a privacy policy, and a short justification per
   scope.
3. Submit the justification. A paste-ready paragraph:

   > OpenPong keeps a table-tennis player's tournament, league and match
   > schedule in one calendar. It requests three calendar scopes.
   > `calendar.events.readonly` lets the coach answer schedule questions and
   > spot clashes between a tournament and the player's existing plans.
   > `calendar.calendarlist.readonly` lets the player choose which of their
   > calendars the coach may read, and lets the app find the calendar it
   > created. `calendar.app.created` lets the app create and manage only that
   > app-created "Pong" calendar, where tournaments, sign-ups and results are
   > written. OpenPong never requests Gmail access, never requests write access
   > to calendars the user already owns, and cannot read or modify any calendar
   > the user did not select.

4. Wait for verification, then publish.

### CASA is not required here

These three scopes are **sensitive**, not **restricted**. A CASA security
assessment is required only for restricted scopes such as
`https://www.googleapis.com/auth/calendar` and
`https://www.googleapis.com/auth/calendar.readonly` (the
"see, edit, share and permanently delete all your calendars" class). OpenPong
does not request those, so the CASA bar does not apply. Verification of the
sensitive scopes is a documentation and demo review, not a security audit.

After verification, the environment variables in Lane A are the only thing you
set, and users just click **Allow** and are done.

### The scopes we request

OpenPong asks for exactly these three and no more:

- `https://www.googleapis.com/auth/calendar.app.created`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.events.readonly`

There is no Gmail scope and no write scope for the person's own calendars.

---

## A server with no Google app

Every part of OpenPong must work without a Google app:

- `GET /api/google/status` reports `configured: false`, from the API and in the
  dashboard.
- The dashboard shows no connect button (never a dead one): it says the server
  has no Google app, and offers the **private iCal link**, which publishes the
  Pong calendar to any calendar app. That link is write-only — it cannot be
  read back, so the coach cannot use the calendars as context without Google.
- Google sign-in (`docs/SETUP.md`) is separate and needs its own client; it is
  identity only and never asks for a calendar scope.

---

## Why not Google's Calendar MCP server as the default

OpenPong can read the owner's calendar over Google's own Calendar MCP server,
but that path cannot be the public default:

- It requires membership in the Google Workspace **Developer Preview Program**
  plus a Google Cloud project per deployment.
- It is still **Developer Preview**: Google can change it without notice.

That is too much to ask of a self-hoster and impossible to pre-configure for a
stranger. The MCP connection stays an opt-in power feature for people who
already have that access; the default remains the three-scope OAuth consent
above.

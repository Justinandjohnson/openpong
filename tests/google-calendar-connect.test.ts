import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

/** A synthetic Google client: enough for the server to start a consent. */
const GOOGLE = {
  googleClientId: "synthetic-client",
  googleClientSecret: "synthetic-secret",
  encryptionKey: randomBytes(32).toString("base64"),
};

/** The three scopes the one-button calendar connect must ask for, exactly. */
const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

async function fixture(t: TestContext, overrides: Partial<Config> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openpong-google-connect-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    ...overrides,
  };
  const server = await createApp(db, config);
  t.after(async () => {
    server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, db, config };
}

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

test("status with no Google app is honest and is not an error", async (t) => {
  const f = await fixture(t);
  const { token } = await f.auth.session();
  const response = await f.app.request("/api/google/status", { headers: bearer(token) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false, connected: false, calendars: 0 });
});

test("status with a Google app but no connection reports configured, not connected", async (t) => {
  const f = await fixture(t, { ...GOOGLE });
  const { token } = await f.auth.session();
  const response = await f.app.request("/api/google/status", { headers: bearer(token) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: true, connected: false, calendars: 0 });
});

test("connect asks for exactly the three calendar scopes", async (t) => {
  const f = await fixture(t, { ...GOOGLE });
  const { token } = await f.auth.session();
  const response = await f.app.request("/api/google/calendar/connect", {
    method: "POST",
    headers: bearer(token),
    body: "{}",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { url?: string };
  assert.ok(body.url, "expected a Google consent URL");
  const scopes = (new URL(body.url).searchParams.get("scope") ?? "").split(" ").filter(Boolean);
  // Exact-match the space-separated list, so a substring like `calendar.events`
  // (a prefix of `calendar.events.readonly`) can never pass unnoticed.
  assert.deepEqual([...scopes].sort(), [...CALENDAR_SCOPES].sort());
  // A person pressing "Connect Google" for a calendar hands over no inbox and no
  // write access to their own events.
  assert.equal(
    scopes.some((scope) => scope.includes("gmail")),
    false,
  );
  assert.equal(scopes.includes("https://www.googleapis.com/auth/calendar.events"), false);
});

test("connect is a no-op that reports connected when Google already is", async (t) => {
  const f = await fixture(t, { ...GOOGLE });
  assert.ok(f.config.encryptionKey);
  await f.db.put("local-user", "credentials", {
    id: "google",
    connectionId: "existing-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "existing-connection",
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + 3_600_000,
        scopes: [CALENDAR_SCOPES[2]],
        account: "player@example.com",
      }),
      f.config.encryptionKey,
    ),
  });
  const { token } = await f.auth.session();
  const response = await f.app.request("/api/google/calendar/connect", {
    method: "POST",
    headers: bearer(token),
    body: "{}",
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { connected?: boolean; url?: string };
  assert.equal(body.connected, true);
  assert.equal(body.url, undefined);
});

test("connect with no Google app refuses honestly instead of a dead button", async (t) => {
  const f = await fixture(t);
  const { token } = await f.auth.session();
  const response = await f.app.request("/api/google/calendar/connect", {
    method: "POST",
    headers: bearer(token),
    body: "{}",
  });
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /no Google app configured/i);
  assert.match(body.error, /private calendar link/i);
});

test("the calendar callback lands on the dashboard exactly once", async (t) => {
  const f = await fixture(t, { ...GOOGLE });
  const { token } = await f.auth.session();
  const started = await f.app.request("/api/google/calendar/connect", {
    method: "POST",
    headers: bearer(token),
    body: "{}",
  });
  const { url } = (await started.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const target = String(input);
    if (target.includes("oauth2.googleapis.com/token"))
      return Response.json({
        access_token: "synthetic-callback-access",
        refresh_token: "synthetic-callback-refresh",
        expires_in: 3600,
        scope: CALENDAR_SCOPES.join(" "),
      });
    // A calendar-only grant must not reach for Gmail.
    throw new Error(`Unexpected fetch during the callback: ${target}`);
  });

  const connected = await f.app.request(
    `/api/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`,
  );
  assert.equal(connected.status, 302);
  assert.equal(
    connected.headers.get("location"),
    "http://localhost:8081/calendar?google=connected",
  );

  // The state is one-shot: a replay lands on the dashboard with a short reason
  // and never a token.
  const replay = await f.app.request(
    `/api/google/callback?state=${encodeURIComponent(state)}&code=synthetic-code`,
  );
  assert.equal(replay.status, 302);
  const location = replay.headers.get("location") ?? "";
  assert.match(location, /^http:\/\/localhost:8081\/calendar\?google=error&reason=/);
  assert.equal(location.includes("synthetic-callback-access"), false);
});

test("a bad callback state redirects with a short reason and no token", async (t) => {
  const f = await fixture(t, { ...GOOGLE });
  const response = await f.app.request("/api/google/callback?state=unknown&code=synthetic-code");
  assert.equal(response.status, 302);
  const location = response.headers.get("location") ?? "";
  assert.match(location, /^http:\/\/localhost:8081\/calendar\?google=error&reason=/);
  assert.equal(location.toLowerCase().includes("token"), false);
  assert.equal(location.includes("synthetic-code"), false);
});

test("the callback returns to the dashboard the config names, not a stale dev origin", async (t) => {
  const f = await fixture(t, {
    ...GOOGLE,
    allowedOrigins: ["http://localhost:8081", "http://localhost:3000"],
    publicAppUrl: "https://app.example.com",
  });
  const response = await f.app.request("/api/google/callback?state=unknown&code=synthetic-code");
  assert.equal(response.status, 302);
  const location = response.headers.get("location") ?? "";
  assert.match(location, /^https:\/\/app\.example\.com\/calendar\?google=error&reason=/);
});

test("without a dashboard origin the callback keeps a server response", async (t) => {
  const f = await fixture(t, { ...GOOGLE, allowedOrigins: [] });
  const response = await f.app.request("/api/google/callback?state=unknown&code=synthetic-code");
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /expired|incomplete/i);
});

/** Seed a Google connection without going through a consent. */
async function seedConnection(f: Awaited<ReturnType<typeof fixture>>, expiresAt: number) {
  assert.ok(f.config.encryptionKey);
  await f.db.put("local-user", "credentials", {
    id: "google",
    connectionId: "seeded-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "seeded-connection",
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt,
        scopes: [CALENDAR_SCOPES[2]],
        account: "player@example.com",
      }),
      f.config.encryptionKey,
    ),
  });
}

test("a live connection reports connected", async (t) => {
  const f = await fixture(t, { ...GOOGLE });
  await seedConnection(f, Date.now() + 3_600_000);
  const { token } = await f.auth.session();
  const response = await f.app.request("/api/google/status", { headers: bearer(token) });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { connected: boolean; needsReconnect?: boolean };
  assert.equal(body.connected, true);
  assert.equal(body.needsReconnect, undefined);
});

test("a connection whose token no longer works says reconnect, not connected", async (t) => {
  const f = await fixture(t, { ...GOOGLE });
  // Expired access token and a refresh grant Google now rejects: exactly what a
  // Testing-status app does to everyone on day eight.
  await seedConnection(f, Date.now() - 1_000);
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
  const { token } = await f.auth.session();
  const response = await f.app.request("/api/google/status", { headers: bearer(token) });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    connected: boolean;
    needsReconnect?: boolean;
    calendars: number;
  };
  assert.equal(body.connected, false);
  assert.equal(body.needsReconnect, true);
  assert.equal(body.calendars, 0);
});

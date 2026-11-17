import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

type App = Awaited<ReturnType<typeof createApp>>;
type Account = { id: string; email: string; displayName: string };

let directory: string;
let db: Store;
let multi: App;
let unconfigured: App;
let legacy: App;

const dashboard = "http://localhost:3000";
const baseConfig = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "sample",
  allowedOrigins: ["http://localhost:3000"],
  googleRedirectUri: "http://localhost:8787/api/google/callback",
});
const googleConfig = (dataDir: string): Config => ({
  ...baseConfig(dataDir),
  googleClientId: "synthetic-client-id",
  googleClientSecret: "synthetic-client-secret",
});

const authHeader = (token?: string) =>
  token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>);

async function post(app: App, path: string, body: unknown, token?: string): Promise<Response> {
  return app.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader(token) },
    body: JSON.stringify(body),
  });
}

const googleUser = {
  sub: "google-sub-1",
  email: "alex@example.com",
  email_verified: true,
  name: "Alex Pong",
};

/** Stub only the two Google endpoints; any other outbound call is a test bug. */
function stubGoogle(t: TestContext, user = googleUser, tokenStatus = 200) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("oauth2.googleapis.com/token")) {
      if (tokenStatus !== 200)
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: tokenStatus });
      return Response.json({
        access_token: "identity-access-token",
        id_token: "identity-id-token",
        refresh_token: "identity-refresh-token",
        expires_in: 3600,
        scope: "openid email profile",
      });
    }
    if (url.includes("openidconnect.googleapis.com/v1/userinfo")) return Response.json(user);
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  return calls;
}

/** Start a sign-in and return the authorize URL's query values. */
async function authorize(app: App, redirectBase = dashboard) {
  const response = await post(app, "/api/auth/google/start", { redirectBase });
  assert.equal(response.status, 200, await response.clone().text());
  const { url } = (await response.json()) as { url: string };
  const parsed = new URL(url);
  const state = parsed.searchParams.get("state");
  assert.ok(state, "the authorize URL must carry a signed state");
  return { parsed, state };
}

/** Drive the callback with a state and code, returning the one-time code. */
async function callback(app: App, state: string, code = "synthetic-code") {
  const response = await app.app.request(
    `/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
  return response;
}

function oneTimeFrom(response: Response): string {
  assert.equal(response.status, 302, "the callback must redirect to the dashboard");
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.pathname, "/login/google");
  const code = location.searchParams.get("code");
  assert.ok(code, "the callback must hand back a one-time code");
  return code;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openpong-google-"));
  db = await createStore({ dataDir: join(directory, "db") });
  process.env.MULTI_TENANT = "true";
  multi = await createApp(db, googleConfig(directory));
  unconfigured = await createApp(db, baseConfig(directory));
  delete process.env.MULTI_TENANT;
  legacy = await createApp(db, baseConfig(directory));
});

after(async () => {
  delete process.env.MULTI_TENANT;
  await multi?.agent?.stop();
  await unconfigured?.agent?.stop();
  await legacy?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("start returns a Google URL with the identity scopes and a signed state", async () => {
  const { parsed, state } = await authorize(multi);
  assert.equal(parsed.origin, "https://accounts.google.com");
  assert.equal(parsed.pathname, "/o/oauth2/v2/auth");
  assert.equal(parsed.searchParams.get("client_id"), "synthetic-client-id");
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(
    parsed.searchParams.get("redirect_uri"),
    "http://localhost:8787/api/auth/google/callback",
  );
  assert.deepEqual(parsed.searchParams.get("scope")?.split(" ").sort(), [
    "email",
    "openid",
    "profile",
  ]);
  // Identity only: no calendar or Gmail scope, and no offline/consent prompt.
  const scope = parsed.searchParams.get("scope") ?? "";
  assert.equal(/calendar|gmail/.test(scope), false);
  assert.equal(parsed.searchParams.get("access_type"), null);
  assert.equal(parsed.searchParams.get("prompt"), null);
  // The state is opaque to the browser but carries the origin and an expiry.
  const decoded = multi.auth.verifyPayload<{ redirectBase: string; expiresAt: number }>(state);
  assert.equal(decoded?.redirectBase, dashboard);
  assert.ok((decoded?.expiresAt ?? 0) > Date.now() + 9 * 60 * 1000);
});

test("start is 503 when Google is unconfigured and 403 when accounts are off", async () => {
  const denied = await post(unconfigured, "/api/auth/google/start", { redirectBase: dashboard });
  assert.equal(denied.status, 503, await denied.clone().text());
  assert.equal(
    ((await denied.json()) as { error: string }).error,
    "Google sign-in is not configured on this server.",
  );

  const singleOwner = await post(legacy, "/api/auth/google/start", { redirectBase: dashboard });
  assert.equal(singleOwner.status, 403, await singleOwner.clone().text());
  assert.match(((await singleOwner.json()) as { error: string }).error, /Accounts are not enabled/);
});

test("start refuses a dashboard origin that is not on the allowlist", async () => {
  // An unlisted origin would receive the one-time code in the redirect, so a
  // stranger must never be able to ask for it.
  const stolen = await post(multi, "/api/auth/google/start", {
    redirectBase: "https://attacker.example",
  });
  assert.equal(stolen.status, 403, await stolen.clone().text());
  assert.match(
    ((await stolen.json()) as { error: string }).error,
    /not allowed to sign in/,
  );
});

test("callback rejects a tampered state and redirects an expired one", async () => {
  const { state } = await authorize(multi);
  const tampered = `${state.slice(0, -2)}xx`;
  const rejected = await callback(multi, tampered);
  assert.equal(rejected.status, 400, await rejected.clone().text());
  assert.match(((await rejected.json()) as { error: string }).error, /could not be verified/i);

  // A correctly signed but past-expiry state is a known dashboard, so it is told
  // why via a safe redirect rather than a bare 400.
  const expired = multi.auth.signPayload({
    redirectBase: dashboard,
    nonce: "expired-nonce",
    expiresAt: Date.now() - 1,
  });
  const expiredResponse = await callback(multi, expired);
  assert.equal(expiredResponse.status, 302, await expiredResponse.clone().text());
  const location = new URL(expiredResponse.headers.get("location") ?? "");
  assert.equal(location.origin, dashboard);
  assert.equal(location.pathname, "/login");
  assert.match(location.searchParams.get("error") ?? "", /expired/i);
});

test("callback creates the account once and reuses it on a second sign-in", async (t) => {
  stubGoogle(t);

  const first = await authorize(multi);
  const firstCode = oneTimeFrom(await callback(multi, first.state));
  const firstExchange = await post(multi, "/api/auth/google/exchange", { code: firstCode });
  assert.equal(firstExchange.status, 200, await firstExchange.clone().text());
  const firstBody = (await firstExchange.json()) as { token: string; account: Account };
  assert.equal(firstBody.account.email, "alex@example.com");
  assert.equal(firstBody.account.displayName, "Alex Pong");
  // The exchange returns exactly the login shape, never the hash or token material.
  assert.deepEqual(Object.keys(firstBody.account).sort(), ["displayName", "email", "id"]);

  const second = await authorize(multi);
  const secondCode = oneTimeFrom(await callback(multi, second.state));
  const secondExchange = await post(multi, "/api/auth/google/exchange", { code: secondCode });
  assert.equal(secondExchange.status, 200, await secondExchange.clone().text());
  const secondBody = (await secondExchange.json()) as { token: string; account: Account };
  assert.equal(secondBody.account.id, firstBody.account.id, "the same email maps to one account");

  // One account row, keyed by the normalised email, and no password ever set.
  const row = await db.get<{ id: string; passwordHash: string; email: string }>(
    "system",
    "account",
    "alex@example.com",
  );
  assert.equal(row?.id, firstBody.account.id);
  assert.equal(row?.passwordHash, "");
  // The password login path stays closed to an OAuth-only account.
  const passwordLogin = await post(multi, "/api/auth/login", {
    email: "alex@example.com",
    password: "any-password-at-all",
  });
  assert.equal(passwordLogin.status, 401, await passwordLogin.clone().text());
});

test("the one-time code is single-use and expires", async (t) => {
  stubGoogle(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });

  const { state } = await authorize(multi);
  const code = oneTimeFrom(await callback(multi, state));

  const first = await post(multi, "/api/auth/google/exchange", { code });
  assert.equal(first.status, 200, await first.clone().text());
  const replay = await post(multi, "/api/auth/google/exchange", { code });
  assert.equal(replay.status, 401, await replay.clone().text());
  const unknown = await post(multi, "/api/auth/google/exchange", { code: "not-a-real-code" });
  assert.equal(unknown.status, 401, await unknown.clone().text());

  // The 60-second window is the only thing a slow hand-off can rely on.
  const fresh = await authorize(multi);
  const expiring = oneTimeFrom(await callback(multi, fresh.state));
  t.mock.timers.setTime(now + 61_000);
  const stale = await post(multi, "/api/auth/google/exchange", { code: expiring });
  assert.equal(stale.status, 401, await stale.clone().text());
  t.mock.timers.reset();
});

test("exchange returns a token that authenticates a subsequent authed request", async (t) => {
  stubGoogle(t, { ...googleUser, sub: "google-sub-token", email: "token.user@example.com" });
  const { state } = await authorize(multi);
  const code = oneTimeFrom(await callback(multi, state));
  const exchange = await post(multi, "/api/auth/google/exchange", { code });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const { token } = (await exchange.json()) as { token: string };
  assert.ok(token);

  const profile = await multi.app.request("/api/agent/profile", { headers: authHeader(token) });
  assert.equal(profile.status, 200, await profile.clone().text());
  assert.deepEqual(await profile.json(), { profile: null, onboarded: false });
  // The same token identifies the account on /api/auth/me.
  const me = await multi.app.request("/api/auth/me", { headers: authHeader(token) });
  assert.equal(me.status, 200, await me.clone().text());
  assert.equal(((await me.json()) as { account: Account }).account.email, "token.user@example.com");
});

test("the audit trail records google_signup then google_login with no token material", async (t) => {
  stubGoogle(t, { ...googleUser, sub: "google-sub-audit", email: "audit.google@example.com" });
  const first = await authorize(multi);
  const firstCode = oneTimeFrom(await callback(multi, first.state));
  const created = (await (
    await post(multi, "/api/auth/google/exchange", { code: firstCode })
  ).json()) as { account: Account };
  const second = await authorize(multi);
  const secondCode = oneTimeFrom(await callback(multi, second.state));
  await post(multi, "/api/auth/google/exchange", { code: secondCode });

  const trail = await db.list<{ event: string; email?: string; at: string }>(
    created.account.id,
    "audit",
  );
  assert.deepEqual(trail.map((entry) => entry.event).sort(), ["google_login", "google_signup"]);
  assert.ok(trail.every((entry) => entry.email === "audit.google@example.com"));
  const serialized = JSON.stringify(trail);
  for (const secret of [
    "identity-access-token",
    "identity-id-token",
    "identity-refresh-token",
    "synthetic-client-secret",
    "synthetic-code",
  ])
    assert.ok(!serialized.includes(secret), `audit must not contain ${secret}`);
});

test("a Google exchange failure redirects the dashboard with a short safe error", async (t) => {
  stubGoogle(t, { ...googleUser, sub: "google-sub-fail", email: "never.created@example.com" }, 400);
  const { state } = await authorize(multi);
  const response = await callback(multi, state);
  assert.equal(response.status, 302, await response.clone().text());
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.pathname, "/login");
  assert.match(location.searchParams.get("error") ?? "", /could not complete/i);
  // No account row is created for a failed exchange.
  assert.equal(await db.get("system", "account", "never.created@example.com"), null);
});

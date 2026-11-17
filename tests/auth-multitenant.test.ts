import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

type App = Awaited<ReturnType<typeof createApp>>;

let directory: string;
let db: Store;
let multi: App;
let legacy: App;

const baseConfig = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "sample",
  allowedOrigins: [],
  googleRedirectUri: "http://localhost:8787/api/google/callback",
});

const auth = (token?: string) =>
  token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>);

async function post(app: App, path: string, body: unknown, token?: string): Promise<Response> {
  return app.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(token) },
    body: JSON.stringify(body),
  });
}

async function signup(
  app: App,
  email: string,
  password = "a-long-enough-password",
  displayName?: string,
) {
  const response = await post(app, "/api/auth/signup", { email, password, displayName });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<{ token: string; account: Account }>;
}

interface Account {
  id: string;
  email: string;
  displayName: string;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openpong-multi-tenant-"));
  db = await createStore({ dataDir: join(directory, "db") });
  process.env.MULTI_TENANT = "true";
  multi = await createApp(db, baseConfig(directory));
  // The legacy app decides its mode at boot too; one DB is enough to prove both
  // coexist without sharing an owner.
  delete process.env.MULTI_TENANT;
  legacy = await createApp(db, baseConfig(directory));
});

after(async () => {
  delete process.env.MULTI_TENANT;
  await multi?.agent?.stop();
  await legacy?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("multi-tenant mode closes the shared access-key session", async () => {
  const response = await post(multi, "/api/session", {});
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Accounts are enabled/);
  assert.equal(await db.get("local-user", "settings", "seeded"), null);
});

test("signup returns a working token and /api/auth/me returns the account", async () => {
  const { token, account } = await signup(multi, "player.one@example.com", undefined, "Player One");
  assert.equal(account.email, "player.one@example.com");
  assert.equal(account.displayName, "Player One");
  assert.match(account.id, /^[0-9a-f-]{36}$/);

  const me = await multi.app.request("/api/auth/me", { headers: auth(token) });
  assert.equal(me.status, 200, await me.clone().text());
  assert.deepEqual((await me.json()).account, account);

  const profile = await multi.app.request("/api/agent/profile", { headers: auth(token) });
  assert.equal(profile.status, 200, await profile.clone().text());
  assert.deepEqual(await profile.json(), { profile: null, onboarded: false });
  assert.equal((await multi.app.request("/api/agent/profile")).status, 401);
});

test("two accounts cannot see each other's agent profile", async () => {
  const first = await signup(multi, "isolation.one@example.com");
  const second = await signup(multi, "isolation.two@example.com");
  assert.notEqual(first.account.id, second.account.id);

  const saved = await multi.app.request("/api/agent/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...auth(first.token) },
    body: JSON.stringify({ displayName: "First Only", homeRegion: "Munich" }),
  });
  assert.equal(saved.status, 200, await saved.clone().text());

  const mine = await multi.app.request("/api/agent/profile", { headers: auth(first.token) });
  const mineBody = await mine.json();
  assert.equal(mineBody.onboarded, true);
  assert.equal(mineBody.profile.id, "profile");
  assert.equal(mineBody.profile.displayName, "First Only");
  assert.equal(mineBody.profile.homeRegion, "Munich");
  assert.ok(Date.parse(mineBody.profile.updatedAt));
  const theirs = await multi.app.request("/api/agent/profile", { headers: auth(second.token) });
  assert.deepEqual(await theirs.json(), { profile: null, onboarded: false });
  assert.equal(await db.get(second.account.id, "agent-settings", "profile"), null);
});

test("logout revokes the token immediately", async () => {
  const { token } = await signup(multi, "logout@example.com");
  assert.equal((await multi.app.request("/api/auth/me", { headers: auth(token) })).status, 200);
  const logout = await post(multi, "/api/auth/logout", {}, token);
  assert.equal(logout.status, 200, await logout.clone().text());
  assert.equal((await multi.app.request("/api/auth/me", { headers: auth(token) })).status, 401);
  assert.equal(
    (await multi.app.request("/api/agent/profile", { headers: auth(token) })).status,
    401,
  );
  assert.equal((await post(multi, "/api/auth/logout", {}, token)).status, 401);
});

test("login mints a fresh session, rejects a wrong password, and rate-limits with Retry-After", async () => {
  const { account } = await signup(multi, "login.route@example.com", "a-long-enough-password");
  const wrong = await post(multi, "/api/auth/login", {
    email: account.email,
    password: "definitely-not-it",
  });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "Email or password is incorrect");

  const right = await post(multi, "/api/auth/login", {
    email: "LOGIN.ROUTE@example.com",
    password: "a-long-enough-password",
  });
  assert.equal(right.status, 200, await right.clone().text());
  const { token, account: again } = await right.json();
  assert.deepEqual(again, account);
  assert.equal(
    (await multi.app.request("/api/agent/profile", { headers: auth(token) })).status,
    200,
  );

  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal(
      (
        await post(multi, "/api/auth/login", {
          email: account.email,
          password: "wrong-password",
        })
      ).status,
      401,
    );
  const limited = await post(multi, "/api/auth/login", {
    email: account.email,
    password: "a-long-enough-password",
  });
  assert.equal(limited.status, 429, await limited.clone().text());
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

test("password change requires the old password and the new one is what logs in", async () => {
  const { account, token } = await signup(multi, "password.route@example.com", "original-password");
  const denied = await post(
    multi,
    "/api/auth/password",
    { oldPassword: "not-the-original", newPassword: "replacement-password" },
    token,
  );
  assert.equal(denied.status, 401);
  assert.equal(
    (
      await post(
        multi,
        "/api/auth/password",
        { oldPassword: "original-password", newPassword: "replacement-password" },
        token,
      )
    ).status,
    200,
  );
  for (const [password, status] of [
    ["original-password", 401],
    ["replacement-password", 200],
  ] as const) {
    const response = await post(multi, "/api/auth/login", { email: account.email, password });
    assert.equal(response.status, status, await response.clone().text());
  }
});

test("sessions slide forward while active and a deleted account is rejected", async () => {
  const { token } = await signup(multi, "sliding@example.com");
  const id = createHash("sha256").update(token).digest("hex");
  type SessionRow = {
    id: string;
    owner: string;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
  };
  const before = await db.get<SessionRow>("system", "sessions", id);
  assert.ok(before);
  const nearExpiry = Date.now() + 60 * 60 * 1000;
  await db.put("system", "sessions", {
    ...before,
    expiresAt: nearExpiry,
    lastSeenAt: Date.now() - 10 * 60 * 1000,
  });
  assert.equal((await multi.app.request("/api/auth/me", { headers: auth(token) })).status, 200);
  const after = await db.get<SessionRow>("system", "sessions", id);
  assert.ok(after);
  assert.ok(after.expiresAt > nearExpiry + 20 * 60 * 60 * 1000, "expiry moved a day out");
  assert.ok(after.lastSeenAt > before.lastSeenAt, "activity was recorded");

  // A session whose account vanished can never come back, even if the row survives.
  const doomed = await signup(multi, "removed@example.com");
  const doomedId = createHash("sha256").update(doomed.token).digest("hex");
  await db.remove("system", "account", doomed.account.email);
  await db.remove("system", "account-id", doomed.account.id);
  assert.equal(
    (await multi.app.request("/api/auth/me", { headers: auth(doomed.token) })).status,
    401,
  );
  assert.equal(await db.get("system", "sessions", doomedId), null);
});

test("with MULTI_TENANT unset the single-owner flow is unchanged", async () => {
  const session = await post(legacy, "/api/session", {});
  assert.equal(session.status, 200, await session.clone().text());
  const { token } = await session.json();
  assert.equal(
    (await legacy.app.request("/api/agent/profile", { headers: auth(token) })).status,
    200,
  );
  assert.ok(await db.get("local-user", "agent-settings", "identity"));
  // Account routes are not mounted: the existing `/api/*` gate answers 401, and
  // no account row can be created through the legacy app.
  const unmounted = await post(legacy, "/api/auth/signup", {
    email: "x@example.com",
    password: "a-long-enough-password",
  });
  assert.equal(unmounted.status, 401);
  assert.equal(await db.get("system", "account", "x@example.com"), null);
  assert.equal(
    (
      await post(legacy, "/api/auth/login", {
        email: "x@example.com",
        password: "a-long-enough-password",
      })
    ).status,
    401,
  );
  assert.equal((await legacy.app.request("/api/auth/me", { headers: auth(token) })).status, 404);
});

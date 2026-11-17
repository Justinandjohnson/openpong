import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type AccountRecord,
  AccountService,
  LoginRateLimitError,
} from "../apps/server/src/accounts.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";

let directory: string;
let db: Store;
let accounts: AccountService;

const password = "correct-horse-battery";
const context = { ip: "203.0.113.7", userAgent: "openpong-test/1.0" };

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openpong-accounts-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
  };
  accounts = new AccountService(db, config);
});

after(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("signup validates email shape, normalises it, and enforces a 10-character password", async () => {
  for (const email of [
    "",
    "not-an-email",
    "a@b",
    "two words@example.com",
    `${"a".repeat(250)}@x.io`,
  ])
    await assert.rejects(
      accounts.signup(email, password),
      (error: unknown) => error instanceof AppError && error.status === 400,
      email,
    );
  await assert.rejects(
    accounts.signup("short@example.com", "nine-char"),
    (error: unknown) => error instanceof AppError && error.status === 400,
  );
  const account = await accounts.signup("  Mixed.Case@Example.COM ", password, "  Mixed Case ");
  assert.equal(account.email, "mixed.case@example.com");
  assert.equal(account.displayName, "Mixed Case");
  // The public shape never carries the hash.
  assert.deepEqual(Object.keys(account).sort(), ["displayName", "email", "id"]);
  assert.equal((await accounts.byEmail("MIXED.CASE@example.com"))?.id, account.id);
});

test("signup rejects a duplicate email with 409, including case variants", async () => {
  const account = await accounts.signup("duplicate@example.com", password);
  await assert.rejects(
    accounts.signup("Duplicate@Example.com", "another-good-password"),
    (error: unknown) => error instanceof AppError && error.status === 409,
  );
  assert.equal((await accounts.byEmail("duplicate@example.com"))?.id, account.id);
});

test("the stored password hash uses the documented scrypt format and a unique salt", async () => {
  await accounts.signup("hash@example.com", password);
  const first = await db.get<AccountRecord>("system", "account", "hash@example.com");
  assert.ok(first);
  assert.match(first.passwordHash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  const [scheme, N, r, p, salt, hash] = first.passwordHash.split("$");
  assert.deepEqual([scheme, N, r, p], ["scrypt", "32768", "8", "1"]);
  assert.equal(Buffer.from(salt, "base64url").length, 16);
  assert.equal(Buffer.from(hash, "base64url").length, 32);
  assert.ok(!first.passwordHash.includes(password), "the hash must never contain the password");

  await accounts.signup("hash-two@example.com", password);
  const second = await db.get<AccountRecord>("system", "account", "hash-two@example.com");
  assert.ok(second);
  assert.notEqual(second.passwordHash, first.passwordHash, "a fresh salt changes the hash");
});

test("two accounts get distinct UUID owners and cannot read each other's records", async () => {
  const first = await accounts.signup("first@example.com", password);
  const second = await accounts.signup("second@example.com", password);
  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.match(second.id, /^[0-9a-f-]{36}$/);

  await db.put(first.id, "notes", { id: "private", text: "only mine" });
  assert.deepEqual(await db.get(first.id, "notes", "private"), {
    id: "private",
    text: "only mine",
  });
  assert.equal(await db.get(second.id, "notes", "private"), null);

  // The shared directory lives under the reserved scope, never under an owner id.
  assert.equal(await db.get(first.id, "account", "second@example.com"), null);
  assert.equal(
    (await db.get("system", "account", "second@example.com"))?.email,
    "second@example.com",
  );
  assert.deepEqual(await db.get("system", "account-id", second.id), {
    id: second.id,
    email: "second@example.com",
  });
  assert.equal((await accounts.get(first.id))?.email, "first@example.com");
  assert.equal((await accounts.get(second.id))?.email, "second@example.com");
});

test("login succeeds with the right password and fails generically with the wrong one", async () => {
  const account = await accounts.signup("login@example.com", password, "Login Person");
  assert.deepEqual(await accounts.login("LOGIN@example.com", password), account);
  for (const [email, candidate] of [
    ["login@example.com", "wrong-password"],
    ["missing@example.com", password],
  ] as const)
    await assert.rejects(
      accounts.login(email, candidate),
      (error: unknown) =>
        error instanceof AppError &&
        error.status === 401 &&
        error.message === "Email or password is incorrect",
    );
});

test("password change requires the current password and swaps the credential", async () => {
  const account = await accounts.signup("change@example.com", password);
  const next = "an-entirely-new-password";
  await assert.rejects(
    accounts.changePassword(account.id, "not-the-old-one", next),
    (error: unknown) =>
      error instanceof AppError &&
      error.status === 401 &&
      error.message === "Current password is incorrect",
  );
  await assert.rejects(
    accounts.changePassword(account.id, password, "too-short"),
    (error: unknown) => error instanceof AppError && error.status === 400,
  );
  assert.deepEqual(await accounts.changePassword(account.id, password, next), account);
  await assert.rejects(accounts.login("change@example.com", password));
  assert.deepEqual(await accounts.login("change@example.com", next), account);
  await assert.rejects(
    accounts.changePassword("missing-account", password, next),
    (error: unknown) => error instanceof AppError && error.status === 404,
  );
});

test("the login limiter returns 429 with a retry hint after five bad attempts", async () => {
  const email = "locked@example.com";
  await accounts.signup(email, password);
  for (let attempt = 0; attempt < 5; attempt++)
    await assert.rejects(accounts.login(email, "wrong-password", context));
  await assert.rejects(
    accounts.login(email, "wrong-password", context),
    (error: unknown) =>
      error instanceof LoginRateLimitError &&
      error.status === 429 &&
      error.retryAfterSeconds >= 1 &&
      error.retryAfterSeconds <= 5 * 60,
  );
  // The correct password is also refused while the window is open.
  await assert.rejects(
    accounts.login(email, password, context),
    (error: unknown) => error instanceof LoginRateLimitError,
  );
  // A different email (or IP) has its own bucket.
  await accounts.signup("free@example.com", password);
  assert.ok(await accounts.login("free@example.com", password, context));
});

test("a successful login clears the failure window", async () => {
  const email = "clears@example.com";
  await accounts.signup(email, password);
  for (let attempt = 0; attempt < 4; attempt++)
    await assert.rejects(accounts.login(email, "wrong-password", context));
  await accounts.login(email, password, context);
  for (let attempt = 0; attempt < 4; attempt++)
    await assert.rejects(accounts.login(email, "wrong-password", context));
  // Five more would be needed to lock; the clear reset the count.
  await assert.rejects(
    accounts.login(email, "wrong-password", context),
    (error: unknown) => error instanceof AppError && error.status === 401,
  );
});

test("the audit trail records lifecycle events without passwords or tokens", async () => {
  const email = "audit@example.com";
  const account = await accounts.signup(email, password, "Audit Person", context);
  await accounts.login(email, password, context);
  await assert.rejects(accounts.login(email, "wrong-password", context));
  await accounts.changePassword(account.id, password, "another-long-password", context);
  await accounts.audit(account.id, "logout", context);

  const trail = await db.list<{ event: string; email?: string; at: string }>(account.id, "audit");
  assert.deepEqual(trail.map((entry) => entry.event).sort(), [
    "login",
    "login_failed",
    "logout",
    "password_change",
    "signup",
  ]);
  assert.ok(trail.every((entry) => entry.email === email && !Number.isNaN(Date.parse(entry.at))));
  const serialized = JSON.stringify(trail);
  for (const secret of [password, "another-long-password", "passwordHash", "token"])
    assert.ok(!serialized.includes(secret), `audit must not contain ${secret}`);

  // An attempt against an unknown email is still auditable, without an account id.
  await assert.rejects(accounts.login("ghost@example.com", "wrong-password", context));
  const failures = await db.list<{ event: string; email?: string }>("system", "audit");
  assert.ok(
    failures.some((entry) => entry.event === "login_failed" && entry.email === "ghost@example.com"),
  );
});

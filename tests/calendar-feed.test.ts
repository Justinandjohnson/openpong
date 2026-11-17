import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import { createApp } from "../apps/server/src/app.ts";
import { calendarFeedHandler } from "../apps/server/src/calendar/routes.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, server: Awaited<ReturnType<typeof createApp>>, directory: string, token: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pong-calendar-feed-"));
  db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    // Feed tokens are signed with this key; Google creds are deliberately absent
    // so the owner uses the iCal path.
    encryptionKey: "synthetic-token-encryption-key-32b",
  };
  server = await createApp(db, config);
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  token = (await session.json()).token;
  // The one line that app.ts will add, before its /api/* session middleware.
  const publicFeed = new Hono();
  publicFeed.get("/api/calendar/feed/*", calendarFeedHandler(server.agent.calendar));
  feedApp = publicFeed;
});

let feedApp = new Hono();

after(async () => {
  await server?.agent?.stop();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

function feedToken(feedUrl: string): string {
  const file = new URL(feedUrl).pathname.split("/").at(-1) ?? "";
  return file.replace(/\.ics$/, "");
}

test("a valid token returns 200 text/calendar with the Pong ICS", async () => {
  await server.agent.calendar.upsert("local-user", [
    {
      pongKey: "custom:feed-test",
      title: "Feed test practice",
      start: "2026-11-20",
      end: "2026-11-21",
      allDay: true,
      kind: "custom",
    },
  ]);
  const status = await server.app.request("/api/agent/calendar", { headers: auth() });
  assert.equal(status.status, 200);
  const state = await status.json();
  assert.equal(state.provider, "ics");
  assert.equal(state.connected, true);
  assert.ok(typeof state.feedUrl === "string");

  const response = await feedApp.request(new URL(state.feedUrl).pathname);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/calendar/);
  const ics = await response.text();
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.includes("PRODID:-//OpenPong//Pong Calendar//EN"));
  assert.ok(ics.includes("UID:custom:feed-test@openpong"));
  assert.ok(ics.includes("SUMMARY:Feed test practice"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});

test("a tampered token is rejected with 403", async () => {
  const status = await server.app.request("/api/agent/calendar", { headers: auth() });
  const { feedUrl } = await status.json();
  const good = feedToken(feedUrl);
  const last = good.at(-1);
  const tampered = `${good.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  const response = await feedApp.request(`/api/calendar/feed/${tampered}.ics`);
  assert.equal(response.status, 403);
  assert.equal((await response.text()).includes("BEGIN:VCALENDAR"), false);

  // A syntactically plausible but unsigned token is rejected too.
  assert.equal(
    (await feedApp.request("/api/calendar/feed/bG9jYWwtdXNlcg.not-a-signature.ics")).status,
    403,
  );
});

test("rotating the feed link rejects the old token and accepts the new one", async () => {
  const status = await server.app.request("/api/agent/calendar", { headers: auth() });
  const before = feedToken((await status.json()).feedUrl);

  const rotated = await server.app.request("/api/agent/calendar/feed/rotate", {
    method: "POST",
    headers: auth(),
  });
  assert.equal(rotated.status, 200);
  const { feedUrl } = await rotated.json();
  const after_ = feedToken(feedUrl);
  assert.notEqual(after_, before);

  assert.equal((await feedApp.request(`/api/calendar/feed/${before}.ics`)).status, 403);
  const fresh = await feedApp.request(`/api/calendar/feed/${after_}.ics`);
  assert.equal(fresh.status, 200);
  assert.ok((await fresh.text()).includes("BEGIN:VCALENDAR"));
});

test("disconnect revokes the current link and the calendar routes stay owner-scoped", async () => {
  const status = await server.app.request("/api/agent/calendar", { headers: auth() });
  const before = feedToken((await status.json()).feedUrl);

  assert.equal((await server.app.request("/api/agent/calendar")).status, 401);
  assert.equal(
    (await server.app.request("/api/agent/calendar/sync", { method: "POST" })).status,
    401,
  );

  const deleted = await server.app.request("/api/agent/calendar", {
    method: "DELETE",
    headers: auth(),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await feedApp.request(`/api/calendar/feed/${before}.ics`)).status, 403);

  const after_ = await server.app.request("/api/agent/calendar", { headers: auth() });
  const state = await after_.json();
  assert.equal(state.provider, "ics");
  // A fresh link is available again, and it is a different token.
  assert.notEqual(feedToken(state.feedUrl), before);
});

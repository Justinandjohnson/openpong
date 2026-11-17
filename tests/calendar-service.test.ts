import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { CalendarService } from "../apps/server/src/calendar/service.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import type { OmniPongService } from "../apps/server/src/omnipong/service.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

type Call = { url: string; init?: RequestInit };

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const now = () => new Date("2026-11-16T12:00:00Z");
const owner = "calendar-owner";

function configWithGoogle(encryptionKey = randomBytes(32).toString("base64")): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "https://pong.example",
    dataDir: "unused",
    agentBackend: "model",
    allowedOrigins: [],
    googleRedirectUri: "https://pong.example/api/google/callback",
    googleClientId: "synthetic-client",
    googleClientSecret: "synthetic-secret",
    encryptionKey,
  };
}

/** Seed an unexpired Google credential so no refresh (and no global fetch) is needed. */
async function seedGoogle(db: Store, config: Config) {
  assert.ok(config.encryptionKey);
  await db.put(owner, "credentials", {
    id: "google",
    connectionId: "google-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "google-connection",
        accessToken: "synthetic-access-token",
        expiresAt: Date.now() + 3600000,
        scopes: [],
        account: "player@example.com",
      }),
      config.encryptionKey,
    ),
  });
}

/** A tiny fake Calendar API: one calendar, one event endpoint, ownership in private props. */
function googleHandler(overrides: { pongKeyForGet?: (id: string) => string | undefined } = {}) {
  const events = new Map<string, string>();
  let created = 0;
  return (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname.replace(/^\/calendar\/v3/, "");
    if (path === "/calendars" && method === "POST") return json({ id: "pong-calendar" });
    if (/^\/calendars\/[^/]+$/.test(path) && method === "GET") return json({ id: "pong-calendar" });
    if (/^\/calendars\/[^/]+\/events$/.test(path) && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        extendedProperties?: { private?: Record<string, string> };
      };
      const id = `google-event-${++created}`;
      events.set(id, body.extendedProperties?.private?.pongKey ?? "");
      return json({ id });
    }
    const one = /^\/calendars\/[^/]+\/events\/([^/]+)$/.exec(path);
    if (one) {
      const id = one[1] ?? "";
      if (method === "GET") {
        const key = overrides.pongKeyForGet?.(id) ?? events.get(id);
        if (key === undefined) return json({ error: { message: "Not found" } }, 404);
        return json({ id, extendedProperties: { private: { pongKey: key } } });
      }
      if (method === "PATCH") return json({ id });
      if (method === "DELETE") {
        events.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: { message: `Unhandled ${method} ${path}` } }, 500);
  };
}

function tournament(overrides: Record<string, unknown> = {}) {
  return {
    title: "Thanksgiving Open",
    city_state: "Plano, TX",
    date_range: "November 28-29, 2026",
    source_id: "T-tourney.asp?t=100&r=6157",
    omnipong_url: "https://www.omnipong.com/T-tourney.asp?t=100&r=6157",
    ...overrides,
  };
}

function omnipongStub(rows: {
  tournaments?: Record<string, unknown>[];
  matches?: Record<string, unknown>[];
  failTournaments?: boolean;
}) {
  return {
    getTournaments: async () => {
      if (rows.failTournaments) throw new Error("tournament service is down");
      return rows.tournaments ?? [];
    },
    getMatches: async () => rows.matches ?? [],
  } as Pick<OmniPongService, "getTournaments" | "getMatches">;
}

test("ensureCalendar creates the Pong calendar exactly once across two calls", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = configWithGoogle();
  await seedGoogle(db, config);
  const { calls, fetchImpl } = stubFetch(googleHandler());
  const service = new CalendarService(db, config, { fetchImpl, now });

  const first = await service.ensureCalendar(owner);
  const second = await service.ensureCalendar(owner);
  assert.equal(first.calendarId, "pong-calendar");
  assert.equal(second.calendarId, first.calendarId);
  const creates = calls.filter(
    (call) => call.init?.method === "POST" && new URL(call.url).pathname.endsWith("/calendars"),
  );
  assert.equal(creates.length, 1);
  const body = JSON.parse(String(creates[0]?.init?.body));
  assert.deepEqual(body, { summary: "Pong", timeZone: "UTC" });
});

test("upsert sends the pongKey and skips unchanged events on a second call", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = configWithGoogle();
  await seedGoogle(db, config);
  const { calls, fetchImpl } = stubFetch(googleHandler());
  const service = new CalendarService(db, config, { fetchImpl, now });

  const input = {
    pongKey: "custom:fixed-key",
    title: "Practice with Sam",
    start: "2026-11-20T18:00:00-06:00",
    end: "2026-11-20T20:00:00-06:00",
    allDay: false,
    kind: "custom" as const,
  };
  const first = await service.upsert(owner, [input]);
  assert.deepEqual(
    { created: first.created, updated: first.updated, skipped: first.skipped },
    { created: 1, updated: 0, skipped: 0 },
  );
  const post = calls.find(
    (call) => call.init?.method === "POST" && new URL(call.url).pathname.endsWith("/events"),
  );
  const posted = JSON.parse(String(post?.init?.body));
  assert.equal(posted.extendedProperties.private.pongKey, "custom:fixed-key");
  assert.equal(posted.summary, "Practice with Sam");

  const writesBefore = calls.filter((call) => call.init?.method !== "GET").length;
  const second = await service.upsert(owner, [input]);
  assert.deepEqual(
    { created: second.created, updated: second.updated, skipped: second.skipped },
    { created: 0, updated: 0, skipped: 1 },
  );
  assert.equal(calls.filter((call) => call.init?.method !== "GET").length, writesBefore);

  const listed = await service.list(owner);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.pongKey, "custom:fixed-key");
});

test("remove deletes only events whose pongKey proves Pong ownership", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = configWithGoogle();
  await seedGoogle(db, config);
  // The first event's Google copy claims a different key: it is not ours.
  const { calls, fetchImpl } = stubFetch(
    googleHandler({
      pongKeyForGet: (id) => (id === "google-event-1" ? "someone-else" : undefined),
    }),
  );
  const service = new CalendarService(db, config, { fetchImpl, now });
  await service.upsert(owner, [
    {
      pongKey: "custom:mine-but-not-on-google",
      title: "Mismatch",
      start: "2026-11-20",
      end: "2026-11-21",
      allDay: true,
      kind: "custom",
    },
    {
      pongKey: "custom:owned",
      title: "Owned",
      start: "2026-11-22",
      end: "2026-11-23",
      allDay: true,
      kind: "custom",
    },
  ]);

  const refused = await service.remove(owner, "custom:mine-but-not-on-google");
  assert.equal(refused.deleted, false);
  assert.match(refused.reason ?? "", /not created by Pong/);
  assert.equal(calls.filter((call) => call.init?.method === "DELETE").length, 0);
  assert.ok(
    (await service.list(owner)).some((item) => item.pongKey === "custom:mine-but-not-on-google"),
  );

  const removed = await service.remove(owner, "custom:owned");
  assert.equal(removed.deleted, true);
  assert.equal(calls.filter((call) => call.init?.method === "DELETE").length, 1);
  assert.equal(
    (await service.list(owner)).some((item) => item.pongKey === "custom:owned"),
    false,
  );

  // A key we never created is never deleted.
  const unknown = await service.remove(owner, "custom:never-existed");
  assert.equal(unknown.deleted, false);
  assert.equal(calls.filter((call) => call.init?.method === "DELETE").length, 1);
});

test("syncAll survives an upstream failure and reports warnings instead of throwing", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = configWithGoogle();
  const service = new CalendarService(db, config, {
    fetchImpl: stubFetch(googleHandler()).fetchImpl,
    now,
    omnipong: omnipongStub({
      failTournaments: true,
      matches: [
        {
          id: 7,
          date: "2026-11-10",
          opponent_name: "Chen, Han",
          opponent_rating: 1238,
          score_summary: "0-3",
          result: "Loss",
          source: "stadium_league",
        },
        // Older than 90 days: outside the result window.
        {
          id: 1,
          date: "2026-01-10",
          opponent_name: "Old Result",
          result: "Win",
          score_summary: "3-0",
        },
      ],
    }),
  });

  const result = await service.syncAll(owner);
  assert.equal(result.created, 1);
  assert.ok(result.warnings.some((warning) => warning.startsWith("tournaments:")));
  assert.ok(result.lastSyncAt);
  const events = await service.list(owner);
  assert.deepEqual(
    events.map((event) => event.pongKey),
    ["match:7"],
  );
  assert.equal(events[0]?.allDay, true);
  assert.match(String(events[0]?.title), /Chen, Han \(Loss\)/);

  // Re-syncing the same source data is idempotent.
  const again = await service.syncAll(owner);
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 1);
});

test("syncAll maps upcoming tournaments and confirmed sign-ups with stable keys", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = configWithGoogle();
  await db.put(owner, "tasks", {
    id: "task-signup",
    kind: "agent",
    title: "Register for Thanksgiving Open",
    status: "succeeded",
    input: { omnipong: { operation: "signup", title: "Thanksgiving Open" } },
  });
  const service = new CalendarService(db, config, {
    fetchImpl: stubFetch(googleHandler()).fetchImpl,
    now,
    omnipong: omnipongStub({
      tournaments: [
        tournament(),
        // Past tournament: not pulled onto the calendar.
        tournament({ title: "Last Spring", date_range: "March 2, 2026", source_id: "old" }),
        // Unreadable date: skipped with a warning.
        tournament({ title: "Unknown Date", date_range: "TBD", source_id: "tbd" }),
      ],
    }),
  });

  const result = await service.syncAll(owner);
  const keys = (await service.list(owner)).map((event) => event.pongKey).sort();
  assert.ok(keys.includes("tournament:T-tourney.asp?t=100&r=6157"));
  assert.ok(keys.includes("signup:task-signup"));
  assert.ok(result.warnings.some((warning) => warning.includes("Unknown Date")));
  assert.equal(result.created, 2);
});

test("the calendar connect scope adds calendar.app.created without dropping existing scopes", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = configWithGoogle();
  const auth = new GoogleAuth(db, config);
  const { url } = await auth.connectCalendar(owner);
  const scopes = new URL(url).searchParams.get("scope")?.split(" ") ?? [];
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.app.created"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.calendarlist.readonly"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/calendar.events.readonly"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/gmail.readonly"));
  // The calendar path must not request mail send.
  assert.equal(scopes.includes("https://www.googleapis.com/auth/gmail.send"), false);
});

test("feed links require an encryption key and ICS mode never calls Google", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config: Config = {
    ...configWithGoogle(),
    googleClientId: undefined,
    googleClientSecret: undefined,
  };
  const { calls, fetchImpl } = stubFetch(() => json({ error: "should not be called" }, 500));
  const service = new CalendarService(db, config, { fetchImpl, now });

  const connect = await service.connectUrl(owner);
  assert.equal(connect.kind, "ics");
  const event = await service.add(owner, {
    title: "Cache only",
    start: "2026-11-20",
    end: "2026-11-21",
    allDay: true,
  });
  assert.equal(event.created, 1);
  assert.equal(calls.length, 0);
  assert.ok((await service.list(owner)).some((item) => item.pongKey === event.event.pongKey));
  const feed = await service.feedForToken(
    new URL(connect.feedUrl).pathname
      .split("/")
      .at(-1)
      ?.replace(/\.ics$/, "") ?? "",
  );
  assert.ok(feed?.ics.includes("SUMMARY:Cache only"));
  assert.equal(feed?.owner, owner);
});

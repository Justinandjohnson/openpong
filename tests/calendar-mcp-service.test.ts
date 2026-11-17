import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CalendarMcp } from "../apps/server/src/calendar/mcp.ts";
import {
  type CalendarMcpEvent,
  CalendarMcpService,
  eventsOf,
} from "../apps/server/src/calendar/mcp-service.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

/** A throwaway store, so each test starts from nothing. */
async function createTestStore(): Promise<Store> {
  const directory = await mkdtemp(join(tmpdir(), "openpong-mcp-"));
  const store = await createStore({ dataDir: join(directory, "db") });
  const close = store.close.bind(store);
  store.close = async () => {
    await close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };
  return store;
}

/** A client that answers from memory and records what it was asked. */
function stubClient(replies: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args?: unknown }> = [];
  const client = {
    calls,
    listTools: async () => [{ name: "list_events" }],
    listCalendars: async () => {
      calls.push({ method: "listCalendars" });
      return { text: "", data: replies.calendars ?? [{ id: "primary" }], isError: false };
    },
    listEvents: async (args: unknown) => {
      calls.push({ method: "listEvents", args });
      return { text: "", data: replies.events ?? [], isError: false };
    },
    call: async (name: string, args: unknown) => {
      calls.push({ method: name, args });
      return { text: "", data: null, isError: false };
    },
    createEvent: async (args: unknown) => {
      calls.push({ method: "createEvent", args });
      return { text: "", data: null, isError: false };
    },
    suggestTime: async (args: unknown) => {
      calls.push({ method: "suggestTime", args });
      return { text: "", data: null, isError: false };
    },
    searchEvents: async (args: unknown) => {
      calls.push({ method: "searchEvents", args });
      return { text: "", data: null, isError: false };
    },
  };
  return client;
}

function service(
  store: Store,
  options: {
    google?: { accessToken(owner: string): Promise<string> };
    client?: ReturnType<typeof stubClient>;
    seen?: Array<{ url: string; token?: string }>;
  } = {},
) {
  const seen = options.seen ?? [];
  const google = options.google ?? { accessToken: async () => "ya29.default-token" };
  return new CalendarMcpService(store, google, {
    clientFactory: ({ url, token }) => {
      seen.push({ url, token });
      return (options.client ?? stubClient()) as unknown as CalendarMcp;
    },
  });
}

test("an owner with no calendar connection is reported as unconfigured", async () => {
  const store = await createTestStore();
  const view = await service(store).view("owner-a");
  assert.deepEqual(view, { configured: false });
  await store.close();
});

test("only Google is offered, and it stores no credential of its own", async () => {
  const store = await createTestStore();
  const mcp = service(store);
  await assert.rejects(
    () => mcp.save("owner-a", { provider: "zapier" as unknown as "google" }),
    /Google/,
  );

  const view = await mcp.save("owner-a", { provider: "google" });
  assert.equal(view.configured, true);
  assert.equal(view.provider, "google");
  assert.equal(view.hint, undefined);

  const stored = await store.get<{ encrypted?: string }>("owner-a", "calendar-mcp", "default");
  assert.equal(stored?.encrypted, undefined);
  await store.close();
});

test("the coach calls Google's own calendar server with the owner's Google token", async () => {
  const store = await createTestStore();
  const seen: Array<{ url: string; token?: string }> = [];
  const mcp = service(store, { seen, google: { accessToken: async () => "ya29.real" } });
  await mcp.save("owner-a", { provider: "google" });
  await mcp.agenda("owner-a");
  assert.equal(seen.at(-1)?.token, "ya29.real");
  assert.match(String(seen.at(-1)?.url), /calendarmcp\.googleapis\.com/);
  await store.close();
});

test("Google uses the owner's own connection rather than a stored token", async () => {
  const store = await createTestStore();
  const seen: Array<{ url: string; token?: string }> = [];
  let asked = "";
  const mcp = service(store, {
    seen,
    google: {
      accessToken: async (owner: string) => {
        asked = owner;
        return "ya29.owner-token";
      },
    },
  });
  await mcp.save("owner-a", { provider: "google" });
  await mcp.agenda("owner-a");
  assert.equal(asked, "owner-a");
  assert.equal(seen.at(-1)?.token, "ya29.owner-token");
  assert.match(String(seen.at(-1)?.url), /calendarmcp\.googleapis\.com/);
  await store.close();
});

test("an expired Google connection is explained, not thrown raw", async () => {
  const store = await createTestStore();
  const mcp = service(store, {
    google: {
      accessToken: async () => {
        throw new Error("invalid_grant");
      },
    },
  });
  await mcp.save("owner-a", { provider: "google" });
  await assert.rejects(() => mcp.client("owner-a"), /Reconnect it in Calendar settings/);
  await store.close();
});

test("the agenda reads the owner's calendars and sorts what it finds", async () => {
  const store = await createTestStore();
  const client = stubClient({
    calendars: [{ id: "primary" }, { id: "work@example.com" }],
    events: [
      {
        id: "e2",
        summary: "League night",
        start: { dateTime: "2026-11-20T19:00:00-06:00" },
        end: { dateTime: "2026-11-20T21:00:00-06:00" },
        location: "Top Spin USA",
      },
      {
        id: "e1",
        summary: "Tournament",
        start: { date: "2026-11-19" },
        end: { date: "2026-11-20" },
      },
    ],
  });
  const mcp = service(store, { client });
  await mcp.save("owner-a", { provider: "google" });
  const agenda = await mcp.agenda("owner-a", { from: "2026-11-18", to: "2026-11-25" });

  assert.deepEqual(agenda.calendars, ["primary", "work@example.com"]);
  assert.equal(agenda.events.length, 4); // two events × two calendars
  assert.equal(agenda.events[0].title, "Tournament");
  assert.equal(agenda.events[0].allDay, true);
  assert.equal(agenda.events[0].calendar, "primary");
  assert.equal(agenda.truncated, false);
  const asked = client.calls.filter((call) => call.method === "listEvents");
  assert.equal(asked.length, 2);
  assert.deepEqual((asked[0].args as { startTime: string }).startTime, "2026-11-18");
  await store.close();
});

test("an agenda that cannot read the connection says so instead of looking empty", async () => {
  const store = await createTestStore();
  const client = stubClient({ calendars: [{ id: "primary" }] });
  client.listCalendars = async () => {
    throw new Error("The calendar connection is no longer authorised.");
  };
  client.listEvents = async () => {
    throw new Error("The calendar connection is no longer authorised.");
  };
  const mcp = service(store, { client });
  await mcp.save("owner-a", { provider: "google" });

  // A silent empty calendar is a lie: the coach must not say "you are free".
  await assert.rejects(() => mcp.agenda("owner-a"), /no longer authorised/);
  await store.close();
});

test("a calendar that fails to read still returns the calendars that worked", async () => {
  const store = await createTestStore();
  const client = stubClient({
    calendars: [{ id: "primary" }, { id: "work@example.com" }],
  });
  client.listEvents = async (args: unknown) => {
    if ((args as { calendarId?: string }).calendarId === "work@example.com")
      throw new Error("not shared with you");
    return {
      text: "",
      data: [{ summary: "League night", start: { date: "2026-11-20" } }],
      isError: false,
    };
  };
  const mcp = service(store, { client });
  await mcp.save("owner-a", { provider: "google" });
  const agenda = await mcp.agenda("owner-a");

  assert.deepEqual(agenda.calendars, ["primary", "work@example.com"]);
  assert.equal(agenda.events.length, 1);
  assert.equal(agenda.events[0].title, "League night");
  await store.close();
});

test("calendar payloads are normalised from either server's shape", () => {
  const events: CalendarMcpEvent[] = eventsOf({
    events: [
      { summary: "Pong night", start: { dateTime: "2026-11-20T19:00:00Z" } },
      { title: "Second calendar", start: "2026-11-21T10:00:00Z", end: "2026-11-21T11:00:00Z" },
      { summary: "   " },
      "nonsense",
    ],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].title, "Pong night");
  assert.equal(events[1].title, "Second calendar");
  assert.equal(events[1].start, "2026-11-21T10:00:00Z");
  assert.deepEqual(eventsOf(null), []);
  assert.deepEqual(eventsOf([{ summary: "Bare array" }]).length, 1);
});

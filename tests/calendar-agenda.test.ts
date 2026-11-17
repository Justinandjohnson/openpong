import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { EventSchemas, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

/** A live-mode app with a stubbed Google Calendar API. */
async function liveFixture(
  t: TestContext,
  google: (request: Request) => Response | Promise<Response>,
) {
  const browser = await browserFixture(t, () => {
    throw new Error("Calendar reads must not use the browser");
  });
  const config = {
    ...browser.config,
    mode: "live" as const,
    agentBackend: "model" as const,
    model: "openai/fixture",
    accessKey: "test-access-key",
    encryptionKey: randomBytes(32).toString("base64"),
  };
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    return new URL(request.url).hostname === "www.googleapis.com"
      ? google(request)
      : realFetch(input, init);
  });
  await browser.db.put("local-user", "credentials", {
    id: "google",
    connectionId: "agenda-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "agenda-connection",
        accessToken: "synthetic-agenda-token",
        expiresAt: Date.now() + 3600000,
        scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
        account: "reader@example.com",
      }),
      config.encryptionKey,
    ),
  });
  const server = await createApp(browser.db, config);
  t.after(() => server.agent.stop());
  return {
    ...browser,
    ...server,
    conversation: new ConversationAgent(config, server.agent, "local-user"),
  };
}

/** A sample-mode app: no Google is connected unless the test connects one. */
async function sampleFixture(t: TestContext) {
  const browser = await browserFixture(t, () => {
    throw new Error("Calendar reads must not use the browser");
  });
  const config = {
    ...browser.config,
    mode: "sample" as const,
    agentBackend: "model" as const,
    model: "openai/fixture",
  };
  const server = await createApp(browser.db, config);
  t.after(() => server.agent.stop());
  return {
    ...browser,
    ...server,
    conversation: new ConversationAgent(config, server.agent, "local-user"),
  };
}

const CALENDAR_LIST = {
  items: [
    { id: "primary", summary: "Personal", timeZone: "America/Chicago", accessRole: "owner" },
    { id: "work", summary: "Work", timeZone: "UTC", accessRole: "reader" },
  ],
};

/** Two calendars and one event each: one timed, one all-day. */
function googleHandler(calls: URL[]) {
  return (request: Request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-agenda-token");
    const url = new URL(request.url);
    calls.push(url);
    if (url.pathname === "/calendar/v3/users/me/calendarList") return Response.json(CALENDAR_LIST);
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1] ?? "");
      if (id === "primary")
        return Response.json({
          timeZone: "America/Chicago",
          items: [
            {
              id: "standup",
              summary: "Standup",
              start: { dateTime: "2026-11-20T09:00:00-06:00", timeZone: "America/Chicago" },
              end: { dateTime: "2026-11-20T09:30:00-06:00" },
              location: "Room 2",
              attendees: [{ email: "private@example.com" }],
            },
          ],
        });
      if (id === "work")
        return Response.json({
          timeZone: "UTC",
          items: [
            {
              id: "conference",
              summary: "Conference",
              start: { date: "2026-11-21" },
              end: { date: "2026-11-22" },
            },
          ],
        });
    }
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  };
}

async function runChat(conversation: ConversationAgent) {
  const input: RunAgentInput = {
    threadId: "agenda-chat",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "What is on my calendar?" }],
    tools: [],
    context: [],
    state: {},
  };
  return (await lastValueFrom(conversation.run(input).pipe(toArray()))).map((event) =>
    EventSchemas.parse(event),
  );
}

async function toolResult(conversation: ConversationAgent) {
  const events = await runChat(conversation);
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT, "Expected a tool result");
  return JSON.parse(result.content);
}

test("the agenda route maps the owner's calendars and events to a small, mail-free shape", async (t) => {
  const calls: URL[] = [];
  const f = await liveFixture(t, googleHandler(calls));
  const { token } = await f.auth.session("test-access-key");
  const response = await f.app.request("/api/agent/calendar/agenda", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const payload = await response.text();
  assert.deepEqual(JSON.parse(payload), {
    events: [
      {
        title: "Standup",
        start: "2026-11-20T09:00:00-06:00",
        end: "2026-11-20T09:30:00-06:00",
        allDay: false,
        location: "Room 2",
        calendar: "Personal",
      },
      {
        title: "Conference",
        start: "2026-11-21",
        end: "2026-11-22",
        allDay: true,
        calendar: "Work",
      },
    ],
    calendars: ["Personal", "Work"],
    truncated: false,
    connected: true,
  });
  // The attendee on the first event never leaves the server.
  assert.equal(payload.includes("private@example.com"), false);
  assert.equal(payload.includes("attendees"), false);
});

test("the agenda route clamps a wide window to 90 days", async (t) => {
  const calls: URL[] = [];
  const f = await liveFixture(t, googleHandler(calls));
  const { token } = await f.auth.session("test-access-key");
  const from = "2026-01-01T00:00:00Z";
  const to = "2026-12-31T00:00:00Z";
  const response = await f.app.request(
    `/api/agent/calendar/agenda?${new URLSearchParams({ from, to })}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 200);
  const eventCalls = calls.filter((url) => url.pathname.endsWith("/events"));
  assert.ok(eventCalls.length >= 1);
  for (const call of eventCalls) {
    const timeMin = Date.parse(call.searchParams.get("timeMin") ?? "");
    const timeMax = Date.parse(call.searchParams.get("timeMax") ?? "");
    assert.equal(call.searchParams.get("timeMin"), new Date(from).toISOString());
    assert.equal(timeMax - timeMin, 90 * 24 * 60 * 60 * 1000);
  }
});

test("reading calendars without a Google connection is an honest error, not an empty calendar", async (t) => {
  const f = await sampleFixture(t);
  await f.db.put("local-user", "settings", { id: "google", enabled: false });
  const { token } = await f.auth.session();
  const response = await f.app.request("/api/agent/calendar/agenda", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Google connected/);
  assert.match(body.error, /iCal feed is write-only/);
});

test("the read_my_calendar tool reports no Google connection instead of an empty calendar", async (t) => {
  await modelFixture(t, (index) =>
    index === 0 ? { name: "read_my_calendar", arguments: {} } : undefined,
  );
  const f = await sampleFixture(t);
  await f.db.put("local-user", "settings", { id: "google", enabled: false });
  const result = await toolResult(f.conversation);
  assert.equal(result.connected, false);
  assert.match(result.error, /Google connected/);
  assert.equal("events" in result, false);
});

test("the read_my_calendar tool is registered for the coach", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const f = await sampleFixture(t);
  await runChat(f.conversation);
  const body = JSON.parse(requests[0]?.body ?? "{}") as {
    tools?: { name: string }[];
  };
  assert.ok(body.tools?.some((tool) => tool.name === "read_my_calendar"));
  // The tool is read-only: no write or delete tool is registered alongside it.
  assert.equal(
    body.tools?.some((tool) => tool.name === "write_calendar"),
    false,
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CalendarMcp,
  CalendarMcpError,
  GOOGLE_CALENDAR_MCP_URL,
  ZAPIER_MCP_URL,
} from "../apps/server/src/calendar/mcp.ts";

/** A tiny stand-in for a remote MCP server, over the fetch the SDK uses. */
function server(handler: (method: string, params: Record<string, unknown>) => unknown) {
  const seen: { method: string; params: Record<string, unknown>; authorization?: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    // The SDK hands headers over as a plain object or a Headers instance
    // depending on the transport, so read them the way fetch does.
    const authorization =
      new Headers(init.headers as HeadersInit).get("authorization") ?? undefined;
    seen.push({ method: body.method, params: body.params ?? {}, authorization });
    // Notifications are answered with 202 and no body.
    if (body.id === undefined) return new Response(null, { status: 202 });
    // The handshake has a fixed shape; everything else is the test's business.
    const result =
      body.method === "initialize"
        ? {
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "stub", version: "1" },
            },
          }
        : handler(body.method, body.params ?? {});
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(result as object) }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "test-session" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const schema = { type: "object", properties: {} };
const tools = {
  result: {
    tools: [
      { name: "list_events", description: "List events", inputSchema: schema },
      { name: "create_event", description: "Create an event", inputSchema: schema },
    ],
  },
};

test("the tools a server offers are read without credentials", async () => {
  const { fetchImpl, seen } = server(() => tools);
  const client = new CalendarMcp({ url: GOOGLE_CALENDAR_MCP_URL, fetchImpl });
  assert.deepEqual(await client.listTools(), [
    { name: "list_events", description: "List events" },
    { name: "create_event", description: "Create an event" },
  ]);
  assert.ok(seen.some((call) => call.method === "tools/list"));
  // Google answers tools/list unauthenticated, so no token is required to look.
  assert.equal(seen[0].authorization, undefined);
});

test("a bearer token is sent when there is one, and never without one", async () => {
  const withToken = server(() => tools);
  await new CalendarMcp({
    url: GOOGLE_CALENDAR_MCP_URL,
    token: "ya29.secret",
    fetchImpl: withToken.fetchImpl,
  }).listTools();
  assert.ok(withToken.seen.every((call) => call.authorization === "Bearer ya29.secret"));

  const withoutToken = server(() => tools);
  await new CalendarMcp({ url: ZAPIER_MCP_URL, fetchImpl: withoutToken.fetchImpl }).listTools();
  assert.ok(withoutToken.seen.every((call) => call.authorization === undefined));
});

test("a JSON tool result is parsed, and a plain one is kept as text", async () => {
  const { fetchImpl } = server(() => ({
    result: {
      content: [{ type: "text", text: JSON.stringify({ events: [{ summary: "League night" }] }) }],
    },
  }));
  const client = new CalendarMcp({ url: GOOGLE_CALENDAR_MCP_URL, fetchImpl });
  const result = await client.listEvents({ calendarId: "me@example.com", pageSize: 5 });
  assert.equal(result.isError, false);
  assert.deepEqual(result.data, { events: [{ summary: "League night" }] });

  const plain = server(() => ({
    result: { content: [{ type: "text", text: "No events found." }] },
  }));
  const other = await new CalendarMcp({
    url: GOOGLE_CALENDAR_MCP_URL,
    fetchImpl: plain.fetchImpl,
  }).call("search_events", { query: "tournament" });
  assert.equal(other.data, undefined);
  assert.equal(other.text, "No events found.");
});

test("the arguments a tool needs are passed through, with the page size clamped", async () => {
  const { fetchImpl, seen } = server(() => ({
    result: { content: [{ type: "text", text: "{}" }] },
  }));
  const client = new CalendarMcp({ url: GOOGLE_CALENDAR_MCP_URL, fetchImpl });
  await client.listEvents({
    calendarId: "me@example.com",
    startTime: "2026-11-20T00:00:00",
    endTime: "2026-11-27T00:00:00",
    pageSize: 9999,
  });
  const call = seen.find((entry) => entry.method === "tools/call");
  assert.equal(call?.params.name, "list_events");
  assert.deepEqual(call?.params.arguments, {
    calendarId: "me@example.com",
    startTime: "2026-11-20T00:00:00",
    endTime: "2026-11-27T00:00:00",
    pageSize: 250,
  });
});

test("an unauthorised connection is explained, not leaked", async () => {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as { id?: number };
    if (body.id === undefined) return new Response(null, { status: 202 });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32001, message: "Request is missing required authentication credential." },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const client = new CalendarMcp({ url: GOOGLE_CALENDAR_MCP_URL, token: "stale", fetchImpl });
  await assert.rejects(
    () => client.listCalendars(),
    (error: unknown) =>
      error instanceof CalendarMcpError &&
      /no longer authorised/.test(error.message) &&
      !/stale/.test(error.message),
  );
});

test("a bad address is refused before any request is made", () => {
  assert.throws(() => new CalendarMcp({ url: "" }), /needs a URL/);
  assert.throws(() => new CalendarMcp({ url: "not a url" }), /not a valid URL/);
  assert.throws(
    () => new CalendarMcp({ url: "http://example.com/mcp" }),
    /must be reached over https/,
  );
  // A local server is allowed for self-hosting.
  assert.doesNotThrow(() => new CalendarMcp({ url: "http://127.0.0.1:8765/mcp" }));
});

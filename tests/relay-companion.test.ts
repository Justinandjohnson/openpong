import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { companionCommand, relayWebSocketUrl } from "../apps/server/src/relay/client.ts";
import { modelFixture } from "./helpers/model.ts";

// ---------------------------------------------------------------------------
// A minimal stand-in for the relay's operator control plane.
// ---------------------------------------------------------------------------

interface RelayRequest {
  method: string;
  path: string;
  owner?: string;
  operatorToken?: string;
  body?: unknown;
}

async function startRelay(
  t: TestContext,
  options: { connected?: boolean; paired?: boolean; gates?: unknown[] } = {},
) {
  const requests: RelayRequest[] = [];
  const connected = options.connected ?? true;
  const paired = options.paired ?? true;
  const gates = options.gates ?? [];
  const server: Server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    const record: RelayRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      operatorToken: request.headers["x-operator-token"] as string | undefined,
      body: body ? JSON.parse(body) : undefined,
    };
    const send = (data: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    // /companions/{owner}
    if (parts[0] === "companions" && parts.length === 2) {
      record.owner = decodeURIComponent(parts[1]);
      requests.push(record);
      return send({
        owner: record.owner,
        paired,
        connected,
        fingerprint: "fp-1234",
        gates,
      });
    }
    // /companions/{owner}/gates/{gate_id}/clear
    if (parts[0] === "companions" && parts[2] === "gates" && parts[4] === "clear") {
      record.owner = decodeURIComponent(parts[1]);
      requests.push(record);
      return send({ gate_id: decodeURIComponent(parts[3]), status: "cleared" });
    }
    // /pairing  and  /pairing/{owner}
    if (parts[0] === "pairing") {
      record.owner = parts[1]
        ? decodeURIComponent(parts[1])
        : (record.body as { owner?: string })?.owner;
      requests.push(record);
      if (record.method === "POST")
        return send(
          { owner: record.owner, pairing_token: "rt_minted_token", fingerprint: "fp-1234" },
          201,
        );
      return send({ owner: record.owner, revoked: true });
    }
    return send({ error: { type: "NotFound", detail: `no route ${url.pathname}` } }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, url: `http://127.0.0.1:${address.port}` };
}

/** A minimal stand-in for the OmniPong domain service (read paths only). */
async function startOmnipong(t: TestContext, tournaments: unknown[] = []) {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (data: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.method === "POST" && url.pathname === "/agent/action") {
      const parsed = JSON.parse(body || "{}") as {
        action?: string;
        params?: Record<string, unknown>;
      };
      calls.push({ action: parsed.action ?? "", params: parsed.params ?? {} });
      return send({ status: "ok", action: parsed.action, result: { status: "success" } });
    }
    if (request.method === "GET" && url.pathname === "/tournaments") return send(tournaments);
    return send({});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { calls, url: `http://127.0.0.1:${address.port}` };
}

async function appFor(
  t: TestContext,
  extras: Partial<Config> = {},
): Promise<{ app: Awaited<ReturnType<typeof createApp>>; config: Config }> {
  const directory = await mkdtemp(join(tmpdir(), "openpong-relay-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    model: "openai/fixture",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    ...extras,
  };
  const app = await createApp(db, config);
  t.after(async () => {
    await app.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, config };
}

async function sessionToken(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  const session = await app.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200, await session.clone().text());
  return (await session.json()).token;
}

// ---------------------------------------------------------------------------
// Routes: auth + owner scoping
// ---------------------------------------------------------------------------

test("companion routes reject unauthenticated callers with 401", async (t) => {
  const relay = await startRelay(t);
  const { app } = await appFor(t, { relayUrl: relay.url, relayToken: "op-secret" });
  for (const [method, path] of [
    ["GET", "/api/agent/companion"],
    ["POST", "/api/agent/companion/pairing"],
    ["DELETE", "/api/agent/companion"],
    ["GET", "/api/agent/companion/gates"],
    ["POST", "/api/agent/companion/gates/g_1/clear"],
  ] as const) {
    const response = await app.app.request(path, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test("companion status is owner-scoped and reports the relay's view", async (t) => {
  const relay = await startRelay(t, {
    gates: [{ gate_id: "g_1", kind: "login", hint: "Log in", url_host: "omnipong.com" }],
  });
  const { app } = await appFor(t, { relayUrl: relay.url, relayToken: "op-secret" });
  const token = await sessionToken(app);
  // A caller-supplied owner in the query string must be ignored: the session's
  // owner is authoritative.
  const response = await app.app.request("/api/agent/companion?owner=someone-else", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const status = await response.json();
  assert.equal(status.configured, true);
  assert.equal(status.connected, true);
  assert.equal(status.owner, "local-user");
  assert.deepEqual(status.gates, [
    { gate_id: "g_1", kind: "login", hint: "Log in", url_host: "omnipong.com" },
  ]);
  const statusCall = relay.requests.find(
    (r) => r.method === "GET" && r.path === "/companions/local-user",
  );
  assert.ok(statusCall, "the relay is asked about the session owner");
  assert.equal(statusCall.owner, "local-user");
  assert.equal(statusCall.operatorToken, "op-secret", "the operator token is presented");
  assert.equal(
    relay.requests.some((r) => r.path.includes("someone-else")),
    false,
    "a client-supplied owner never reaches the relay",
  );
});

test("pairing returns a one-time command and DELETE unpairs", async (t) => {
  const relay = await startRelay(t, { connected: false, paired: false });
  const { app } = await appFor(t, { relayUrl: relay.url, relayToken: "op-secret" });
  const token = await sessionToken(app);

  const pairing = await app.app.request("/api/agent/companion/pairing", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(pairing.status, 201, await pairing.clone().text());
  const body = await pairing.json();
  assert.equal(body.pairingToken, "rt_minted_token");
  assert.equal(body.owner, "local-user");
  assert.match(body.command, /--pairing-token rt_minted_token/);
  assert.match(body.command, /--relay-base-url ws:\/\//);
  const post = relay.requests.find((r) => r.method === "POST" && r.path === "/pairing");
  assert.deepEqual(post?.body, { owner: "local-user" });

  const unpair = await app.app.request("/api/agent/companion", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(unpair.status, 200, await unpair.clone().text());
  assert.deepEqual(await unpair.json(), { owner: "local-user", revoked: true });
  const del = relay.requests.find((r) => r.method === "DELETE" && r.path === "/pairing/local-user");
  assert.ok(del, "unpair revokes the session owner's pairing");
});

test("clearing a pending gate is owner-scoped", async (t) => {
  const relay = await startRelay(t, {
    gates: [{ gate_id: "g_1", kind: "twofa", hint: "Enter code", url_host: "omnipong.com" }],
  });
  const { app } = await appFor(t, { relayUrl: relay.url, relayToken: "op-secret" });
  const token = await sessionToken(app);
  const response = await app.app.request("/api/agent/companion/gates/g_1/clear", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { gate_id: "g_1", status: "cleared" });
  assert.ok(
    relay.requests.some(
      (r) => r.method === "POST" && r.path === "/companions/local-user/gates/g_1/clear",
    ),
  );
});

test("with no relay configured the status reads 'not configured' instead of throwing", async (t) => {
  const { app } = await appFor(t);
  const token = await sessionToken(app);
  const response = await app.app.request("/api/agent/companion", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const status = await response.json();
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  const pairing = await app.app.request("/api/agent/companion/pairing", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(pairing.status, 503);
});

test("relay URL helpers convert to the companion's ws scheme", () => {
  assert.equal(relayWebSocketUrl("https://relay.example"), "wss://relay.example");
  assert.equal(relayWebSocketUrl("http://127.0.0.1:8765"), "ws://127.0.0.1:8765");
  assert.equal(
    companionCommand("https://relay.example", "rt_x"),
    "python companion.py --relay-base-url wss://relay.example --pairing-token rt_x",
  );
});

// ---------------------------------------------------------------------------
// The signup tool cannot report success without an approval
// ---------------------------------------------------------------------------

function runInput(text: string): RunAgentInput {
  return {
    threadId: randomUUID(),
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: text }],
    tools: [],
    context: [],
    state: {},
  };
}

async function toolResults(
  conversation: ConversationAgent,
  text: string,
): Promise<Record<string, unknown>[]> {
  const events = await lastValueFrom(conversation.run(runInput(text)).pipe(toArray()));
  return events
    .filter((event) => event.type === EventType.TOOL_CALL_RESULT)
    .map((event) => JSON.parse(String((event as unknown as { content: string }).content)));
}

test("signup_tournament is a dry run that never claims a registration", async (t) => {
  const omnipong = await startOmnipong(t, [
    { title: "Winter Open", events: [{ name: "Open Singles" }] },
  ]);
  const { app, config } = await appFor(t, { omnipongServiceUrl: omnipong.url });
  await modelFixture(t, (index) =>
    index === 0 ? { name: "signup_tournament", arguments: { title: "Winter Open" } } : undefined,
  );
  const conversation = new ConversationAgent(config, app.agent, "local-user");
  const [result] = await toolResults(conversation, "Sign me up for the Winter Open");
  assert.equal(result.mode, "dry_run");
  assert.equal(result.registered, false);
  assert.equal(
    omnipong.calls.filter((call) => call.action === "signup").length,
    0,
    "a dry run never calls the signup action",
  );
});

test("signup_tournament queues for approval and reports registered:false", async (t) => {
  const { app, config } = await appFor(t, { omnipongAllowRealSignup: true });
  await modelFixture(t, (index) =>
    index === 0
      ? { name: "signup_tournament", arguments: { title: "Winter Open", events: ["Open Singles"] } }
      : undefined,
  );
  const conversation = new ConversationAgent(config, app.agent, "local-user");
  const [result] = await toolResults(conversation, "Sign me up for the Winter Open");
  assert.equal(result.status, "queued_for_approval");
  assert.equal(result.registered, false);
  assert.equal(result.approvalRequired, true);
  assert.match(String(result.note), /No registration has happened yet/);

  // The queued task is a real, reviewable task paused for approval — not a
  // completed registration.
  const task = result.task as { id: string; status: string; actionId?: string | null };
  assert.ok(task?.id);
  const saved = await app.agent.getTask("local-user", task.id);
  assert.equal(saved.status, "queued");
  assert.equal(saved.actionId ?? null, null, "nothing is approved at queue time");
});

test("the companion_status tool reports the relay state honestly", async (t) => {
  const relay = await startRelay(t, { connected: false, paired: true });
  const { app, config } = await appFor(t, { relayUrl: relay.url, relayToken: "op-secret" });
  await modelFixture(t, (index) =>
    index === 0 ? { name: "companion_status", arguments: {} } : undefined,
  );
  const conversation = new ConversationAgent(config, app.agent, "local-user");
  const [result] = await toolResults(conversation, "Is my computer connected?");
  assert.equal(result.configured, true);
  assert.equal(result.connected, false);
  assert.equal(result.paired, true);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { ModelKeyService } from "../apps/server/src/engine/model-key.ts";
import { chatCompletionsFixture, modelFixture } from "./helpers/model.ts";

let db: Store;
let directory: string;
let config: Config;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openpong-model-key-"));
  db = await createStore({ dataDir: join(directory, "db") });
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    model: "openai/fixture",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
});

after(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function runInput(): RunAgentInput {
  return {
    threadId: `model-key-${randomUUID()}`,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "Hello" }],
    tools: [],
    context: [],
    state: {},
  };
}

async function runConversation(agent: ConversationAgent): Promise<BaseEvent[]> {
  return lastValueFrom(agent.run(runInput()).pipe(toArray()));
}

/** The model run reached its end (the Responses fixture emits no text without a tool call). */
function finished(events: BaseEvent[]): boolean {
  return events.some((event) => event.type === EventType.RUN_FINISHED);
}

async function tokenFor(server: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  return (await session.json()).token as string;
}

test("the owner's key is encrypted at rest and never returned to a client", async () => {
  const service = new ModelKeyService(db, config);
  const plaintext = "sk-owner-secret-key-ABCD";
  const view = await service.save("key-owner", {
    provider: "openrouter",
    apiKey: plaintext,
    model: "openai/gpt-4o-mini",
  });
  assert.deepEqual(view, {
    configured: true,
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    hint: "ABCD",
  });
  assert.ok(!JSON.stringify(view).includes(plaintext), "the view never carries the key");

  const record = await db.get<{ encrypted: string; hint: string }>(
    "key-owner",
    "model-key",
    "default",
  );
  assert.ok(record);
  assert.ok(record?.encrypted && !record.encrypted.includes(plaintext), "stored ciphertext");
  assert.equal(record?.hint, "ABCD");
  // The per-deployment secret was created lazily, exactly like the calendar feed.
  assert.ok(await db.get("system", "system", "model-key-secret"));

  const resolved = await service.resolve("key-owner");
  assert.equal(resolved?.auth.apiKey, plaintext, "the run gets the decrypted key");
  assert.equal(resolved?.spec, "openai/openai/gpt-4o-mini");
  assert.equal(resolved?.auth.chatCompletions, true);
  assert.equal(resolved?.auth.baseUrl, "https://openrouter.ai/api/v1");

  assert.deepEqual(await service.remove("key-owner"), { removed: true });
  assert.deepEqual(await service.view("key-owner"), { configured: false });
  assert.equal(await service.resolve("key-owner"), null);
});

test("a stored key round-trips through a second service instance (stable secret)", async () => {
  const first = new ModelKeyService(db, config);
  await first.save("round-trip-owner", { provider: "openai", apiKey: "sk-round-trip-1234" });
  const second = new ModelKeyService(db, config);
  const resolved = await second.resolve("round-trip-owner");
  assert.equal(resolved?.auth.apiKey, "sk-round-trip-1234");
  assert.equal(resolved?.spec, "openai/gpt-4o-mini");
  assert.equal(resolved?.auth.chatCompletions, undefined, "plain OpenAI uses the Responses API");
});

test("an owner's own key is used for their chat instead of the host key", async (t) => {
  // The fixture sets OPENAI_API_KEY to its own value; the owner's OpenRouter key
  // must still be the one on the wire.
  const { requests } = await chatCompletionsFixture(t, () => undefined);
  const previousRouter = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_BASE_URL = process.env.OPENAI_BASE_URL;
  t.after(() => {
    if (previousRouter === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = previousRouter;
  });

  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
  });
  await server.agent.modelKey.save("owner-with-key", {
    provider: "openrouter",
    apiKey: "owner-secret-key-1234",
    model: "fixture",
  });

  const events = await runConversation(
    new ConversationAgent(config, server.agent, "owner-with-key"),
  );
  assert.ok(finished(events));
  assert.equal(requests[0]?.authorization, "Bearer owner-secret-key-1234");
  assert.equal(requests[0]?.path, "/v1/chat/completions", "OpenRouter uses Chat Completions");
});

test("with no owner key the host environment applies exactly as before", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
  });
  assert.equal(await server.agent.modelKey.resolve("owner-without-key"), null);

  const events = await runConversation(
    new ConversationAgent(config, server.agent, "owner-without-key"),
  );
  assert.ok(finished(events));
  assert.equal(requests[0]?.authorization, "Bearer local-test-fixture", "the host key is used");
  assert.equal(requests[0]?.path, "/v1/responses", "the host wire format is unchanged");
});

test("the key test reports a bad key honestly and never 500s", async (t) => {
  const stub = createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Invalid API key" } }));
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const address = stub.address();
  assert.ok(address && typeof address !== "string");
  const previousRouter = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  t.after(async () => {
    if (previousRouter === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = previousRouter;
    stub.closeAllConnections();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
  });
  const token = await tokenFor(server);
  const response = await server.app.request("/api/agent/model-key/test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openrouter", apiKey: "bad-key-1234", model: "fixture" }),
  });
  assert.equal(response.status, 200, "the test endpoint never 500s");
  const body = (await response.json()) as { ok: boolean; error?: string };
  assert.equal(body.ok, false);
  assert.ok(typeof body.error === "string" && body.error.length > 0);

  // An unknown provider is reported the same way, not as a crash.
  const invalid = await server.app.request("/api/agent/model-key/test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "nonsense", apiKey: "whatever-1234" }),
  });
  assert.equal(invalid.status, 200);
  assert.equal(((await invalid.json()) as { ok: boolean }).ok, false);
});

test("the key test confirms a working key and sends the pasted key", async (t) => {
  const { requests } = await chatCompletionsFixture(t, () => undefined);
  const previousRouter = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_BASE_URL = process.env.OPENAI_BASE_URL;
  t.after(() => {
    if (previousRouter === undefined) delete process.env.OPENROUTER_BASE_URL;
    else process.env.OPENROUTER_BASE_URL = previousRouter;
  });
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
  });
  const token = await tokenFor(server);
  const response = await server.app.request("/api/agent/model-key/test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openrouter", apiKey: "good-key-1234", model: "fixture" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(requests[0]?.authorization, "Bearer good-key-1234");
});

test("model-key routes are owner-scoped and a read never leaks the key", async (t) => {
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
  });
  const token = await tokenFor(server);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const saved = await server.app.request("/api/agent/model-key", {
    method: "PUT",
    headers,
    body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-owner-key-WXYZ" }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    configured: true,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    hint: "WXYZ",
  });
  const read = await server.app.request("/api/agent/model-key", { headers });
  const body = await read.json();
  assert.deepEqual(body, {
    configured: true,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    hint: "WXYZ",
  });
  assert.ok(!JSON.stringify(body).includes("sk-ant-owner-key-WXYZ"));

  // A stranger's read sees nothing of the owner's key.
  const stranger = await server.app.request("/api/agent/model-key");
  assert.equal(stranger.status, 401);

  const removed = await server.app.request("/api/agent/model-key", { method: "DELETE", headers });
  assert.deepEqual(await removed.json(), { removed: true });
  const after = await server.app.request("/api/agent/model-key", { headers });
  assert.deepEqual(await after.json(), { configured: false });
});

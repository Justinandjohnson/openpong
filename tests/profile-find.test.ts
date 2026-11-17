import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { playerCandidates } from "../apps/server/src/engine/service.ts";
import type { OwnerProfile } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

/**
 * A minimal OmniPong stand-in: it answers the player search action and the
 * public USATT lookup so the "Find me" route can be exercised without a network.
 */
async function startOmnipong(t: TestContext) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    const send = (data: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.method === "POST" && url.pathname === "/agent/action") {
      // The vendored players table is known to hold duplicate rows.
      return send({
        status: "ok",
        action: "search",
        result: {
          status: "success",
          players: [
            { name: "Example Person", usatt_id: "111111", rating: "1500", state: "OH" },
            { name: "Example Person", usatt_id: "111111", rating: "1500", state: "OH" },
          ],
        },
      });
    }
    if (request.method === "GET" && url.pathname === "/tools/lookup/usatt") {
      return send({
        status: "success",
        player: { name: "Example Person", usatt_id: "111111", rating: 1500, state: "OH" },
        rating_history: [],
        tournaments: [],
      });
    }
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
  return { seen, url: `http://127.0.0.1:${address.port}` };
}

async function appFor(t: TestContext, omnipongUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "openpong-profile-find-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
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
    omnipongServiceUrl: omnipongUrl,
  };
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = await server.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(session.status, 200);
  const token = (await session.json()).token as string;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    config,
    db,
    server,
    get: (path: string) => server.app.request(`/api/agent${path}`, { headers }),
    post: (path: string, body?: unknown) =>
      server.app.request(`/api/agent${path}`, {
        method: "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    put: (path: string, body: unknown) =>
      server.app.request(`/api/agent${path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      }),
  };
}

test("playerCandidates normalises and deduplicates across upstream shapes", () => {
  const candidates = playerCandidates(
    {
      status: "success",
      players: [
        { name: "Example Person", usatt_id: "111111", rating: "1500", state: "OH" },
        { name: "Example Person", usatt_id: "111111", rating: "1500", state: "OH" },
      ],
    },
    { status: "success", player: { name: "Example Person", usatt_id: "111111", rating: 1500 } },
    { success: false, error: "No player found with valid data" },
    { name: "Another Person", full_name: "Another Person", usatt_number: "222222", rating: 1200 },
  );
  assert.deepEqual(candidates, [
    { name: "Example Person", usattId: "111111", rating: 1500, state: "OH" },
    { name: "Another Person", usattId: "222222", rating: 1200 },
  ]);
});

test("POST /profile/find returns every distinct candidate and never picks one", async (t) => {
  const stub = await startOmnipong(t);
  const app = await appFor(t, stub.url);
  const response = await app.post("/profile/find", { name: "Example Person" });
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { candidates: unknown[] };
  assert.deepEqual(body.candidates, [
    { name: "Example Person", usattId: "111111", rating: 1500, state: "OH" },
  ]);
  assert.ok(
    stub.seen.some((line) => line.startsWith("POST /agent/action")),
    "the OmniPong search was tried",
  );
  assert.ok(
    stub.seen.some((line) => line.includes("/tools/lookup/usatt")),
    "the public USATT lookup was also tried",
  );
});

test("POST /profile/find never throws on a bad upstream", async (t) => {
  // Port 1 refuses immediately, so both sources fail fast.
  const app = await appFor(t, "http://127.0.0.1:1");
  const response = await app.post("/profile/find", { name: "Nobody Here" });
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { candidates: unknown[]; errors: string[] };
  assert.deepEqual(body.candidates, []);
  assert.ok(body.errors.length > 0, "the failure is reported, not hidden");
});

test("mergeProfile merges without clobbering and rejects a blank name", async (t) => {
  const stub = await startOmnipong(t);
  const app = await appFor(t, stub.url);
  const saved = await app.put("/profile", {
    displayName: "Example Person",
    cities: ["Springfield"],
    states: ["Ohio"],
  });
  assert.equal(saved.status, 200);

  const merged = await app.server.agent.mergeProfile("local-user", { usattId: "111111" });
  assert.equal(merged.displayName, "Example Person", "the name was not touched");
  assert.deepEqual(merged.cities, ["Springfield"], "an unmentioned field survives");
  assert.deepEqual(merged.states, ["Ohio"]);
  assert.equal(merged.usattId, "111111", "the mentioned field was added");

  // A patch with no name at all, and no saved name, is rejected and writes nothing.
  await assert.rejects(
    () => app.server.agent.mergeProfile("no-name-owner", { usattId: "222222" }),
    /name|expected string/i,
  );
  assert.equal(await app.server.agent.getProfile("no-name-owner"), null);
});

test("the save_my_profile chat tool writes the confirmed fields", async (t) => {
  await modelFixture(t, (index) =>
    index === 0
      ? {
          name: "save_my_profile",
          arguments: { display_name: "Example Person", usatt_id: "111111" },
        }
      : undefined,
  );
  const stub = await startOmnipong(t);
  const app = await appFor(t, stub.url);
  const conversation = new ConversationAgent(app.config, app.server.agent, "local-user");
  const input: RunAgentInput = {
    threadId: "profile-chat",
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "I am Example Person, set me up" }],
    tools: [],
    context: [],
    state: {},
  };
  const events: BaseEvent[] = await lastValueFrom(conversation.run(input).pipe(toArray()));
  assert.ok(events.some((event) => event.type === EventType.TOOL_CALL_RESULT));
  const profile = (await app.db.get<OwnerProfile>(
    "local-user",
    "agent-settings",
    "profile",
  )) as OwnerProfile | null;
  assert.equal(profile?.displayName, "Example Person");
  assert.equal(profile?.usattId, "111111");
});

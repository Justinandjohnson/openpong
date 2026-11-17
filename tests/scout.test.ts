import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Store } from "../apps/server/src/db.ts";
import { createStore } from "../apps/server/src/db.ts";
import type {
  AgentNotification,
  AgentTask,
  ScoutSettings,
  ScoutView,
} from "../packages/domain/src/agent.ts";

/**
 * A minimal OmniPong stand-in: only the read-only `/tournaments` list the daily
 * scout uses. Every read is counted so a test can prove that a disabled scout
 * never touches the service.
 */
async function startOmnipong(t: TestContext, tournaments: Record<string, unknown>[] = []) {
  let list = tournaments;
  let reads = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (data: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.method === "GET" && url.pathname === "/tournaments") {
      reads += 1;
      return send(list);
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
  return {
    url: `http://127.0.0.1:${address.port}`,
    get reads() {
      return reads;
    },
    setTournaments(next: Record<string, unknown>[]) {
      list = next;
    },
  };
}

async function appFor(t: TestContext, omnipongUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "openpong-scout-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const app = await createApp(db, {
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
    omnipongServiceUrl: omnipongUrl,
  });
  t.after(async () => {
    await app.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, db };
}

/** The three tournaments every test in this file starts from (stable ids). */
const baseTournaments = [
  { source_id: "T-tourney.asp?t=100&r=1", title: "Winter Open", city_state: "River City" },
  { source_id: "T-tourney.asp?t=200&r=1", title: "Spring Open", city_state: "Lake City" },
];

async function enableScout(db: Store, patch: Partial<ScoutSettings> = {}) {
  await db.put("owner", "agent-settings", {
    id: "scout",
    enabled: true,
    // The current local hour makes the next daily slot ~24h away, so the
    // reschedule assertion below is meaningful rather than time-of-day dependent.
    hour: new Date().getHours(),
    nextRunAt: new Date(0).toISOString(),
    seenTournamentIds: [],
    ...patch,
  } satisfies ScoutSettings);
}

/** Make the already-enabled scout due again, without waiting a day. */
let dueCounter = 0;
async function makeDue(db: Store) {
  const settings = await db.get<ScoutSettings>("owner", "agent-settings", "scout");
  assert.ok(settings, "the scout settings exist");
  // A distinct past slot each time, like consecutive days would be: the task id
  // is derived from the schedule slot, so reusing one would replay the old task.
  dueCounter += 1;
  await db.compareAndSwap<ScoutSettings>(
    "owner",
    "agent-settings",
    "scout",
    { nextRunAt: settings.nextRunAt },
    { nextRunAt: new Date(Date.now() - dueCounter * 60000).toISOString(), enabled: true },
  );
}

const notifications = (db: Store) =>
  db.list<AgentNotification>("owner", "notifications") as Promise<AgentNotification[]>;
const scoutTasks = async (db: Store) =>
  (await db.list<AgentTask>("owner", "tasks")).filter((task) => task.kind === "scout");

test("the daily scout announces new tournaments, then dedupes exactly", async (t) => {
  const stub = await startOmnipong(t, baseTournaments);
  const { app, db } = await appFor(t, stub.url);
  await enableScout(db);

  // (a) A due scout runs as a durable task and announces each new tournament.
  await app.agent.worker.tick();
  const first = await notifications(db);
  assert.equal(first.length, 2, "one notification per newly found tournament");
  assert.deepEqual(
    first.map((notification) => notification.body).sort(),
    ["New tournament in your area: Spring Open", "New tournament in your area: Winter Open"].sort(),
  );
  const ran = await scoutTasks(db);
  assert.equal(ran.length, 1);
  assert.equal(ran[0]?.title, "Daily tournament scout");
  assert.equal(ran[0]?.status, "succeeded", ran[0]?.error ?? undefined);
  assert.match(String(ran[0]?.result), /Winter Open/);
  assert.deepEqual((await db.get<ScoutSettings>("owner", "agent-settings", "scout"))?.lastResult, {
    found: 2,
    newCount: 2,
  });

  // (b) The same data on the next day's run notifies ZERO times.
  await makeDue(db);
  await app.agent.worker.tick();
  assert.equal((await notifications(db)).length, 2, "a repeat run must notify nobody");
  assert.deepEqual((await db.get<ScoutSettings>("owner", "agent-settings", "scout"))?.lastResult, {
    found: 2,
    newCount: 0,
  });

  // (c) A genuinely new tournament is announced exactly once.
  stub.setTournaments([
    ...baseTournaments,
    { source_id: "T-tourney.asp?t=300&r=1", title: "Summer Open", city_state: "Hill City" },
  ]);
  await makeDue(db);
  await app.agent.worker.tick();
  const all = await notifications(db);
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.filter((notification) => notification.body.includes("Summer Open")).map((n) => n.body),
    ["New tournament in your area: Summer Open"],
    "the new tournament is announced once and only once",
  );
  assert.deepEqual((await db.get<ScoutSettings>("owner", "agent-settings", "scout"))?.lastResult, {
    found: 3,
    newCount: 1,
  });

  // A fourth pass (same data again) still adds nothing.
  await makeDue(db);
  await app.agent.worker.tick();
  assert.equal((await notifications(db)).length, 3);

  // (d) Rescheduling moves the next run a day forward, on the owner's hour.
  const settings = await db.get<ScoutSettings>("owner", "agent-settings", "scout");
  assert.ok(settings?.lastRunAt && settings.nextRunAt);
  const delta = Date.parse(settings.nextRunAt) - Date.parse(settings.lastRunAt);
  assert.ok(delta > 22 * 60 * 60 * 1000, `next run is about a day ahead (${delta}ms)`);
  assert.ok(delta <= 25 * 60 * 60 * 1000, `next run is about a day ahead (${delta}ms)`);
  assert.equal(new Date(settings.nextRunAt).getHours(), settings.hour);
  assert.deepEqual(settings.seenTournamentIds.sort(), [
    "T-tourney.asp?t=100&r=1",
    "T-tourney.asp?t=200&r=1",
    "T-tourney.asp?t=300&r=1",
  ]);
});

test("a disabled scout creates no task and never reads the service", async (t) => {
  const stub = await startOmnipong(t, baseTournaments);
  const { app, db } = await appFor(t, stub.url);
  await enableScout(db, { enabled: false });

  await app.agent.worker.tick();

  assert.equal((await scoutTasks(db)).length, 0, "no scout task is queued");
  assert.equal((await notifications(db)).length, 0, "no notification is raised");
  assert.equal(stub.reads, 0, "the service is not read");
});

test("the manual trigger runs now even while the daily switch is off", async (t) => {
  const stub = await startOmnipong(t, baseTournaments);
  const { app, db } = await appFor(t, stub.url);

  await app.agent.runScoutNow("owner");
  await app.agent.worker.tick();

  const task = (await scoutTasks(db))[0];
  assert.equal(task?.status, "succeeded", task?.error ?? undefined);
  assert.equal((await notifications(db)).length, 2);
  assert.equal(stub.reads, 1);
  assert.equal((await app.agent.scoutView("owner")).enabled, false, "the switch stays off");
});

test("the scout setting is owner-scoped, validated, and reports its last run", async (t) => {
  const stub = await startOmnipong(t, baseTournaments);
  const { app } = await appFor(t, stub.url);
  const session = await app.app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const token = (await session.json()).token;
  const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  const read = async (path: string) => {
    const response = await app.app.request(`/api/agent${path}`, { headers: headers() });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as ScoutView;
  };

  // Defaults: off, 08:00, nothing seen yet.
  const initial = await read("/scout");
  assert.deepEqual(
    { enabled: initial.enabled, hour: initial.hour, seenCount: initial.seenCount },
    { enabled: false, hour: 8, seenCount: 0 },
  );

  const saved = await app.app.request("/api/agent/scout", {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ enabled: true, hour: 7 }),
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const view = (await saved.json()) as ScoutView;
  assert.equal(view.enabled, true);
  assert.equal(view.hour, 7);
  assert.ok(view.nextRunAt, "enabling writes the next daily run");

  const invalid = await app.app.request("/api/agent/scout", {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ hour: 24 }),
  });
  assert.equal(invalid.status, 400, "an hour outside 0-23 is rejected");
  assert.equal((await read("/scout")).hour, 7, "the rejected write changed nothing");

  const run = await app.app.request("/api/agent/scout/run", {
    method: "POST",
    headers: headers(),
  });
  assert.equal(run.status, 201, await run.clone().text());
  const { task } = (await run.json()) as { task: AgentTask };
  assert.equal(task.kind, "scout");
  await app.agent.worker.tick();
  const after = await read("/scout");
  assert.ok(after.lastRunAt, "the last run is reported");
  assert.deepEqual(after.lastResult, { found: 2, newCount: 2 });
  assert.equal(after.seenCount, 2);
});

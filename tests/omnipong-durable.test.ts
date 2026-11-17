import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentNotification, AgentTask, Monitor } from "../packages/domain/src/agent.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { modelFixture } from "./helpers/model.ts";

type Call = { action: string; params: Record<string, unknown> };

/**
 * A minimal stand-in for the OmniPong FastAPI service. It records every
 * `/agent/action` call so a test can prove what was (and was not) run, and it
 * lets the `check` scout response change between passes.
 */
async function startOmnipong(t: TestContext, options: { tournaments?: unknown[] } = {}) {
  const calls: Call[] = [];
  const leagueSyncs: Record<string, unknown>[] = [];
  let checkResult: unknown = { status: "success", notified: [] };
  let tournamentList: unknown[] = options.tournaments ?? [];
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
      const action = parsed.action ?? "";
      const params = parsed.params ?? {};
      calls.push({ action, params });
      if (action === "sync")
        return send({
          status: "ok",
          action,
          result: { status: "success", message: "full sync complete" },
        });
      if (action === "signup")
        return send({
          status: "ok",
          action,
          result: {
            status: "success",
            message: "Signed up for 1 events",
            events_selected: params.events ?? ["Open Singles"],
          },
        });
      if (action === "check") return send({ status: "ok", action, result: checkResult });
      return send({ status: "ok", action, result: {} });
    }
    if (request.method === "GET" && url.pathname === "/tournaments") return send(tournamentList);
    if (request.method === "POST" && url.pathname === "/tools/sync/league") {
      leagueSyncs.push(JSON.parse(body || "{}") as Record<string, unknown>);
      return send({
        status: "success",
        message: "League match history synced",
        leagues: [{ cards_seen: 2, matches_seen: 6, owner_matches: 3, mode: "public" }],
        inserted: 3,
        skipped_duplicates: 1,
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
  return {
    calls,
    leagueSyncs,
    url: `http://127.0.0.1:${address.port}`,
    setCheck(result: unknown) {
      checkResult = result;
    },
    /** The read-only tournament list the monitor's area read returns. */
    setTournaments(list: unknown[]) {
      tournamentList = list;
    },
  };
}

async function appFor(t: TestContext, omnipongUrl: string, extras: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openpong-durable-"));
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
    ...extras,
  });
  t.after(async () => {
    await app.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, db };
}

test("sync_data runs the OmniPong sync under the durable task and records a receipt", async (t) => {
  const stub = await startOmnipong(t);
  const { app } = await appFor(t, stub.url);
  await modelFixture(
    t,
    (index) =>
      [
        { name: "sync_data", arguments: {} },
        { name: "finish_task", arguments: { summary: "Synced the OmniPong data." } },
      ][index],
  );

  const task = await app.agent.createTask("owner", {
    prompt: "Sync my table-tennis data",
    kind: "agent",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(saved.result, "Synced the OmniPong data.");
  assert.equal(stub.calls.filter((call) => call.action === "sync").length, 1);
  assert.ok(
    saved.evidence.some((item) => item.title === "OmniPong data sync"),
    "the sync is recorded as task evidence",
  );
});

test("sync_league uses the saved league URL and reuses a completed sync on retry", async (t) => {
  const stub = await startOmnipong(t);
  const { app } = await appFor(t, stub.url);
  await app.agent.saveProfile("owner", {
    displayName: "Owner One",
    leagueUrls: ["https://stadiumtt.com/league/one"],
  });
  await modelFixture(
    t,
    (index) =>
      [
        { name: "sync_league", arguments: {} },
        // The model retries the same call; the completed sync must be reused.
        { name: "sync_league", arguments: {} },
        { name: "finish_task", arguments: { summary: "Synced the league matches." } },
      ][index],
  );

  const task = await app.agent.createTask("owner", {
    prompt: "Refresh my league matches",
    kind: "agent",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(stub.leagueSyncs.length, 1, "a retry reuses the completed league sync");
  assert.deepEqual(stub.leagueSyncs[0], {
    league_urls: ["https://stadiumtt.com/league/one"],
    owner: "Owner One",
    legacy: false,
    all_matches: false,
    segments: true,
  });
  assert.ok(
    saved.evidence.some((item) => item.title === "OmniPong league sync"),
    "the league sync is recorded as task evidence",
  );
});

test("sync_league refuses to guess a league when the profile has no league URL", async (t) => {
  const stub = await startOmnipong(t);
  const { app } = await appFor(t, stub.url);
  await modelFixture(
    t,
    (index) =>
      [
        { name: "sync_league", arguments: {} },
        { name: "finish_task", arguments: { summary: "No league URL was saved." } },
      ][index],
  );

  const task = await app.agent.createTask("owner", {
    prompt: "Refresh my league matches",
    kind: "agent",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(stub.leagueSyncs.length, 0, "no league sync runs without a saved URL");
  assert.equal(
    saved.evidence.some((item) => item.title === "OmniPong league sync"),
    false,
    "nothing was synced, so there is no sync evidence",
  );
});

test("signup_tournament is a dry run that registers nobody", async (t) => {
  const stub = await startOmnipong(t, {
    tournaments: [
      {
        title: "Winter Open",
        date_range: "Dec 12",
        city_state: "Plano, TX",
        url: "https://example.test/winter",
        events: [{ name: "Open Singles" }, { name: "Under 1500" }],
      },
    ],
  });
  const { app, db } = await appFor(t, stub.url);
  await modelFixture(
    t,
    (index) =>
      [
        { name: "signup_tournament", arguments: { title: "Winter Open" } },
        { name: "finish_task", arguments: { summary: "Previewed the registration." } },
      ][index],
  );

  // The preview reads the area list and reports what a registration WOULD enter.
  const preview = await app.agent.previewSignup({ title: "Winter Open", events: [] });
  assert.equal(preview.mode, "dry_run");
  assert.equal(preview.registered, false);
  assert.deepEqual(preview.wouldRegister.title, "Winter Open");
  assert.deepEqual(
    preview.wouldRegister.events,
    ["Open Singles", "Under 1500"],
    "the preview names the events the list offers",
  );
  assert.equal(preview.tournament?.title, "Winter Open");

  const task = await app.agent.createTask("owner", {
    prompt: "Sign me up for the Winter Open",
    kind: "agent",
  });
  await app.agent.worker.tick();

  const saved = await app.agent.getTask("owner", task.id);
  assert.equal(saved.status, "succeeded", saved.error ?? saved.question);
  assert.equal(
    stub.calls.filter((call) => call.action === "signup").length,
    0,
    "a dry run must never call the signup action",
  );
  assert.equal((await db.list<ActionProposal>("owner", "actions")).length, 0);
});

test("a real signup waits for human approval and only then registers", async (t) => {
  const stub = await startOmnipong(t);
  const { app, db } = await appFor(t, stub.url, { omnipongAllowRealSignup: true });
  await modelFixture(
    t,
    (index) =>
      [
        {
          name: "signup_tournament",
          arguments: { title: "Winter Open", events: ["Open Singles"] },
        },
        { name: "finish_task", arguments: { summary: "Registered after approval." } },
      ][index],
  );

  const task = await app.agent.createTask("owner", {
    prompt: "Sign me up for the Winter Open",
    kind: "agent",
  });
  await app.agent.worker.tick();

  const pending = await app.agent.getTask("owner", task.id);
  assert.equal(pending.status, "waiting_approval", pending.error ?? pending.question);
  assert.ok(pending.actionId, "a review is prepared");
  assert.equal(
    stub.calls.filter((call) => call.action === "signup").length,
    0,
    "no registration happens before approval",
  );

  const proposal = await db.get<ActionProposal>("owner", "actions", pending.actionId);
  assert.ok(proposal);
  assert.equal(proposal.kind, "omnipong.signup");
  assert.equal(proposal.status, "awaiting_review");

  const approved = await app.actions.decide("owner", proposal.id, proposal.hash, "approve");
  assert.equal(approved.status, "succeeded", approved.error);
  const signups = stub.calls.filter((call) => call.action === "signup");
  assert.equal(signups.length, 1, "approval runs exactly one real registration");
  assert.deepEqual(signups[0]?.params, { title: "Winter Open", events: ["Open Singles"] });

  await app.agent.worker.tick();
  const finished = await app.agent.getTask("owner", task.id);
  assert.equal(finished.status, "succeeded", finished.error ?? finished.question);
  assert.equal(finished.actionId, null);
  assert.match(String(finished.state.approvalResult), /Winter Open/);
});

test("a real signup cannot register after the server disables real signup", async (t) => {
  const stub = await startOmnipong(t);
  const { app, db } = await appFor(t, stub.url, { omnipongAllowRealSignup: true });
  await modelFixture(
    t,
    (index) =>
      [
        {
          name: "signup_tournament",
          arguments: { title: "Winter Open", events: ["Open Singles"] },
        },
        { name: "finish_task", arguments: { summary: "Registered." } },
      ][index],
  );

  const task = await app.agent.createTask("owner", {
    prompt: "Sign me up for the Winter Open",
    kind: "agent",
  });
  await app.agent.worker.tick();

  const pending = await app.agent.getTask("owner", task.id);
  assert.equal(pending.status, "waiting_approval", pending.error ?? pending.question);
  const proposal = await db.get<ActionProposal>("owner", "actions", pending.actionId!);
  assert.ok(proposal);

  // The operator turns real signup off after this review was prepared. The
  // execution-time check must still refuse, so the flag cannot be bypassed by a
  // stale or directly-created approval.
  app.agent.config.omnipongAllowRealSignup = false;
  const decided = await app.actions.decide("owner", proposal.id, proposal.hash, "approve");

  assert.equal(decided.status, "failed");
  assert.match(String(decided.error), /disabled/i);
  assert.equal(
    stub.calls.filter((call) => call.action === "signup").length,
    0,
    "disabling the flag after preparation still blocks registration",
  );
});

test("watch_tournament announces each new tournament once and dedupes repeats", async (t) => {
  const stub = await startOmnipong(t);
  const { app, db } = await appFor(t, stub.url);

  const monitor = await app.agent.createTournamentMonitor("owner", {
    region: "local",
    keywords: [],
  });
  assert.equal(monitor.kind, "tournament");
  const taskId = monitor.taskId;

  stub.setTournaments([{ title: "Winter Open" }, { title: "Spring Open" }]);
  await app.agent.worker.tick();

  const first = await db.list<AgentNotification>("owner", "notifications");
  assert.deepEqual(
    first.map((notification) => notification.body).sort(),
    ["New local area tournament: Winter Open", "New local area tournament: Spring Open"].sort(),
  );

  // The same pass must not announce the same tournament twice.
  await makeDue(db, taskId);
  await app.agent.worker.tick();
  assert.equal((await db.list<AgentNotification>("owner", "notifications")).length, 2);

  // A newly-appearing tournament is announced, and only it.
  stub.setTournaments([
    { title: "Winter Open" },
    { title: "Spring Open" },
    { title: "Summer Open" },
  ]);
  await makeDue(db, taskId);
  await app.agent.worker.tick();
  const all = await db.list<AgentNotification>("owner", "notifications");
  assert.equal(all.length, 3);
  assert.ok(
    all.some((notification) => notification.body === "New local area tournament: Summer Open"),
  );

  const savedMonitor = await db.get<Monitor>("owner", "monitors", monitor.id);
  assert.equal(savedMonitor?.checks, 3);
});

test("watch_tournament only announces titles matching its keywords", async (t) => {
  const stub = await startOmnipong(t);
  const { app, db } = await appFor(t, stub.url);

  const monitor = await app.agent.createTournamentMonitor("owner", {
    region: "local",
    keywords: ["open"],
  });
  stub.setTournaments([{ title: "Open Singles Classic" }, { title: "Junior Cup" }]);
  await app.agent.worker.tick();

  const notified = await db.list<AgentNotification>("owner", "notifications");
  assert.deepEqual(
    notified.map((notification) => notification.body),
    ["New local area tournament: Open Singles Classic"],
  );
  assert.equal((await db.get<AgentTask>("owner", "tasks", monitor.taskId))?.status, "scheduled");
});

async function makeDue(db: Awaited<ReturnType<typeof createStore>>, taskId: string) {
  await db.compareAndSwap(
    "owner",
    "tasks",
    taskId,
    { status: "scheduled" },
    {
      nextRunAt: new Date(0).toISOString(),
    },
  );
}

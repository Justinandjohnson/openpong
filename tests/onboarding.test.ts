import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import {
  areaFor,
  narrowTournaments,
  resolveTournamentRegion,
} from "../apps/server/src/onboarding/area.ts";
import { type OwnerProfile, ownerProfileSchema } from "../packages/domain/src/agent.ts";
import { modelFixture } from "./helpers/model.ts";

type Tournament = Record<string, unknown>;

/**
 * A minimal OmniPong stand-in. It records the `/tournaments` query string so a
 * test can prove which region (or none) the server sent, and serves one `/user`.
 */
async function startOmnipong(t: TestContext, tournaments: Tournament[] = []) {
  const lists: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (data: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.method === "GET" && url.pathname === "/tournaments") {
      lists.push(url.search);
      return send(tournaments);
    }
    if (request.method === "GET" && url.pathname === "/user")
      return send({ full_name: "Someone", rating: 1200 });
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
  return { lists, url: `http://127.0.0.1:${address.port}` };
}

async function appFor(t: TestContext, omnipongUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "openpong-onboarding-"));
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
  const call = (method: string, path: string, body?: unknown) =>
    server.app.request(`/api/agent${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    config,
    server,
    get: (path: string) => call("GET", path),
    put: (path: string, body: unknown) => call("PUT", path, body),
  };
}

function runInput(): RunAgentInput {
  return {
    threadId: "onboarding-chat",
    runId: randomUUID(),
    messages: [
      { id: randomUUID(), role: "user", content: "What table-tennis tournaments are coming up?" },
    ],
    tools: [],
    context: [],
    state: {},
  };
}

const exampleProfile = {
  displayName: "Example Person",
  usattId: "1234567",
  homeRegion: "8",
  cities: ["Springfield", "Shelbyville"],
  states: ["Ohio"],
  clubs: ["Example Table Tennis Club"],
  leagueUrls: ["https://stadiumtt.com"],
};

test("a fresh owner is not onboarded and the profile round-trips through the API", async (t) => {
  const stub = await startOmnipong(t);
  const server = await appFor(t, stub.url);

  const before = await server.get("/profile");
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), { profile: null, onboarded: false });

  const saved = await server.put("/profile", exampleProfile);
  assert.equal(saved.status, 200, await saved.clone().text());
  const stored = (await saved.json()) as OwnerProfile;
  assert.equal(stored.id, "profile");
  assert.equal(stored.displayName, exampleProfile.displayName);
  assert.equal(stored.usattId, exampleProfile.usattId);
  assert.equal(stored.homeRegion, exampleProfile.homeRegion);
  assert.deepEqual(stored.cities, exampleProfile.cities);
  assert.deepEqual(stored.states, exampleProfile.states);
  assert.deepEqual(stored.clubs, exampleProfile.clubs);
  assert.deepEqual(stored.leagueUrls, exampleProfile.leagueUrls);
  assert.ok(Number.isFinite(Date.parse(stored.updatedAt)));

  const after = await server.get("/profile");
  assert.equal(after.status, 200);
  const readBack = (await after.json()) as { profile: OwnerProfile | null; onboarded: boolean };
  assert.equal(readBack.onboarded, true);
  assert.deepEqual(readBack.profile, stored, "the stored profile is exactly what was saved");

  // An edit round-trips too, and a blank optional field is dropped, not saved.
  const edited = await server.put("/profile", {
    displayName: "  Someone Else  ",
    homeRegion: "  ",
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const editedProfile = (await edited.json()) as OwnerProfile;
  assert.equal(editedProfile.displayName, "Someone Else");
  assert.equal(editedProfile.homeRegion, undefined);
  assert.equal(editedProfile.leagueUrls, undefined);
  assert.equal(editedProfile.id, "profile");
});

test("invalid profile input is rejected with 400 and nothing is stored", async (t) => {
  const stub = await startOmnipong(t);
  const server = await appFor(t, stub.url);

  for (const invalid of [
    {},
    { displayName: "" },
    { displayName: "   " },
    { displayName: "A".repeat(200) },
    { displayName: "Someone", leagueUrls: ["not a url"] },
    { displayName: "Someone", leagueUrls: ["https://stadiumtt.com", 42] },
    { displayName: "Someone", cities: "Springfield" },
    { displayName: "Someone", usattId: 1184417 },
  ]) {
    const response = await server.put("/profile", invalid);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(invalid)}`);
    const body = (await response.json()) as { error?: string };
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  }

  const profile = await server.get("/profile");
  assert.deepEqual(await profile.json(), { profile: null, onboarded: false });
});

async function askForTournaments(t: TestContext, server: Awaited<ReturnType<typeof appFor>>) {
  await modelFixture(t, (index) =>
    index === 0 ? { name: "list_tournaments", arguments: {} } : undefined,
  );
  const conversation = new ConversationAgent(server.config, server.server.agent, "local-user");
  const events = await lastValueFrom(conversation.run(runInput()).pipe(toArray()));
  const ran = events.some((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(ran, "the tool ran and returned a result to the model");
}

test("list_tournaments defaults to the profile region", async (t) => {
  const stub = await startOmnipong(t, [
    { title: "Springfield Open", city_state: "Springfield, OH", date_range: "Dec 1" },
  ]);
  const server = await appFor(t, stub.url);
  const saved = await server.put("/profile", exampleProfile);
  assert.equal(saved.status, 200, await saved.clone().text());

  await askForTournaments(t, server);
  assert.equal(stub.lists.length, 1);
  assert.equal(stub.lists[0], "?region=8", "the saved home region is the default filter");
});

test("list_tournaments passes no region when the owner has not set one", async (t) => {
  const stub = await startOmnipong(t, [
    { title: "Springfield Open", city_state: "Springfield, OH", date_range: "Dec 1" },
  ]);
  const server = await appFor(t, stub.url);

  await askForTournaments(t, server);
  assert.equal(stub.lists.length, 1);
  assert.equal(stub.lists[0], "", "no region literal is invented by this server");
});

test("a tournament watch takes its region from the profile, never a literal", async (t) => {
  const stub = await startOmnipong(t);
  const server = await appFor(t, stub.url);

  // No profile and no argument: the monitor has no region and says "your area".
  const first = await server.server.agent.createTournamentMonitor("local-user", {});
  assert.equal(first.region, undefined);
  assert.equal(first.title, "Watch your area tournaments");

  // A saved home region becomes the monitor's region.
  assert.equal((await server.put("/profile", exampleProfile)).status, 200);
  const second = await server.server.agent.createTournamentMonitor("local-user", {
    keywords: ["Open"],
  });
  assert.equal(second.region, "8");
  assert.equal(second.title, "Watch 8 area tournaments: Open");

  // An explicit argument still wins over the profile.
  const third = await server.server.agent.createTournamentMonitor("local-user", { region: "3" });
  assert.equal(third.region, "3");
});

test("area helpers resolve the region from the profile and narrow by city/state", () => {
  const area = areaFor(exampleProfile);
  assert.equal(area.region, "8");
  assert.deepEqual(area.cities, ["Springfield", "Shelbyville"]);
  assert.deepEqual(area.states, ["Ohio"]);

  assert.equal(resolveTournamentRegion(undefined, area), "8");
  assert.equal(resolveTournamentRegion("3", area), "3");
  assert.equal(resolveTournamentRegion("   ", area), "8");
  assert.equal(resolveTournamentRegion(undefined, areaFor(null)), undefined);
  assert.deepEqual(areaFor(null), { cities: [], states: [] });

  const rows = [
    { title: "Springfield Open", city_state: "Springfield, OH" },
    { title: "Dayton Classic", city_state: "Dayton, OH" },
    { title: "Reno Cup", city_state: "Reno, NV" },
  ];
  assert.deepEqual(
    narrowTournaments(rows, area).map((row) => row.title),
    ["Springfield Open", "Dayton Classic"],
    "another Ohio city stays; another state does not",
  );

  // A two-letter state must be its own token: "IN" must not match "Minneapolis".
  assert.deepEqual(
    narrowTournaments(
      [
        { title: "Indy Open", city_state: "Indianapolis, IN" },
        { title: "Minneapolis Cup", city_state: "Minneapolis, MN" },
      ],
      { cities: [], states: ["IN"] },
    ).map((row) => row.title),
    ["Indy Open"],
  );

  // Soft filter: unmatched rows are kept rather than hiding the whole list.
  assert.deepEqual(
    narrowTournaments([{ title: "Reno Cup", city_state: "Reno, NV" }], area).map(
      (row) => row.title,
    ),
    ["Reno Cup"],
  );
});

test("the example profile is labelled fixture data, not a default identity", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../apps/server/src/onboarding/example-profile.json", import.meta.url),
      "utf8",
    ),
  ) as { $note: string; profile: unknown };
  assert.match(fixture.$note, /EXAMPLE DATA ONLY/i);
  const parsed = ownerProfileSchema.safeParse(fixture.profile);
  assert.ok(parsed.success, "the example profile is valid input for the same schema");
  assert.equal(parsed.data.displayName, "Justin Johnson");
});

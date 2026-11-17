import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { OmniPongError, OmniPongService } from "../apps/server/src/omnipong/service.ts";

type Call = { url: string; init?: RequestInit };

/** Stub fetch, capturing every request so URL/headers/body can be asserted without network. */
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

function headersOf(call: Call) {
  return call.init?.headers as Record<string, string>;
}

test("listActions reads /agent/actions and sends no auth without a token", async () => {
  const { calls, fetchImpl } = stubFetch(() => json({ actions: ["check", "matches", "search"] }));
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  assert.deepEqual(await service.listActions(), ["check", "matches", "search"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8000/agent/actions");
  assert.equal(calls[0].init?.method, "GET");
  assert.equal(headersOf(calls[0]).accept, "application/json");
  assert.equal(headersOf(calls[0]).authorization, undefined);
});

test("a configured token is sent as a bearer Authorization header", async () => {
  const { calls, fetchImpl } = stubFetch(() => json({ full_name: "A", rating: 1304 }));
  const service = new OmniPongService({
    baseUrl: "http://127.0.0.1:8000/",
    token: "secret-token",
    fetchImpl,
  });
  assert.deepEqual(await service.getUser(), { full_name: "A", rating: 1304 });
  // A trailing slash on the configured base URL must not leak into the path.
  assert.equal(calls[0].url, "http://127.0.0.1:8000/user");
  assert.equal(headersOf(calls[0]).authorization, "Bearer secret-token");
});

test("runAction posts the action and params and unwraps the result", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    json({ status: "ok", action: "search", result: { status: "success", players: [] } }),
  );
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  assert.deepEqual(await service.runAction("search", { name: "Jane Doe" }), {
    status: "success",
    players: [],
  });
  assert.equal(calls[0].url, "http://127.0.0.1:8000/agent/action");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    calls[0].init?.body,
    JSON.stringify({ action: "search", params: { name: "Jane Doe" } }),
  );
  assert.equal(headersOf(calls[0])["content-type"], "application/json");
});

test("syncLeague posts saved league URLs and always asks for the segment cross-check", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    json({
      status: "success",
      message: "League match history synced",
      leagues: [{ cards_seen: 3, matches_seen: 12, completeness: { ok: true } }],
      inserted: 8,
      some_future_field: { kept: true },
    }),
  );
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  const result = await service.syncLeague({
    leagueUrls: [" https://stadiumtt.com/league/1 ", ""],
    owner: "Owner One",
    allMatches: true,
    segments: false,
  });

  assert.equal(calls[0].url, "http://127.0.0.1:8000/tools/sync/league");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    league_urls: ["https://stadiumtt.com/league/1"],
    owner: "Owner One",
    legacy: false,
    all_matches: true,
    // Always on, regardless of the caller's flag.
    segments: true,
  });
  assert.equal(result.status, "success");
  assert.equal(result.inserted, 8);
  assert.deepEqual(
    result.some_future_field,
    { kept: true },
    "unexpected response fields survive instead of failing the tool",
  );
});

test("syncLeague sends no guessed league and no owner when the caller has none", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    json({ status: "error", message: "No league configured.", leagues: [] }),
  );
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  const result = await service.syncLeague();
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    league_urls: null,
    owner: null,
    legacy: false,
    all_matches: false,
    segments: true,
  });
  assert.equal(result.status, "error");
});

test("searchPlayer maps to the search action", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    json({ status: "ok", action: "search", result: {} }),
  );
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  await service.searchPlayer("Jane Doe");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    action: "search",
    params: { name: "Jane Doe" },
  });
});

test("read endpoints forward source and encode path segments", async () => {
  // The first request returns a match, so a source-filtered read does not fall
  // back to all sources; this asserts source forwarding and path encoding only.
  let request = 0;
  const { calls, fetchImpl } = stubFetch(() => json(request++ === 0 ? [{ id: "m1" }] : []));
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  await service.getMatches("usatt");
  await service.getRatingHistory();
  assert.equal(calls[0].url, "http://127.0.0.1:8000/matches?source=usatt");
  assert.equal(calls[1].url, "http://127.0.0.1:8000/rating_history");

  const scouting = stubFetch(() => json({ player_name: "A B" }));
  await new OmniPongService({
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: scouting.fetchImpl,
  }).getScouting("A B/C");
  assert.equal(scouting.calls[0].url, "http://127.0.0.1:8000/players/A%20B%2FC/scouting");
});

test("a non-200 response becomes a clean OmniPongError with the service detail", async () => {
  const { fetchImpl } = stubFetch(() =>
    json({ detail: "Missing or invalid Authorization: Bearer token." }, 401),
  );
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  await assert.rejects(
    service.runAction("sync"),
    (error: unknown) =>
      error instanceof OmniPongError &&
      error.status === 401 &&
      /401/.test(error.message) &&
      /Authorization/.test(error.message),
  );
});

test("recordMatch posts a manual result and returns the saved row", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    json({ status: "success", match_id: 42, created: true }),
  );
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  const saved = await service.recordMatch({
    date: "2026-11-16",
    opponentName: "  Opponent One  ",
    opponentRating: 1450,
    result: "Win",
    scoreSummary: " 3-1 ",
    setScores: [11, 9, 9, 11, 11, 7, 11, 8],
  });

  assert.equal(calls[0].url, "http://127.0.0.1:8000/tools/matches");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    date: "2026-11-16",
    opponent_name: "Opponent One",
    opponent_rating: 1450,
    result: "Win",
    score_summary: "3-1",
    set_scores: [11, 9, 9, 11, 11, 7, 11, 8],
    source: "arcade",
  });
  assert.equal(saved.match_id, 42);
  assert.equal(saved.created, true);
});

test("recordMatch sends nulls for omitted details and accepts a duplicate", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    json({ status: "success", match_id: 7, created: false }),
  );
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  const saved = await service.recordMatch({
    date: "2026-11-16",
    opponentName: "Opponent One",
    result: "Loss",
  });
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    date: "2026-11-16",
    opponent_name: "Opponent One",
    opponent_rating: null,
    result: "Loss",
    score_summary: null,
    set_scores: null,
    source: "arcade",
  });
  assert.equal(saved.created, false);
});

test("recordMatch surfaces a validation failure as a clean OmniPongError", async () => {
  const { fetchImpl } = stubFetch(() => json({ detail: "date must be an ISO date" }, 400));
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  await assert.rejects(
    service.recordMatch({ date: "nope", opponentName: "A", result: "Win" }),
    (error: unknown) =>
      error instanceof OmniPongError && error.status === 400 && /ISO date/.test(error.message),
  );
});

test("POST /api/agent/matches rejects unauthenticated callers with 401", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openpong-matches-api-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const response = await server.app.request("/api/agent/matches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ date: "2026-11-16", opponent_name: "A", result: "Win" }),
  });
  assert.equal(response.status, 401, await response.clone().text());
});

test("an unexpected payload becomes a clean OmniPongError", async () => {
  const { fetchImpl } = stubFetch(() => json({ actions: "not an array" }));
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  await assert.rejects(service.listActions(), /unexpected response/);
});

test("getTournamentResults reads the public results page with the tournament and event ids", async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    json({ tournament_id: "100", event_id: "7", events: [], players: [] }),
  );
  const service = new OmniPongService({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
  await service.getTournamentResults(" 100 ", "7 ");
  assert.equal(calls[0].url, "http://127.0.0.1:8000/tools/results/omnipong?tid=100&eid=7");
});

test("getTournamentResults refuses a missing id instead of scraping an ambiguous page", async () => {
  const service = new OmniPongService({
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl: (async () => json({})) as typeof fetch,
  });
  await assert.rejects(() => service.getTournamentResults("100", " "), OmniPongError);
});

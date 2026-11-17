import assert from "node:assert/strict";
import { test } from "node:test";
import {
  searchUsattPlayers,
  USATT_TENANT_ID,
  USATT_TOURNAMENT_EVENT_TYPE,
} from "../apps/server/src/usatt.ts";

/** The live API's shape, trimmed to the fields we use. */
function body(players: unknown[], total = players.length) {
  return { success: true, data: { players, totalCount: total, hasMore: false } };
}

const amy = {
  playerName: "Wang, Amy",
  memberId: "76235",
  finalRating: 2556,
  address: "NJ",
  clubName: "888 Table Tennis Centerr",
  ratingRank: 83,
};

test("the national index is asked by name and answered as a candidate", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const result = await searchUsattPlayers("Amy Wang", {
    fetchImpl: (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify(body([amy])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(result.candidates, [
    {
      name: "Wang, Amy",
      source: "usatt",
      usattId: "76235",
      rating: 2556,
      state: "NJ",
      club: "888 Table Tennis Centerr",
    },
  ]);
  assert.equal(result.total, 1);
  const parsed = new URL(seenUrl);
  assert.equal(
    parsed.origin + parsed.pathname,
    "https://justgorestapi-prod-us.justgo.com/api/v1/events-results/rankings",
  );
  assert.equal(parsed.searchParams.get("SearchTerm"), "Amy Wang");
  assert.equal(parsed.searchParams.get("ResultEventTypeId"), USATT_TOURNAMENT_EVENT_TYPE);
  assert.equal(parsed.searchParams.get("All"), "0");
  assert.equal(seenHeaders["x-tenant-id"], USATT_TENANT_ID);
});

test("the requested page size is clamped to something sane", async () => {
  let seen = 0;
  const fetchImpl = (async (url: string) => {
    seen = Number(new URL(String(url)).searchParams.get("PageSize"));
    return new Response(JSON.stringify(body([])), { status: 200 });
  }) as unknown as typeof fetch;
  await searchUsattPlayers("Wang", { fetchImpl, limit: 5000 });
  assert.equal(seen, 100);
  await searchUsattPlayers("Wang", { fetchImpl, limit: 0 });
  assert.equal(seen, 1);
});

test("a name nobody has is an empty result, not an error", async () => {
  const result = await searchUsattPlayers("Zzz Nobody", {
    fetchImpl: (async () =>
      new Response(JSON.stringify(body([], 0)), { status: 200 })) as unknown as typeof fetch,
  });
  assert.deepEqual(result, { candidates: [], total: 0, hasMore: false });
});

test("a failing index is reported as a clean error", async () => {
  await assert.rejects(
    () =>
      searchUsattPlayers("Wang", {
        fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
      }),
    /USATT lookup failed \(500\)/,
  );
});

test("an unexpected payload is refused rather than half-read", async () => {
  await assert.rejects(
    () =>
      searchUsattPlayers("Wang", {
        fetchImpl: (async () =>
          new Response(JSON.stringify({ success: false, data: null }), {
            status: 200,
          })) as unknown as typeof fetch,
      }),
    /unexpected response/,
  );
});

test("a slow index gives up instead of hanging a chat turn", async () => {
  await assert.rejects(
    () =>
      searchUsattPlayers("Wang", {
        timeoutMs: 10,
        fetchImpl: ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          })) as unknown as typeof fetch,
      }),
    /timed out/,
  );
});

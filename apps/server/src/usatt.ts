import type { PlayerCandidate } from "./engine/service.ts";

/**
 * USATT's public player index, as served by the JustGo weblet behind
 * ratings.usatt.org. It answers by name (either order — "Amy Wang" finds
 * "Wang, Amy"), needs no login and returns USATT number, rating, state and
 * club. That makes it the one source that can answer for any name, so it is
 * preferred over the local scraped table when both know a person.
 */
export const USATT_RANKINGS_URL =
  "https://justgorestapi-prod-us.justgo.com/api/v1/events-results/rankings";

/** The weblet's tournament event type; the league type is a different guid. */
export const USATT_TOURNAMENT_EVENT_TYPE = "AA8491C6-C0EF-408E-9DE4-D141BCB42637";

/**
 * A public, non-secret tenant header the weblet sends. Without it the API
 * answers 500 rather than 401, so it is required in practice.
 */
export const USATT_TENANT_ID = "kHg2JkXVEINeqZNiNQiMtA==";

export interface UsattSearchOptions {
  limit?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface UsattSearchResult {
  candidates: PlayerCandidate[];
  total: number;
  hasMore: boolean;
}

const responseSchema = {
  parse(value: unknown): { players: unknown[]; total: number; hasMore: boolean } | null {
    if (!value || typeof value !== "object") return null;
    const body = value as Record<string, unknown>;
    if (body.success === false) return null;
    const data = body.data;
    if (!data || typeof data !== "object") return null;
    const row = data as Record<string, unknown>;
    return {
      players: Array.isArray(row.players) ? row.players : [],
      total: typeof row.totalCount === "number" ? row.totalCount : 0,
      hasMore: row.hasMore === true,
    };
  },
};

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function onePlayer(value: unknown): PlayerCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const name = text(row.playerName ?? row.name);
  if (!name) return null;
  const usattId = text(row.memberId ?? row.usattId);
  const rating = typeof row.finalRating === "number" ? row.finalRating : undefined;
  const state = text(row.address ?? row.state);
  const club = text(row.clubName ?? row.club);
  return {
    name,
    source: "usatt",
    ...(usattId ? { usattId } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(state ? { state } : {}),
    ...(club ? { club } : {}),
  };
}

/**
 * Search the national index by name or USATT number. A blank name returns the
 * top of the list (the API treats it as "everything"), so callers should not
 * ask for one.
 */
export async function searchUsattPlayers(
  name: string,
  options: UsattSearchOptions = {},
): Promise<UsattSearchResult> {
  const query = name.trim();
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(USATT_RANKINGS_URL);
  url.searchParams.set("PageSize", String(limit));
  url.searchParams.set("PageNumber", "1");
  url.searchParams.set("SearchTerm", query);
  url.searchParams.set("ResultEventTypeId", USATT_TOURNAMENT_EVENT_TYPE);
  url.searchParams.set("All", "0");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  if (options.signal)
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetchImpl(url.toString(), {
      headers: {
        accept: "application/json, text/plain, */*",
        "x-tenant-id": USATT_TENANT_ID,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`USATT lookup failed (${response.status})`);
    }
    const parsed = responseSchema.parse(await response.json());
    if (!parsed) throw new Error("USATT lookup returned an unexpected response");
    const candidates: PlayerCandidate[] = [];
    for (const raw of parsed.players) {
      const candidate = onePlayer(raw);
      if (candidate) candidates.push(candidate);
    }
    return { candidates, total: parsed.total, hasMore: parsed.hasMore };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The USATT lookup timed out.");
    }
    throw error instanceof Error ? error : new Error("The USATT lookup failed.");
  } finally {
    clearTimeout(timeout);
  }
}

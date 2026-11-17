import { NextResponse } from "next/server";
import {
  localMatches,
  localMatchSummary,
  localNotifications,
  localRatingHistory,
  localSearchPlayers,
  localStats,
  localTournaments,
  localUser,
} from "@/lib/server/local-corpus";
import { getOmniPong, postOmniPong } from "@/lib/server/openpong";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OpenPong data BFF.
 *
 * The browser never talks to the Python domain service (or the OpenPong server)
 * directly. Reads go here; the handler prefers the live OmniPong service and falls
 * back to the read-only local corpus when that service is empty (first run / demo).
 * Writes are limited to read-scoped agent actions — a real tournament signup is
 * deliberately refused and must go through the agent's approval flow in chat.
 */

const READ_PATHS = new Set([
  "user",
  "matches",
  "matches/summary",
  "stats",
  "rating_history",
  "tournaments",
  "notifications",
  "agent/actions",
  "training/recommendations",
  "tools/tournament_intelligence",
  "tools/context",
]);

const WRITE_PATHS = new Set(["agent/action", "tools/search/players", "tools/check-tournaments"]);

const rejected = (message: string, status = 400) =>
  NextResponse.json({ error: message }, { status });

function pathOf(segments: string[] | undefined): string {
  return (segments ?? []).join("/");
}

function upstreamQuery(url: URL): string {
  const allowed = new Set(["source", "region", "limit", "name", "deep", "scope", "q"]);
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) if (allowed.has(key)) params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function emptyCollection(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path: segments } = await context.params;
  const path = pathOf(segments);
  if (!READ_PATHS.has(path)) return rejected(`Unknown OpenPong data route: /${path}`, 404);

  const url = new URL(request.url);
  const upstreamPath = `/${path}${upstreamQuery(url)}`;
  const result = await getOmniPong(upstreamPath).catch(() => ({
    ok: false as const,
    status: 502,
    data: null,
  }));

  let data = result.data;

  // Graceful first-run fallback: a live service with an empty corpus defers to
  // the read-only local database, without ever changing the service.
  if (path === "user" && (!result.ok || data == null)) data = await localUser();
  if (path === "matches" && (!result.ok || emptyCollection(data))) {
    data = await localMatches(url.searchParams.get("source"));
  }
  if (
    path === "matches/summary" &&
    (!result.ok || (data as { overall?: { total?: number } })?.overall?.total === 0)
  ) {
    data = (await localMatchSummary(url.searchParams.get("source"))) ?? data;
  }
  if (
    path === "stats" &&
    (!result.ok ||
      ((data as { wins?: number; losses?: number })?.wins === 0 &&
        (data as { losses?: number })?.losses === 0))
  ) {
    data = (await localStats(url.searchParams.get("source"))) ?? data;
  }
  if (path === "rating_history" && (!result.ok || emptyCollection(data))) {
    data = await localRatingHistory(url.searchParams.get("source"));
  }
  if (path === "tournaments" && (!result.ok || emptyCollection(data))) {
    data = await localTournaments(url.searchParams.get("region"));
  }
  if (path === "notifications" && (!result.ok || emptyCollection(data))) {
    data = await localNotifications();
  }

  if (!result.ok && (data == null || (Array.isArray(data) && data.length === 0))) {
    return NextResponse.json(
      {
        error: "The OpenPong domain service is unreachable",
        detail: result.data,
        service: "OMNIPONG_SERVICE_URL",
      },
      { status: result.status || 502 },
    );
  }

  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path: segments } = await context.params;
  const path = pathOf(segments);
  if (path === "tournaments/signup") {
    return rejected(
      "Real signups are not available from the dashboard. Ask the OpenPong coach to prepare a signup, then approve it in chat.",
      403,
    );
  }
  if (!WRITE_PATHS.has(path)) return rejected(`Unknown OpenPong write route: /${path}`, 404);

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (path === "agent/action") {
    const action = (body as { action?: string })?.action;
    if (action === "signup") {
      return rejected("Real signups require an approval task. Ask the coach in chat.", 403);
    }
  }

  const result = await postOmniPong(`/${path}`, body).catch((error) => ({
    ok: false as const,
    status: 502,
    data: { error: error instanceof Error ? error.message : "Domain service unreachable" },
  }));

  if (
    path === "tools/search/players" &&
    (!result.ok || (result.data as { status?: string })?.status === "not_found")
  ) {
    const name = (body as { name?: string })?.name ?? "";
    const players = await localSearchPlayers(name);
    if (players.length)
      return NextResponse.json({ status: "success", players, source: "local-corpus" });
  }

  return NextResponse.json(result.data, {
    status: result.ok ? 200 : result.status || 502,
    headers: { "cache-control": "no-store" },
  });
}

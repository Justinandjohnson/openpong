import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start (or confirm) the one-click Google Calendar connection. Returns either
 * `{ connected: true }` when Google already is, or `{ url }` for the browser to
 * navigate to. The bearer and the client secret stay in this process.
 */
export async function POST() {
  try {
    const token = await requiredOpenPongToken();
    const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/google/calendar/connect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: "{}",
      timeoutMs: 15_000,
    });
    if (!result.ok) {
      const detail = (result.data as { error?: string } | null)?.error;
      return NextResponse.json(
        { error: detail ?? "Could not start the Google connection." },
        { status: result.status },
      );
    }
    return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "OpenPong server unreachable" },
      { status: 502 },
    );
  }
}

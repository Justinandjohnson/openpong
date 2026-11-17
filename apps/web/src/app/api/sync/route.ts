import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-tap league sync.
 *
 * The dashboard never picks a league or a player — the server reads both from
 * the owner's saved profile and queues a durable task, so this stays correct for
 * whoever is signed in. Returns the task id so the button can watch it settle.
 */
export async function POST() {
  try {
    const token = await requiredOpenPongToken();
    const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/agent/sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      const detail = (result.data as { error?: string } | null)?.error;
      return NextResponse.json(
        { error: typeof detail === "string" && detail ? detail : "Sync could not start" },
        { status: result.status || 502 },
      );
    }
    return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync unavailable" },
      { status: 502 },
    );
  }
}

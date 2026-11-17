import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Run the daily scout now, without waiting for its scheduled hour.
 *
 * The server queues the same durable task the schedule uses, so this returns the
 * queued task and the worker finishes it within a tick. Nothing is fetched or
 * announced from the browser.
 */
export async function POST() {
  try {
    const token = await requiredOpenPongToken();
    const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/agent/scout/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({}),
      timeoutMs: 15_000,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: "The scout could not be started", detail: result.data },
        { status: result.status },
      );
    }
    return NextResponse.json(result.data, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start the scout" },
      { status: 502 },
    );
  }
}

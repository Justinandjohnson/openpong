import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Agent workspace snapshot (identity, tasks, goals, monitors, notifications). */
export async function GET() {
  try {
    const token = await requiredOpenPongToken();
    const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/agent`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: "The OpenPong agent did not answer", detail: result.data },
        { status: result.status },
      );
    }
    return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent unavailable" },
      { status: 502 },
    );
  }
}

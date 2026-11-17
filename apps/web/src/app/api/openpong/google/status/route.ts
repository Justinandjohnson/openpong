import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether this server can start a Google consent, and whether the owner has
 * already connected. The bearer stays in this process; the browser only ever
 * sees this small shape, never a token or the client secret.
 */
export async function GET() {
  try {
    const token = await requiredOpenPongToken();
    const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/google/status`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      timeoutMs: 15_000,
    });
    if (!result.ok) {
      const detail = (result.data as { error?: string } | null)?.error;
      return NextResponse.json(
        { error: detail ?? "Could not read the Google connection." },
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

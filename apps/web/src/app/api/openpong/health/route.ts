import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await fetchJson(`${OPENPONG_SERVER_URL}/api/health`);
    return NextResponse.json(
      {
        ok: health.ok && (health.data as { ok?: boolean } | null)?.ok !== false,
        server: health.data ?? null,
        serverUrl: OPENPONG_SERVER_URL,
      },
      { status: health.ok ? 200 : 502, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "OpenPong server unreachable" },
      { status: 502 },
    );
  }
}

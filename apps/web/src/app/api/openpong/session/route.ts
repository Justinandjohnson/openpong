import { NextResponse } from "next/server";
import { createOpenPongToken, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { openPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side session endpoint. The browser posts here to establish its httpOnly
 * cookie; the real OpenPong bearer token stays in this process and is used by the
 * data + CopilotKit proxies. Mirrors the native app's `POST /api/session` flow.
 */
export async function POST() {
  try {
    const { sessionId, created } = await openPongToken();
    return NextResponse.json({ ok: true, session: sessionId.slice(0, 8), created });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not open an OpenPong session",
        server: OPENPONG_SERVER_URL,
      },
      { status: 502 },
    );
  }
}

export async function GET() {
  return POST();
}

/** Debug helper: proves the token flow without ever returning the token. */
export async function HEAD() {
  try {
    await createOpenPongToken();
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 502 });
  }
}

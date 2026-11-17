import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Begin Google sign-in. The server owns the OAuth secret and builds the consent
 * URL; the browser is sent straight there. The bearer never appears in a URL.
 */
export async function GET(request: Request) {
  const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/auth/google/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirectBase: new URL(request.url).origin }),
    timeoutMs: 15000,
  }).catch(() => ({ ok: false, status: 503, data: null }));

  const data = result.data as { url?: string; error?: string } | null;
  if (!result.ok || !data?.url) {
    return NextResponse.json(
      { error: data?.error ?? "Google sign-in is not available right now." },
      { status: result.status || 502 },
    );
  }
  return NextResponse.redirect(data.url, 302);
}

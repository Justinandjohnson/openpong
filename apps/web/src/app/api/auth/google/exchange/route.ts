import { NextResponse } from "next/server";
import { setAccountToken } from "@/lib/server/account";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Swap the one-time code from the Google callback for the account bearer, then
 * seal that bearer into the httpOnly cookie. This call is server-to-server, so
 * the bearer never reaches the browser.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { code?: string };
  if (!body.code) return NextResponse.json({ error: "Missing sign-in code." }, { status: 400 });

  const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/auth/google/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: body.code }),
    timeoutMs: 15000,
  }).catch(() => ({ ok: false, status: 503, data: null }));

  const data = result.data as { token?: string; account?: unknown; error?: string } | null;
  if (!result.ok || !data?.token) {
    return NextResponse.json(
      { error: data?.error ?? "Could not complete Google sign-in." },
      { status: result.status || 400 },
    );
  }
  await setAccountToken(data.token);
  return NextResponse.json({ ok: true, account: data.account ?? null });
}

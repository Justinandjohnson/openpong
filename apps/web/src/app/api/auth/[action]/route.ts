import { NextResponse } from "next/server";
import { clearAccountToken, readAccountToken, setAccountToken } from "@/lib/server/account";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";

/**
 * Sign in / sign up against the OpenPong server. On success the bearer is sealed
 * into an httpOnly cookie and never returned to the browser.
 */
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action === "logout") {
    await clearAccountToken();
    return NextResponse.json({ ok: true });
  }
  if (action !== "login" && action !== "signup") {
    return NextResponse.json({ error: "Unknown action" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    displayName?: string;
  };
  const url = `${OPENPONG_SERVER_URL}/api/auth/${action}`;
  const result = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: body.email ?? "",
      password: body.password ?? "",
      ...(body.displayName ? { displayName: body.displayName } : {}),
    }),
    timeoutMs: 15000,
  }).catch(() => ({ ok: false, status: 503, data: null }));

  const data = result.data as { token?: string; account?: unknown; error?: string } | null;
  if (!result.ok || !data?.token) {
    const message =
      data?.error ??
      (result.status === 503
        ? "The OpenPong server is not reachable right now."
        : "Could not sign you in.");
    return NextResponse.json({ error: message }, { status: result.status || 400 });
  }

  await setAccountToken(data.token);
  return NextResponse.json({ ok: true, account: data.account ?? null });
}

/**
 * Ask the server whether it hosts accounts and whether Google sign-in is ready.
 * `start` is the one public route that answers both in a single call: 403 when
 * accounts are off, 503 when Google is unconfigured, and a consent URL when both
 * are ready. The state it signs is stateless, so probing it changes nothing.
 */
async function signInAvailability(
  redirectBase: string,
): Promise<{ accounts: boolean; google: boolean }> {
  const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/auth/google/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirectBase }),
    timeoutMs: 8000,
  }).catch(() => null);
  if (!result || result.status === 403) return { accounts: false, google: false };
  return { accounts: true, google: result.ok };
}

/** Who the sealed cookie belongs to, without trusting anything the browser sent. */
export async function GET(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action !== "me") return NextResponse.json({ error: "Unknown action" }, { status: 404 });

  const availability = await signInAvailability(new URL(request.url).origin);
  const token = await readAccountToken();
  if (!token) {
    return NextResponse.json(
      { account: null, accounts: availability.accounts, google: availability.google },
      { status: 200 },
    );
  }
  const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    timeoutMs: 10000,
  }).catch(() => ({ ok: false, status: 503, data: null }));
  if (!result.ok) {
    // A dead or rotated account must not leave a permanent ghost cookie.
    if (result.status === 401) await clearAccountToken();
    return NextResponse.json(
      {
        account: null,
        accounts: result.status !== 404,
        google: availability.google,
      },
      { status: 200 },
    );
  }
  return NextResponse.json({
    account: (result.data as { account?: unknown })?.account ?? null,
    accounts: true,
    google: availability.google,
  });
}

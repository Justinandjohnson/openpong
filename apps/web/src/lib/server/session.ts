import "server-only";
import { cookies } from "next/headers";
import { readAccountToken } from "./account";
import { ensureTokenForSessionId, newSessionId, OPENPONG_SESSION_COOKIE } from "./openpong";

const COOKIE_MAX_AGE = 24 * 60 * 60;

/**
 * Read (or create) the opaque BFF session id from the httpOnly cookie and return
 * the OpenPong bearer token that belongs to it. The token itself never leaves the
 * server; CopilotKit and data requests are proxied through Next route handlers.
 */
export async function openPongToken(): Promise<{
  token: string;
  sessionId: string;
  created: boolean;
}> {
  // A signed-in account always wins: its bearer is the one the server scopes data to.
  const account = await readAccountToken();
  if (account) return { token: account, sessionId: "account", created: false };

  const store = await cookies();
  const existing = store.get(OPENPONG_SESSION_COOKIE)?.value;
  const sessionId = existing || newSessionId();
  const token = await ensureTokenForSessionId(sessionId);
  if (!existing) {
    store.set(OPENPONG_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
  }
  return { token, sessionId, created: !existing };
}

/** Just the bearer, for proxied requests. */
export async function requiredOpenPongToken(): Promise<string> {
  const account = await readAccountToken();
  return account ?? (await openPongToken()).token;
}

import "server-only";

/** Server-side view of the OpenPong deployment. Nothing here reaches the browser. */
export const OPENPONG_SERVER_URL = (
  process.env.OPENPONG_SERVER_URL || "http://localhost:8787"
).replace(/\/$/, "");

export const OMNIPONG_SERVICE_URL = (
  process.env.OMNIPONG_SERVICE_URL || "http://127.0.0.1:8000"
).replace(/\/$/, "");

export const OMNIPONG_SERVICE_TOKEN = process.env.OMNIPONG_SERVICE_TOKEN?.trim() || undefined;
export const OMNIPONG_API_KEY = process.env.OMNIPONG_API_KEY?.trim() || undefined;
export const OPENPONG_ACCESS_KEY = process.env.OPENPONG_ACCESS_KEY?.trim() || undefined;

/** Read-only fallback for the local OmniPong corpus (example data on first run). */
export const OMNIPONG_DB_PATH =
  process.env.OPENPONG_OMNIPONG_DB?.trim() || process.env.OMNIPONG_DB?.trim() || undefined;

export const OPENPONG_SESSION_COOKIE = "openpong_session";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON request helper with a short timeout and a clean error. */
export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function postOmniPong(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const result = await fetchJson(`${OMNIPONG_SERVICE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(OMNIPONG_SERVICE_TOKEN ? { authorization: `Bearer ${OMNIPONG_SERVICE_TOKEN}` } : {}),
      ...(OMNIPONG_API_KEY ? { "x-api-key": OMNIPONG_API_KEY } : {}),
    },
    body: JSON.stringify(body ?? {}),
    timeoutMs: 120_000,
  });
  return result;
}

export async function getOmniPong(
  path: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return fetchJson(`${OMNIPONG_SERVICE_URL}${path}`, {
    headers: {
      accept: "application/json",
      ...(OMNIPONG_SERVICE_TOKEN ? { authorization: `Bearer ${OMNIPONG_SERVICE_TOKEN}` } : {}),
      ...(OMNIPONG_API_KEY ? { "x-api-key": OMNIPONG_API_KEY } : {}),
    },
  });
}

/**
 * Session bearer for the OpenPong server. The browser only ever receives an opaque,
 * httpOnly session id; the actual bearer lives in this server process and is minted
 * from `POST /api/session` exactly like the native app does.
 */
const sessionCache = new Map<string, { token: string; expiresAt: number }>();

export async function createOpenPongToken(): Promise<string> {
  const result = await fetchJson(`${OPENPONG_SERVER_URL}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OPENPONG_ACCESS_KEY ? { accessKey: OPENPONG_ACCESS_KEY } : {}),
    timeoutMs: 15000,
  });
  const token = (result.data as { token?: string } | null)?.token;
  if (!result.ok || !token) {
    throw new Error(
      `OpenPong server did not issue a session (${result.status}). Is it running at ${OPENPONG_SERVER_URL}?`,
    );
  }
  return token;
}

export function tokenForSessionId(sessionId: string): string | undefined {
  const entry = sessionCache.get(sessionId);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    sessionCache.delete(sessionId);
    return undefined;
  }
  return entry.token;
}

/** Mint (or reuse) a token for an opaque session id. */
export async function ensureTokenForSessionId(sessionId: string): Promise<string> {
  const existing = tokenForSessionId(sessionId);
  if (existing) return existing;
  let token = await createOpenPongToken();
  // A live-mode server can rate-limit sign-in bursts; one retry keeps the BFF calm.
  if (!token) {
    await sleep(250);
    token = await createOpenPongToken();
  }
  sessionCache.set(sessionId, { token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 });
  return token;
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

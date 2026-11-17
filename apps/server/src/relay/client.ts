import { z } from "zod";

/**
 * Typed client for the OpenPong relay's operator-authenticated control plane.
 *
 * The relay (services/omnipong/relay) is the only thing that knows which
 * computers (companions) are paired and connected. This client lets the
 * dashboard and the coach ask the relay about ONE owner, mint/revoke that
 * owner's pairing, and clear a pending human gate. It never sees a credential:
 * the relay only ever carries CDP bytes and pairing metadata.
 *
 * Per-user identity lives in the relay: a companion is paired to exactly one
 * owner, and the relay refuses a session whose owner does not match the
 * pairing. This client always names an explicit owner so a call can never be
 * ambiguous about whose computer it is talking about.
 */

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export interface RelayGate {
  gate_id: string;
  kind: string;
  hint: string;
  url_host: string;
  created_at?: number;
}

export interface RelayCompanion {
  owner: string;
  paired: boolean;
  connected: boolean;
  fingerprint?: string | null;
  gates: RelayGate[];
}

export interface RelayPairing {
  owner: string;
  /** The pairing token — a secret, shown once so the person can paste it. */
  pairingToken: string;
  fingerprint?: string | null;
  /** A copy-pasteable command to run on the person's own computer. */
  command: string;
  relayUrl: string;
}

export interface RelayClientOptions {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const gateSchema = z.object({
  gate_id: z.string(),
  kind: z.string(),
  hint: z.string().default(""),
  url_host: z.string().default(""),
  created_at: z.number().optional(),
});

const companionSchema = z.object({
  owner: z.string(),
  paired: z.boolean().default(false),
  connected: z.boolean().default(false),
  fingerprint: z.string().nullish(),
  gates: z.array(gateSchema).default([]),
});

const pairingSchema = z.object({
  owner: z.string(),
  pairing_token: z.string(),
  fingerprint: z.string().nullish(),
});

/** Convert an HTTP(S) relay base URL to the ws(s) URL the companion connects to. */
export function relayWebSocketUrl(url: string): string {
  return url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

/** The command a person runs on their own computer to pair it. */
export function companionCommand(relayUrl: string, pairingToken: string): string {
  return `python companion.py --relay-base-url ${relayWebSocketUrl(relayUrl)} --pairing-token ${pairingToken}`;
}

export class RelayClient {
  private readonly url?: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RelayClientOptions = {}) {
    this.url = options.url?.trim().replace(/\/+$/, "") || undefined;
    this.token = options.token?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** True when a relay URL is configured. A client without one still answers
   *  "not connected" instead of throwing, so the UI can show setup guidance. */
  get configured(): boolean {
    return Boolean(this.url);
  }

  async status(owner: string): Promise<RelayCompanion> {
    const body = await this.request(`/companions/${encodeURIComponent(owner)}`, companionSchema);
    return body;
  }

  async startPairing(owner: string): Promise<RelayPairing> {
    const body = await this.request("/pairing", pairingSchema, { method: "POST", body: { owner } });
    return {
      owner: body.owner,
      pairingToken: body.pairing_token,
      fingerprint: body.fingerprint,
      command: companionCommand(this.url ?? "", body.pairing_token),
      relayUrl: this.url ?? "",
    };
  }

  async unpair(owner: string): Promise<{ owner: string; revoked: boolean }> {
    const body = await this.request(
      `/pairing/${encodeURIComponent(owner)}`,
      z.object({ owner: z.string(), revoked: z.boolean() }),
      { method: "DELETE" },
    );
    return body;
  }

  async clearGate(owner: string, gateId: string): Promise<{ gate_id: string; status: string }> {
    return this.request(
      `/companions/${encodeURIComponent(owner)}/gates/${encodeURIComponent(gateId)}/clear`,
      z.object({ gate_id: z.string(), status: z.string() }),
      { method: "POST", body: {} },
    );
  }

  private async request<T>(
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    if (!this.url) throw new RelayError("The relay is not configured on this server.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.url}${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(this.token ? { "x-operator-token": this.token } : {}),
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new RelayError(
          `Relay request failed (${response.status}${detail ? `: ${detail}` : ""})`,
          response.status,
        );
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) throw new RelayError("Relay returned an unexpected response");
      return parsed.data;
    } catch (error) {
      if (error instanceof RelayError) throw error;
      if (controller.signal.aborted)
        throw new RelayError(`Relay request timed out after ${this.timeoutMs}ms`);
      throw new RelayError(error instanceof Error ? error.message : "Relay request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Pull a human-readable reason out of a failed relay response. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === "object") {
        const error = (data as Record<string, unknown>).error;
        if (
          error &&
          typeof error === "object" &&
          typeof (error as { detail?: unknown }).detail === "string"
        )
          return String((error as { detail: string }).detail);
        for (const key of ["detail", "message"] as const) {
          const value = (data as Record<string, unknown>)[key];
          if (typeof value === "string" && value.trim()) return value.trim();
        }
      }
    } catch {
      // Not JSON; fall through to the clipped raw body.
    }
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

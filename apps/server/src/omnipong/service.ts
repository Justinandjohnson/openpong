import { z } from "zod";

/** Default location of the vendored OmniPong Python service (`uvicorn backend.main:app`). */
export const defaultOmniPongServiceUrl = "http://127.0.0.1:8000";
const defaultTimeoutMs = 15000;

/** A clean, tool-safe failure raised by the OmniPong client instead of a raw fetch or Zod error. */
export class OmniPongError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OmniPongError";
  }
}

export interface OmniPongServiceOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Loose but typed shapes: the service returns JSON we surface to the model, so extra keys survive. */
const objectSchema = z.record(z.string(), z.unknown());
const objectArraySchema = z.array(objectSchema);
const actionResponseSchema = z.object({
  status: z.string(),
  action: z.string(),
  result: z.unknown(),
});
/** A manual result the owner reported, saved through `POST /tools/matches`. */
export interface RecordMatchInput {
  /** ISO date, e.g. `2026-11-16`. */
  date: string;
  opponentName: string;
  opponentRating?: number;
  result: "Win" | "Loss";
  /** Overall games, e.g. `3-1`. */
  scoreSummary?: string;
  /** Owner-first games: `[11, 9, 11, 8]` or `"11-9, 11-8"`. */
  setScores?: number[] | string;
  source?: string;
}

/** `/tools/matches` answers with the saved row; the service is idempotent. */
const recordMatchResponseSchema = z.looseObject({
  status: z.string(),
  match_id: z.number().int(),
  created: z.boolean(),
});

/** `/tools/sms/notify` reports delivery honestly; a Twilio outage is not an error. */
const smsNotifyResponseSchema = z.looseObject({
  status: z.string(),
  sent: z.boolean(),
  to: z.string().optional(),
  detail: z.string().optional(),
});

// `/tools/sync/league` grows new summary fields over time, so the known shape is
// checked and everything else is passed through instead of failing the tool.
const leagueSyncResponseSchema = z.looseObject({
  status: z.string(),
  message: z.string().optional(),
  owner: z.string().optional(),
  leagues: z.array(objectSchema).optional(),
  matches_seen: z.number().optional(),
  owner_matches: z.number().optional(),
  inserted: z.number().optional(),
  updated: z.number().optional(),
  skipped_duplicates: z.number().optional(),
  errors: z.array(z.unknown()).optional(),
});

/** Pull a human-readable reason out of a failed response so the tool error stays clean. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const data: unknown = JSON.parse(text);
      if (data && typeof data === "object")
        for (const key of ["detail", "error", "message"] as const) {
          const value = (data as Record<string, unknown>)[key];
          if (typeof value === "string" && value.trim()) return value.trim();
        }
    } catch {
      // Not JSON; fall through to the clipped raw body.
    }
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Typed client for the vendored OmniPong Python service.
 *
 * The service is a separate FastAPI process (`services/omnipong`, run as
 * `uvicorn backend.main:app`, default http://127.0.0.1:8000). This client only
 * speaks JSON over HTTP, applies a request timeout, and turns every failure
 * into a clean `OmniPongError` so a tool never crashes the run. Owner scoping
 * is the caller's responsibility (`this.owner`); the service has no per-user
 * auth yet (that is Phase 2), so per-owner behavior stays in the TS harness.
 */
export class OmniPongService {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OmniPongServiceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `GET /agent/actions` — the action names the OmniPong service exposes. */
  async listActions(): Promise<string[]> {
    const body = await this.request("/agent/actions", z.object({ actions: z.array(z.string()) }));
    return body.actions;
  }

  /** `POST /agent/action` — run one named action and return its unwrapped `result`. */
  async runAction(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const body = await this.request("/agent/action", actionResponseSchema, {
      method: "POST",
      body: { action, params },
    });
    return body.result;
  }

  /** `GET /user` — the configured owner profile (name, rating, USATT number). */
  async getUser(): Promise<Record<string, unknown>> {
    return this.request("/user", objectSchema);
  }

  /** `GET /matches` — the owner's match history, most recent first. */
  async getMatches(source?: string): Promise<Record<string, unknown>[]> {
    const matches = await this.request(this.withQuery("/matches", { source }), objectArraySchema);
    if (matches.length > 0 || !source) return matches;
    // Guardrail: never let a source filter hide the owner's real matches. When a named source
    // yields nothing, fall back to every source (each row still carries its own `source`).
    return this.request(this.withQuery("/matches", {}), objectArraySchema);
  }

  /** `GET /matches/summary` — the owner's matches grouped by year with the overall record. */
  async getMatchesSummary(source?: string): Promise<Record<string, unknown>> {
    return this.request(this.withQuery("/matches/summary", { source }), objectSchema);
  }

  /** `GET /rating_history` — the owner's rating points over time for a source. */
  async getRatingHistory(source?: string): Promise<Record<string, unknown>[]> {
    return this.request(this.withQuery("/rating_history", { source }), objectArraySchema);
  }

  /** `GET /stats` — win/loss record, patterns and rating context for a source. */
  async getStats(source?: string): Promise<Record<string, unknown>> {
    return this.request(this.withQuery("/stats", { source }), objectSchema);
  }

  /** `GET /tournaments` — tournaments from the service's area filter (default `local`). */
  async getTournaments(region?: string): Promise<Record<string, unknown>[]> {
    return this.request(this.withQuery("/tournaments", { region }), objectArraySchema);
  }

  /** `GET /notifications` — the owner's unread notifications. */
  async getNotifications(): Promise<Record<string, unknown>[]> {
    return this.request("/notifications", objectArraySchema);
  }

  /** Player name -> USATT id/rating/state via the `search` action. */
  async searchPlayer(name: string): Promise<unknown> {
    return this.runAction("search", { name });
  }

  /**
   * `POST /tools/search/players` — the local players table (no login, no
   * scraping, no owner gate). This is the reliable candidate source for
   * "find me by name": the service's own `search` action needs a live scrape
   * and its USATT lookup is owner-gated, so neither can be relied on for a
   * brand-new install.
   */
  async searchLocalPlayers(name: string): Promise<unknown> {
    const trimmed = name.trim();
    if (!trimmed) throw new OmniPongError("A player name is required.");
    return this.request("/tools/search/players", objectSchema, {
      method: "POST",
      body: { name: trimmed },
    });
  }

  /**
   * `GET /tools/lookup/usatt` — the vendored service's public USATT lookup
   * (no login). Returns `{status, player, rating_history, tournaments}` or a
   * `not_found` status; a private/blocked lookup is a clean `OmniPongError`.
   */
  async lookupUsatt(name: string): Promise<Record<string, unknown>> {
    const trimmed = name.trim();
    if (!trimmed) throw new OmniPongError("A player name is required.");
    return this.request(this.withQuery("/tools/lookup/usatt", { name: trimmed }), objectSchema, {
      timeoutMs: 45_000,
    });
  }

  /** `GET /players/{name}/scouting` — an AI scouting report for one opponent. */
  async getScouting(name: string): Promise<Record<string, unknown>> {
    return this.request(`/players/${encodeURIComponent(name)}/scouting`, objectSchema);
  }

  /** `GET /training/recommendations` — training focus areas derived from match patterns. */
  async getTrainingRecommendations(): Promise<Record<string, unknown>> {
    return this.request("/training/recommendations", objectSchema);
  }

  /**
   * `GET /tools/results/omnipong` — read-only public draw/results for one
   * OmniPong event round (`t` = tournament id, `r` = event id, both taken from
   * the tournament link). No login and no browser: a private page comes back as
   * `{error}` rather than a failure.
   */
  async getTournamentResults(tid: string, eid: string): Promise<Record<string, unknown>> {
    const tournament = tid.trim(),
      event = eid.trim();
    if (!tournament || !event) throw new OmniPongError("A tournament and event id are required.");
    return this.request(
      this.withQuery("/tools/results/omnipong", { tid: tournament, eid: event }),
      objectSchema,
      { timeoutMs: 45_000 },
    );
  }

  /**
   * `POST /tools/sync/league` — refresh the owner's league matches from the
   * public league URLs saved in their profile. No league is guessed: an empty
   * URL list is sent as `null` and the service refuses. `segments` is always
   * sent so the Event/Week completeness cross-check runs.
   */
  async syncLeague(
    input: { leagueUrls?: string[]; owner?: string; allMatches?: boolean; segments?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const leagueUrls = (input.leagueUrls ?? []).map((url) => url.trim()).filter(Boolean);
    return this.request("/tools/sync/league", leagueSyncResponseSchema, {
      method: "POST",
      // A full segmented league read is minutes, not seconds — the default 15s
      // request budget would abort a perfectly healthy sync.
      timeoutMs: 10 * 60_000,
      body: {
        league_urls: leagueUrls.length > 0 ? leagueUrls : null,
        owner: input.owner?.trim() || null,
        legacy: false,
        all_matches: input.allMatches ?? false,
        // Completeness cross-check (Event/Week) stays on for every sync.
        segments: true,
      },
    });
  }

  /**
   * `POST /settings/update_phone` — save the owner's number for outbound
   * alerts. Blank clears it.
   */
  async updatePhone(phoneNumber: string): Promise<Record<string, unknown>> {
    return this.request("/settings/update_phone", objectSchema, {
      method: "POST",
      body: { phone_number: phoneNumber.trim() },
    });
  }

  /**
   * `POST /tools/sms/notify` — send one outbound text to the owner. The
   * recipient is resolved by the domain service from the phone number on file,
   * so an alert can never be aimed at a stranger from here. Returns
   * `{sent, to?, detail}` and never throws for a Twilio outage.
   */
  async sendSms(body: string, to?: string): Promise<Record<string, unknown>> {
    const text = body.trim();
    if (!text) throw new OmniPongError("Nothing to send.");
    return this.request("/tools/sms/notify", smsNotifyResponseSchema, {
      method: "POST",
      timeoutMs: 20_000,
      body: { body: text, ...(to?.trim() ? { to: to.trim() } : {}) },
    });
  }

  /**
   * `POST /tools/matches` — record one match result the owner reported. This is
   * a real write: the service derives the winner/loser from its own owner row
   * and treats a repeated (date, opponent, score, source) as the same match, so
   * a retry returns `created:false` instead of a duplicate row.
   */
  async recordMatch(input: RecordMatchInput): Promise<Record<string, unknown>> {
    return this.request("/tools/matches", recordMatchResponseSchema, {
      method: "POST",
      body: {
        date: input.date.trim(),
        opponent_name: input.opponentName.trim(),
        opponent_rating: input.opponentRating ?? null,
        result: input.result,
        score_summary: input.scoreSummary?.trim() || null,
        set_scores: input.setScores ?? null,
        source: input.source?.trim() || "arcade",
      },
    });
  }

  private withQuery(path: string, params: Record<string, string | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== "") search.set(key, value);
    const query = search.toString();
    return query ? `${path}?${query}` : path;
  }

  private async request<T>(
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new OmniPongError(
          `OmniPong service request failed (${response.status}${detail ? `: ${detail}` : ""})`,
          response.status,
        );
      }
      const raw = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new OmniPongError("OmniPong service returned invalid JSON");
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success)
        throw new OmniPongError("OmniPong service returned an unexpected response");
      return parsed.data;
    } catch (error) {
      if (error instanceof OmniPongError) throw error;
      if (controller.signal.aborted)
        throw new OmniPongError(`OmniPong service request timed out after ${timeoutMs}ms`);
      throw new OmniPongError(
        error instanceof Error ? error.message : "OmniPong service request failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

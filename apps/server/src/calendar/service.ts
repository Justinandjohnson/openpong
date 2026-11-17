import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { OwnerProfile } from "../../../../packages/domain/src/agent.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { GoogleAuth } from "../google-auth.ts";
import { defaultOmniPongServiceUrl, OmniPongService } from "../omnipong/service.ts";
import { areaFor, narrowTournaments, resolveTournamentRegion } from "../onboarding/area.ts";
import { type PongEvent, renderCalendar } from "./ics.ts";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
/** The only calendar this service is allowed to touch, by construction. */
const CALENDAR_SUMMARY = "Pong";
const MATCH_WINDOW_DAYS = 90;

interface EventRecord extends PongEvent {
  /** Set only after Google accepted the event; absent for cache-only (ICS) owners. */
  googleEventId?: string;
  /** Content fingerprint, so a re-sync can skip unchanged events. */
  hash: string;
}
interface EventCache {
  id: "events";
  items: EventRecord[];
  lastSyncAt?: string;
}
interface GoogleCalendarRecord {
  id: "google";
  calendarId: string;
  timeZone: string;
  createdAt: string;
}
interface FeedRecord {
  id: "feed";
  version: string;
  createdAt: string;
}

export interface CalendarStatus {
  provider: "google" | "ics" | null;
  calendarId?: string;
  connected: boolean;
  feedUrl?: string;
  lastSyncAt?: string;
  error?: string;
}

export type CalendarConnect = { kind: "google"; url: string } | { kind: "ics"; feedUrl: string };

export interface CalendarEventInput {
  pongKey: string;
  title: string;
  /** All-day: `YYYY-MM-DD`. Timed: ISO date-time with an offset. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  url?: string;
  description?: string;
  kind: PongEvent["kind"];
}

export interface CalendarUpsertResult {
  created: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

export interface CalendarSyncResult extends CalendarUpsertResult {
  lastSyncAt: string;
}

export interface CalendarListOptions {
  from?: string;
  to?: string;
}

/** The Google pieces are optional so tests can run the whole service offline. */
export interface CalendarServiceOptions {
  googleAuth?: GoogleAuth;
  omnipong?: Pick<OmniPongService, "getTournaments" | "getMatches">;
  profile?: (owner: string) => Promise<OwnerProfile | null>;
  fetchImpl?: typeof fetch;
  publicUrl?: string;
  now?: () => Date;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function hashEvent(event: CalendarEventInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        event.pongKey,
        event.title,
        event.start,
        event.end,
        event.allDay,
        event.location ?? "",
        event.url ?? "",
        event.description ?? "",
        event.kind,
      ]),
    )
    .digest("hex");
}

function isVisible(from: string | undefined, to: string | undefined, event: EventRecord): boolean {
  // ISO dates and UTC-normalised date-times sort lexicographically.
  if (from && event.end <= from) return false;
  if (to && event.start >= to) return false;
  return true;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

function monthIndex(name: string): number {
  const lower = name.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((month) => month.startsWith(lower));
}

function isoDate(year: number, monthIndexZero: number, day: number): string | null {
  const date = new Date(Date.UTC(year, monthIndexZero, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndexZero ||
    date.getUTCDate() !== day
  )
    return null;
  return dateOnly(date);
}

/**
 * Read the human date ranges the OmniPong service stores ("May 10–11, 2026",
 * "11/21/2026", "2026-11-28"). Returns a civil start date and an exclusive end
 * date, or null when the text cannot be trusted enough to place on a calendar.
 */
export function parseDateRange(
  value: unknown,
  fallbackYear = new Date().getUTCFullYear(),
): { start: string; end: string } | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[–—]/g, "-").trim();
  if (!text) return null;

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})(?:\s*-\s*(\d{4})-(\d{1,2})-(\d{1,2}))?/.exec(text);
  if (iso) {
    const start = isoDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (!start) return null;
    const end = iso[4]
      ? isoDate(Number(iso[4]), Number(iso[5]) - 1, Number(iso[6]))
      : isoDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return end ? { start, end: addDays(end, 1) } : null;
  }

  // "11/21/26", "12/12/26 - 12/13/26" (the OmniPong service's own format).
  const numeric = [...text.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g)];
  if (numeric.length) {
    const toDate = (m: RegExpMatchArray) => {
      const raw = Number(m[3]);
      const year = m[3].length === 2 ? 2000 + raw : raw;
      return isoDate(year, Number(m[1]) - 1, Number(m[2]));
    };
    const start = toDate(numeric[0]);
    if (!start) return null;
    const end = numeric[1] ? toDate(numeric[1]) : start;
    return end ? { start, end: addDays(end, 1) } : null;
  }

  // "May 10-11, 2026", "May 10 - June 7, 2026", "March-May 2026".
  const pattern = new RegExp(
    `(${MONTH})\\s*(\\d{1,2})?\\s*(?:-\\s*(?:(${MONTH})\\s*)?(\\d{1,2})?)?`,
    "i",
  );
  const match = pattern.exec(text);
  if (!match) return null;
  const yearMatch = [...text.matchAll(/\b(19|20)\d{2}\b/g)].at(-1);
  const year = yearMatch ? Number(yearMatch[0]) : fallbackYear;
  const startMonth = monthIndex(match[1] ?? "");
  if (startMonth < 0) return null;
  const startDay = match[2] ? Number(match[2]) : 1;
  const start = isoDate(year, startMonth, startDay);
  if (!start) return null;
  const endMonth = match[3] ? monthIndex(match[3]) : undefined;
  const endDay = match[4] ? Number(match[4]) : undefined;
  if (endMonth !== undefined && endDay !== undefined) {
    const endYear = endMonth < startMonth ? year + 1 : year;
    const end = isoDate(endYear, endMonth, endDay);
    return end ? { start, end: addDays(end, 1) } : null;
  }
  if (endDay !== undefined) {
    const end = isoDate(year, startMonth, endDay);
    return end ? { start, end: addDays(end, 1) } : null;
  }
  if (endMonth !== undefined) {
    // "March-May 2026": end at the first day after the named end month.
    const endYear = endMonth < startMonth ? year + 1 : year;
    const end = isoDate(endYear, endMonth + 1, 1);
    return end ? { start, end } : null;
  }
  return { start, end: addDays(start, 1) };
}

/**
 * The Pong calendar: one owner-scoped secondary Google calendar when Google is
 * connected, and always a stable local event cache that backs the tokenised
 * iCal feed. Every write carries a `pongKey` in `extendedProperties.private`,
 * and no method can address any calendar other than the stored Pong calendar id.
 */
export class CalendarService {
  private readonly googleAuth: GoogleAuth;
  private readonly omnipong: Pick<OmniPongService, "getTournaments" | "getMatches">;
  private readonly profile: (owner: string) => Promise<OwnerProfile | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly publicUrl: string;
  private readonly now: () => Date;
  private feedSecret?: Promise<string>;

  constructor(
    private readonly db: Store,
    private readonly config: Config,
    options: CalendarServiceOptions = {},
  ) {
    this.googleAuth = options.googleAuth ?? new GoogleAuth(db, config);
    this.omnipong =
      options.omnipong ??
      new OmniPongService({
        baseUrl: config.omnipongServiceUrl ?? defaultOmniPongServiceUrl,
        token: config.omnipongServiceToken,
      });
    this.profile = options.profile ?? (async () => null);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.publicUrl = (options.publicUrl ?? config.publicUrl ?? "").replace(/\/+$/, "");
    this.now = options.now ?? (() => new Date());
  }

  configured(): boolean {
    return this.googleAuth.configured();
  }

  /**
   * Feed links must verify across restarts, so a deployment without
   * TOKEN_ENCRYPTION_KEY gets a random per-deployment secret stored in the
   * database instead of a hard-coded default anyone could forge.
   */
  private async encryptionKey(): Promise<string> {
    if (this.config.encryptionKey) return this.config.encryptionKey;
    this.feedSecret ??= (async () => {
      const stored = await this.db.get<{ id: string; secret: string }>(
        "system",
        "system",
        "calendar-feed-secret",
      );
      if (stored?.secret) return stored.secret;
      const secret = randomBytes(32).toString("base64url");
      await this.db.insertIfAbsent("system", "system", { id: "calendar-feed-secret", secret });
      const saved = await this.db.get<{ id: string; secret: string }>(
        "system",
        "system",
        "calendar-feed-secret",
      );
      return saved?.secret ?? secret;
    })();
    return this.feedSecret;
  }

  private async googleCalendar(owner: string): Promise<{
    tokens: NonNullable<Awaited<ReturnType<GoogleAuth["tokens"]>>>;
    record: GoogleCalendarRecord | null;
  } | null> {
    const tokens = await this.googleAuth.tokens(owner);
    if (!tokens) return null;
    const record = await this.db.get<GoogleCalendarRecord>(owner, "calendar", "google");
    return { tokens, record };
  }

  /** `GET /api/agent/calendar`: what the dashboard shows for the one button. */
  async status(owner: string): Promise<CalendarStatus> {
    const stored = await this.db.get<GoogleCalendarRecord>(owner, "calendar", "google");
    const cache = await this.db.get<EventCache>(owner, "calendar", "events");
    let feedUrl: string | undefined;
    let error: string | undefined;
    try {
      feedUrl = await this.feedUrl(owner);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Feed links are unavailable";
    }
    const tokens = await this.googleAuth.tokens(owner).catch(() => null);
    if (tokens) {
      return {
        provider: "google",
        ...(stored?.calendarId ? { calendarId: stored.calendarId } : {}),
        connected: true,
        ...(feedUrl ? { feedUrl } : {}),
        ...(cache?.lastSyncAt ? { lastSyncAt: cache.lastSyncAt } : {}),
        ...(error ? { error } : {}),
      };
    }
    const hasFeed = Boolean(feedUrl);
    return {
      provider: hasFeed ? "ics" : null,
      connected: hasFeed,
      ...(feedUrl ? { feedUrl } : {}),
      ...(cache?.lastSyncAt ? { lastSyncAt: cache.lastSyncAt } : {}),
      ...(error ? { error } : {}),
    };
  }

  /**
   * The single connect button. Google when the server has OAuth credentials
   * (the Pong calendar is created on first sync); otherwise a read-only iCal
   * subscription, which is the only honest mechanism for Apple/Outlook.
   */
  async connectUrl(owner: string): Promise<CalendarConnect> {
    if (this.configured()) {
      const { url } = await this.googleAuth.connectCalendar(owner);
      return { kind: "google", url };
    }
    return { kind: "ics", feedUrl: await this.feedUrl(owner) };
  }

  /** Create the secondary calendar exactly once; a vanished id is replaced once. */
  async ensureCalendar(owner: string): Promise<GoogleCalendarRecord> {
    const stored = await this.db.get<GoogleCalendarRecord>(owner, "calendar", "google");
    if (stored) {
      const check = await this.googleRequest(
        owner,
        `/calendars/${encodeURIComponent(stored.calendarId)}`,
        { method: "GET" },
      );
      if (check.status === 404 || check.status === 410) {
        await this.db.remove(owner, "calendar", "google");
      } else if (check.ok) {
        return stored;
      } else {
        throw new Error(await googleErrorDetail(check));
      }
    }
    const timeZone = await this.timeZone(owner);
    const response = await this.googleRequest(owner, "/calendars", {
      method: "POST",
      body: { summary: CALENDAR_SUMMARY, timeZone },
    });
    if (!response.ok) throw new Error(await googleErrorDetail(response));
    const created = (await response.json()) as { id?: string };
    if (!created.id) throw new Error("Google did not return the new Pong calendar id");
    const record: GoogleCalendarRecord = {
      id: "google",
      calendarId: created.id,
      timeZone,
      createdAt: this.now().toISOString(),
    };
    await this.db.put(owner, "calendar", record);
    return record;
  }

  /** The owner's profile time zone, or UTC until the profile carries one. */
  private async timeZone(owner: string): Promise<string> {
    const profile = await this.profile(owner).catch(() => null);
    const candidate = (profile as (OwnerProfile & { timeZone?: string }) | null)?.timeZone;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : "UTC";
  }

  /**
   * Idempotent write. The local cache is always updated (it is what the ICS
   * feed reads); Google is called only when the owner connected it. Re-syncing
   * identical content is a skip, never a duplicate and never a second PATCH.
   */
  async upsert(
    owner: string,
    events: readonly CalendarEventInput[],
  ): Promise<CalendarUpsertResult> {
    const warnings: string[] = [];
    const cache = await this.cache(owner);
    const items = new Map(cache.items.map((item) => [item.pongKey, item]));
    const connection = await this.googleCalendar(owner);
    let calendarId: string | undefined;
    let calendarTimeZone = "UTC";
    if (connection) {
      try {
        const record = await this.ensureCalendar(owner);
        calendarId = record.calendarId;
        calendarTimeZone = record.timeZone;
      } catch (cause) {
        warnings.push(
          `Google calendar: ${cause instanceof Error ? cause.message : "could not be prepared"}`,
        );
      }
    }
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const input of events) {
      const existing = items.get(input.pongKey);
      const hash = hashEvent(input);
      if (existing?.hash === hash) {
        skipped++;
        continue;
      }
      let googleEventId = existing?.googleEventId;
      if (connection && calendarId) {
        try {
          googleEventId = await this.writeGoogle(
            owner,
            calendarId,
            input,
            calendarTimeZone,
            googleEventId,
          );
        } catch (cause) {
          warnings.push(
            `${input.pongKey}: ${cause instanceof Error ? cause.message : "Google write failed"}`,
          );
          continue;
        }
      }
      items.set(input.pongKey, {
        ...stripInput(input),
        ...(googleEventId ? { googleEventId } : {}),
        hash,
      });
      if (existing) updated++;
      else created++;
    }
    await this.db.put<EventCache>(owner, "calendar", {
      id: "events",
      items: [...items.values()].sort((a, b) => a.pongKey.localeCompare(b.pongKey)),
      ...(cache.lastSyncAt ? { lastSyncAt: cache.lastSyncAt } : {}),
    });
    return { created, updated, skipped, warnings };
  }

  private async writeGoogle(
    owner: string,
    calendarId: string,
    event: CalendarEventInput,
    timeZone: string,
    googleEventId?: string,
  ): Promise<string> {
    const body = googleEventBody(event, timeZone);
    if (googleEventId) {
      const response = await this.googleRequest(
        owner,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
        { method: "PATCH", body },
      );
      if (response.ok) return googleEventId;
      // The event may have been deleted in Google; a create is the safe repair.
      if (response.status !== 404 && response.status !== 410) {
        throw new Error(await googleErrorDetail(response));
      }
    }
    const response = await this.googleRequest(
      owner,
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: "POST", body },
    );
    if (!response.ok) throw new Error(await googleErrorDetail(response));
    const created = (await response.json()) as { id?: string };
    if (!created.id) throw new Error("Google did not return the event id");
    return created.id;
  }

  /**
   * Delete one event only when this app created it. The ownership check is the
   * `pongKey` in `extendedProperties.private`, re-read from Google immediately
   * before the DELETE rather than trusted from the cache.
   */
  async remove(owner: string, pongKey: string): Promise<{ deleted: boolean; reason?: string }> {
    const cache = await this.cache(owner);
    const existing = cache.items.find((item) => item.pongKey === pongKey);
    if (!existing) return { deleted: false, reason: "This event is not in the Pong calendar" };
    const connection = await this.googleCalendar(owner);
    if (connection?.record && existing.googleEventId) {
      const path = `/calendars/${encodeURIComponent(connection.record.calendarId)}/events/${encodeURIComponent(existing.googleEventId)}`;
      const read = await this.googleRequest(owner, path, { method: "GET" });
      if (read.ok) {
        const event = (await read.json()) as {
          extendedProperties?: { private?: Record<string, string> };
        };
        if (event.extendedProperties?.private?.pongKey !== pongKey)
          return { deleted: false, reason: "That event was not created by Pong" };
        const deleted = await this.googleRequest(owner, path, { method: "DELETE" });
        if (!deleted.ok && deleted.status !== 404 && deleted.status !== 410)
          throw new Error(await googleErrorDetail(deleted));
      } else if (read.status !== 404 && read.status !== 410) {
        throw new Error(await googleErrorDetail(read));
      }
    }
    await this.db.put<EventCache>(owner, "calendar", {
      id: "events",
      items: cache.items.filter((item) => item.pongKey !== pongKey),
      ...(cache.lastSyncAt ? { lastSyncAt: cache.lastSyncAt } : {}),
    });
    return { deleted: true };
  }

  /** `list_pong_events`: only the Pong cache, never another calendar. */
  async list(owner: string, options: CalendarListOptions = {}) {
    const cache = await this.cache(owner);
    const from = options.from ?? addDays(dateOnly(this.now()), -30);
    const to = options.to ?? addDays(dateOnly(this.now()), 365);
    return cache.items
      .filter((item) => isVisible(from, to, item))
      .sort((a, b) => a.start.localeCompare(b.start) || a.pongKey.localeCompare(b.pongKey))
      .map(({ hash: _hash, googleEventId, ...item }) => ({
        id: googleEventId ?? item.pongKey,
        ...item,
      }));
  }

  /** Create one owner-authored event; the generated key is returned so it can be removed. */
  async add(owner: string, input: Omit<CalendarEventInput, "pongKey" | "kind">) {
    const event: CalendarEventInput = {
      ...input,
      pongKey: `custom:${randomUUID()}`,
      kind: "custom",
    };
    const result = await this.upsert(owner, [event]);
    return { event: { id: event.pongKey, ...stripInput(event) }, ...result };
  }

  /**
   * Best-effort pull from the OmniPong domain: upcoming area tournaments,
   * confirmed sign-ups, the last 90 days of results, and any camp/league rows
   * the service exposes. A source failure becomes a warning; this never throws
   * and never stops the job that triggered it.
   */
  async syncAll(owner: string): Promise<CalendarSyncResult> {
    const warnings: string[] = [];
    const events: CalendarEventInput[] = [];
    const profile = await this.profile(owner).catch(() => null);
    const area = areaFor(profile);
    const region = resolveTournamentRegion(undefined, area);
    const today = dateOnly(this.now());

    const tournaments: Record<string, unknown>[] = [];
    try {
      const rows = await this.omnipong.getTournaments(region);
      // The scraper stores the same event more than once, and the duplicate
      // copies sometimes lose their dates. Keep one row per title, preferring
      // the copy that can be placed on a calendar.
      const byTitle = new Map<string, Record<string, unknown>>();
      for (const row of narrowTournaments(rows, area)) {
        const title = String(row.title ?? "")
          .trim()
          .toLowerCase();
        if (!title) continue;
        const existing = byTitle.get(title);
        const fresh = parseDateRange(row.date_range ?? row.date ?? row.start);
        if (
          !existing ||
          (fresh && !parseDateRange(existing.date_range ?? existing.date ?? existing.start))
        )
          byTitle.set(title, row);
      }
      tournaments.push(...byTitle.values());
    } catch (cause) {
      warnings.push(
        `tournaments: ${cause instanceof Error ? cause.message : "the service is unavailable"}`,
      );
    }
    for (const row of tournaments) {
      const activity = typeof row.activity_type === "string" ? row.activity_type : "tournament";
      if (activity === "camp" || activity === "league") {
        const session = sessionEvent(row);
        if (session) events.push(session);
        continue;
      }
      const tournament = tournamentEvent(row, today);
      if (tournament) events.push(tournament);
      else if (
        row.title &&
        !parseDateRange(row.date_range ?? row.date ?? row.start) &&
        warnings.length < 3
      )
        warnings.push(`no date on record: ${String(row.title)}`);
    }

    try {
      const matches = await this.omnipong.getMatches();
      const cutoff = addDays(today, -MATCH_WINDOW_DAYS);
      for (const row of matches) {
        const event = matchEvent(row, cutoff);
        if (event) events.push(event);
      }
    } catch (cause) {
      warnings.push(
        `matches: ${cause instanceof Error ? cause.message : "the service is unavailable"}`,
      );
    }

    for (const task of await this.signups(owner))
      for (const event of signupEvent(task, tournaments)) events.push(event);

    const result = await this.upsert(owner, events);
    const lastSyncAt = this.now().toISOString();
    const cache = await this.cache(owner);
    await this.db.put<EventCache>(owner, "calendar", {
      id: "events",
      items: cache.items,
      lastSyncAt,
    });
    return { ...result, warnings: [...warnings, ...result.warnings], lastSyncAt };
  }

  /** Confirmed registrations: a succeeded durable sign-up task for this owner. */
  private async signups(owner: string): Promise<{ id: string; title: string }[]> {
    const tasks = await this.db
      .listByStatus<{ id: string; title: string; input?: Record<string, unknown> }>(
        owner,
        "tasks",
        "succeeded",
      )
      .catch(() => []);
    return tasks.filter((task) => {
      const operation = (task.input?.omnipong as { operation?: string } | undefined)?.operation;
      return operation === "signup";
    });
  }

  private async cache(owner: string): Promise<EventCache> {
    return (
      (await this.db.get<EventCache>(owner, "calendar", "events")) ?? { id: "events", items: [] }
    );
  }

  /** Signed, revocable feed token: `base64url(owner).hmac(owner + version)`. */
  private async token(owner: string, version: string): Promise<string> {
    const signature = createHmac("sha256", await this.encryptionKey())
      .update(`${owner}${version}`)
      .digest("base64url");
    return `${Buffer.from(owner, "utf8").toString("base64url")}.${signature}`;
  }

  private async feedVersion(owner: string, create: boolean): Promise<string | null> {
    const stored = await this.db.get<FeedRecord>(owner, "calendar", "feed");
    if (stored?.version) return stored.version;
    if (!create) return null;
    const version = randomUUID();
    const inserted = await this.db.insertIfAbsent<FeedRecord>(owner, "calendar", {
      id: "feed",
      version,
      createdAt: this.now().toISOString(),
    });
    if (inserted?.version) return inserted.version;
    return (await this.db.get<FeedRecord>(owner, "calendar", "feed"))?.version ?? null;
  }

  /** The URL a person subscribes to once (Apple/Outlook, or a fallback for Google). */
  async feedUrl(owner: string): Promise<string> {
    const version = await this.feedVersion(owner, true);
    if (!version) throw new AppError("Feed links are unavailable", 503);
    return `${this.publicUrl}/api/calendar/feed/${await this.token(owner, version)}.ics`;
  }

  /** Resolve a token to its owner, or null when tampered, rotated or unknown. */
  async verifyFeedToken(token: string): Promise<string | null> {
    const [encodedOwner, signature] = token.split(".");
    if (!encodedOwner || !signature || token.split(".").length !== 2) return null;
    let owner: string;
    try {
      owner = Buffer.from(encodedOwner, "base64url").toString("utf8");
    } catch {
      return null;
    }
    if (!owner || owner.length > 200 || /[\r\n]/.test(owner)) return null;
    const version = await this.feedVersion(owner, false);
    if (!version) return null;
    const expected = createHmac("sha256", await this.encryptionKey())
      .update(`${owner}${version}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      return null;
    }
    if (actual.length !== expected.length) return null;
    return timingSafeEqual(actual, expected) ? owner : null;
  }

  /** Rotate the feed link: the previous token stops verifying immediately. */
  async rotateFeed(owner: string): Promise<{ feedUrl: string }> {
    await this.encryptionKey();
    await this.db.put<FeedRecord>(owner, "calendar", {
      id: "feed",
      version: randomUUID(),
      createdAt: this.now().toISOString(),
    });
    return { feedUrl: await this.feedUrl(owner) };
  }

  /** Generate the subscription body for a verified token. */
  async feedForToken(token: string): Promise<{ owner: string; ics: string } | null> {
    const owner = await this.verifyFeedToken(token);
    if (!owner) return null;
    const cache = await this.cache(owner);
    return { owner, ics: renderCalendar(cache.items, this.now()) };
  }

  /** Revoke Google and the current feed link without deleting any calendar data. */
  async disconnect(owner: string) {
    const tokens = await this.googleAuth.tokens(owner).catch(() => null);
    if (tokens) await this.googleAuth.disconnect(owner);
    await this.db.remove(owner, "calendar", "google");
    // Bump the version instead of deleting it, so a re-shown link is fresh but
    // every previously shared token stops working.
    await this.db.put<FeedRecord>(owner, "calendar", {
      id: "feed",
      version: randomUUID(),
      createdAt: this.now().toISOString(),
    });
    return { ok: true };
  }

  private async googleRequest(
    owner: string,
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<Response> {
    const token = await this.googleAuth.accessToken(owner);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    return this.fetchImpl(`${CALENDAR_API}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20000),
    });
  }
}

function stripInput(event: CalendarEventInput): PongEvent {
  return {
    pongKey: event.pongKey,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    kind: event.kind,
    ...(event.location ? { location: event.location } : {}),
    ...(event.url ? { url: event.url } : {}),
    ...(event.description ? { description: event.description } : {}),
  };
}

function googleEventBody(event: CalendarEventInput, timeZone: string) {
  const start = event.allDay
    ? { date: event.start.slice(0, 10) }
    : { dateTime: event.start, timeZone };
  const end = event.allDay ? { date: event.end.slice(0, 10) } : { dateTime: event.end, timeZone };
  const description = [event.description, event.url, `Pong (${event.kind}) · ${event.pongKey}`]
    .filter(Boolean)
    .join("\n");
  return {
    summary: event.title,
    ...(event.location ? { location: event.location } : {}),
    description,
    start,
    end,
    extendedProperties: {
      private: {
        pongKey: event.pongKey,
        pongKind: event.kind,
        ...(event.url ? { pongUrl: event.url } : {}),
      },
    },
  };
}

async function googleErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return `Google Calendar (${response.status})${body.error?.message ? `: ${body.error.message}` : ""}`;
  } catch {
    return `Google Calendar (${response.status})`;
  }
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function tournamentEvent(row: Record<string, unknown>, today: string): CalendarEventInput | null {
  const title = text(row.title);
  const range = parseDateRange(row.date_range ?? row.date ?? row.start);
  if (!title || !range || range.end <= today) return null;
  const source = text(row.source_id) || text(row.url) || title;
  const location = text(row.city_state) || text(row.location);
  const url = text(row.omnipong_url) || text(row.url);
  return {
    pongKey: `tournament:${source}`,
    title,
    start: range.start,
    end: range.end,
    allDay: true,
    kind: "tournament",
    ...(location ? { location } : {}),
    ...(url ? { url } : {}),
    description: [
      range.start === addDays(range.end, -1)
        ? range.start
        : `${range.start} to ${addDays(range.end, -1)}`,
      location,
      text(row.status),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function sessionEvent(row: Record<string, unknown>): CalendarEventInput | null {
  const title = text(row.title);
  const range = parseDateRange(row.date_range ?? row.date ?? row.start);
  if (!title || !range) return null;
  const source = text(row.source_id) || text(row.url) || title;
  const location = text(row.city_state) || text(row.location);
  const url = text(row.omnipong_url) || text(row.url);
  return {
    pongKey: `session:${source}`,
    title,
    start: range.start,
    end: range.end,
    allDay: true,
    kind: "session",
    ...(location ? { location } : {}),
    ...(url ? { url } : {}),
    description: [text(row.activity_type), location].filter(Boolean).join(" · "),
  };
}

function matchEvent(row: Record<string, unknown>, cutoff: string): CalendarEventInput | null {
  const date = text(row.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoff) return null;
  const opponent = text(row.opponent_name) || text(row.winner_name) || "opponent";
  const result = text(row.result);
  const score = text(row.score_summary);
  const id = text(row.id) || text(row.match_id) || `${date}:${opponent}`;
  const source = text(row.source);
  return {
    pongKey: `match:${id}`,
    title: result ? `Table tennis vs ${opponent} (${result})` : `Table tennis vs ${opponent}`,
    start: date,
    end: addDays(date, 1),
    allDay: true,
    kind: "match",
    description: [
      score,
      source,
      text(row.opponent_rating) ? `rating ${text(row.opponent_rating)}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function signupEvent(
  task: { id: string; title: string },
  tournaments: Record<string, unknown>[],
): CalendarEventInput[] {
  // The task title is "Register for <tournament>"; match it back to the real
  // listing so a confirmed sign-up lands on the tournament's own dates.
  const title = task.title.replace(/^Register for\s+/i, "").trim();
  const row = tournaments.find((candidate) => text(candidate.title) === title);
  if (!row) return [];
  const event = tournamentEvent(row, "0000-01-01");
  if (!event) return [];
  return [
    {
      ...event,
      pongKey: `signup:${task.id}`,
      title: `${event.title} (signed up)`,
      kind: "signup",
      description: ["Confirmed registration", event.description].filter(Boolean).join(" · "),
    },
  ];
}

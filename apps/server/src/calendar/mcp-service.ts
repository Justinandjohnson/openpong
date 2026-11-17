import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { CalendarMcp, GOOGLE_CALENDAR_MCP_URL } from "./mcp.ts";

/**
 * The owner's calendar, reached over MCP.
 *
 * The connection goes straight to Google's own Calendar MCP server — the same
 * first-party server Google publishes. No third party sits in the data path,
 * the bearer comes from the owner's existing Google connection, and OpenPong
 * never stores a calendar credential of its own.
 */

export type CalendarMcpProvider = "google";

export const CALENDAR_MCP_PROVIDERS: Record<CalendarMcpProvider, { label: string; url: string }> = {
  google: {
    label: "Google Calendar (official MCP server)",
    url: GOOGLE_CALENDAR_MCP_URL,
  },
};

export interface CalendarMcpView {
  configured: boolean;
  provider?: CalendarMcpProvider;
  label?: string;
  url?: string;
  /** Last four characters of a stored token, so the owner can recognise it. */
  hint?: string;
  updatedAt?: string;
}

export interface CalendarMcpInput {
  provider: CalendarMcpProvider;
  url?: string;
  token?: string;
}

export interface CalendarMcpEvent {
  id?: string;
  title: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  calendar?: string;
  status?: string;
}

export interface CalendarAgenda {
  events: CalendarMcpEvent[];
  calendars: string[];
  truncated: boolean;
}

interface StoredCalendarMcp {
  id: string;
  provider: CalendarMcpProvider;
  url: string;
  hint?: string;
  updatedAt: string;
}

/** The two methods we need from GoogleAuth; kept structural so tests can stub it. */
export interface CalendarTokenSource {
  accessToken(owner: string): Promise<string>;
}

export interface CalendarMcpServiceOptions {
  /** Test seam: build a client without touching the network. */
  clientFactory?: (options: { url: string; token?: string }) => CalendarMcp;
}

const MAX_CALENDARS = 10;
const MAX_EVENTS = 100;

export class CalendarMcpService {
  constructor(
    private readonly db: Store,
    private readonly google: CalendarTokenSource | undefined,
    private readonly options: CalendarMcpServiceOptions = {},
  ) {}

  async view(owner: string): Promise<CalendarMcpView> {
    const record = await this.db.get<StoredCalendarMcp>(owner, "calendar-mcp", "default");
    if (!record) return { configured: false };
    return {
      configured: true,
      provider: record.provider,
      label: CALENDAR_MCP_PROVIDERS[record.provider]?.label,
      url: record.url,
      hint: record.hint,
      updatedAt: record.updatedAt,
    };
  }

  async save(owner: string, raw: unknown): Promise<CalendarMcpView> {
    const input = (raw ?? {}) as Partial<CalendarMcpInput>;
    const provider = input.provider;
    if (provider !== "google")
      throw new AppError("Calendar connections go straight to Google's own MCP server.", 400);
    const spec = CALENDAR_MCP_PROVIDERS.google;
    const url = (input.url ?? spec.url).trim();
    if (!url) throw new AppError("That calendar server address is empty.", 400);
    const record: StoredCalendarMcp = {
      id: "default",
      provider,
      url,
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(owner, "calendar-mcp", record);
    return this.view(owner);
  }

  async remove(owner: string): Promise<void> {
    await this.db.remove(owner, "calendar-mcp", "default");
  }

  /** Build the client for this owner, resolving whichever credential it needs. */
  async client(owner: string): Promise<CalendarMcp> {
    const record = await this.db.get<StoredCalendarMcp>(owner, "calendar-mcp", "default");
    if (!record)
      throw new AppError("No calendar connection yet. Connect Google in Calendar settings.", 400);
    if (!this.google) throw new AppError("Google is not configured on this server.", 400);
    const token = await this.google.accessToken(owner).catch(() => {
      throw new AppError(
        "Your Google connection has expired. Reconnect it in Calendar settings.",
        400,
      );
    });
    const build = this.options.clientFactory ?? ((options) => new CalendarMcp(options));
    return build({ url: record.url, token });
  }

  async listTools(owner: string) {
    return (await this.client(owner)).listTools();
  }

  /** The owner's calendars as context: what is on their schedule in a window. */
  async agenda(
    owner: string,
    options: { from?: string; to?: string; calendar?: string } = {},
  ): Promise<CalendarAgenda> {
    const client = await this.client(owner);
    const from = options.from?.trim() || new Date().toISOString();
    const to = options.to?.trim() || new Date(Date.now() + 14 * 86_400_000).toISOString();

    let names: string[] = [];
    // Remember why the first call failed: if nothing at all comes back, an
    // empty agenda would be a lie — a broken connection must say so.
    let failure: unknown;
    const calendars = await client.listCalendars().catch((error: unknown) => {
      failure = error;
      return undefined;
    });
    const rows = Array.isArray(calendars?.data)
      ? (calendars.data as Array<Record<string, unknown>>)
      : [];
    names = rows
      .map((row) => String(row.id ?? row.calendarId ?? row.summary ?? "").trim())
      .filter(Boolean);

    const wanted = options.calendar?.trim()
      ? [options.calendar.trim()]
      : names.length
        ? names.slice(0, MAX_CALENDARS)
        : [undefined];

    const events: CalendarMcpEvent[] = [];
    let truncated = false;
    for (const calendarId of wanted) {
      const result = await client
        .listEvents({
          ...(calendarId ? { calendarId } : {}),
          startTime: from,
          endTime: to,
          pageSize: 50,
        })
        .catch((error: unknown) => {
          failure ??= error;
          return undefined;
        });
      for (const event of eventsOf(result?.data)) {
        events.push({ ...event, calendar: calendarId });
        if (events.length >= MAX_EVENTS) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (!events.length && !names.length && failure) throw failure;
    events.sort((a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")));
    return { events, calendars: names, truncated };
  }

  async createEvent(owner: string, args: Record<string, unknown>) {
    return (await this.client(owner)).createEvent(args);
  }

  async updateEvent(owner: string, args: Record<string, unknown>) {
    return (await this.client(owner)).call("update_event", args);
  }

  async deleteEvent(owner: string, args: Record<string, unknown>) {
    return (await this.client(owner)).call("delete_event", args);
  }

  async suggestTime(owner: string, args: Record<string, unknown>) {
    return (await this.client(owner)).suggestTime(args);
  }

  async searchEvents(owner: string, args: Record<string, unknown>) {
    return (await this.client(owner)).searchEvents(args as { query: string });
  }
}

/** Servers answer with either a bare array or `{events: [...]}`; accept both. */
export function eventsOf(data: unknown): CalendarMcpEvent[] {
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { events?: unknown })?.events)
      ? ((data as { events: unknown[] }).events as unknown[])
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const event = row as Record<string, unknown>;
    const title = String(event.summary ?? event.title ?? "").trim();
    if (!title) return [];
    const start = startOf(event.start);
    const end = startOf(event.end);
    const allDay =
      typeof event.start === "object" && (event.start as { date?: string })?.date != null;
    const location = String(event.location ?? "").trim();
    return [
      {
        ...(event.id ? { id: String(event.id) } : {}),
        title,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(allDay ? { allDay } : {}),
        ...(location ? { location } : {}),
        ...(event.status ? { status: String(event.status) } : {}),
      },
    ];
  });
}

/** Google sends `{dateTime}` or `{date}`; both become an ISO string. */
function startOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const point = value as { dateTime?: string; date?: string };
    return (point.dateTime ?? point.date)?.trim() || undefined;
  }
  return undefined;
}

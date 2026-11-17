/**
 * Dependency-free RFC 5545 writer for the Pong calendar feed.
 *
 * The feed is read-only and public once a person subscribes to its tokenised
 * URL, so the output must be boring: CRLF line endings, 75-octet folding,
 * escaped text values, and a stable UID per `pongKey`. The same input always
 * produces the same bytes, which is what lets a subscriber's client dedupe
 * instead of duplicating every sync.
 */

/** One Pong event, already normalised by `CalendarService`. */
export interface PongEvent {
  pongKey: string;
  title: string;
  /** All-day: `YYYY-MM-DD`. Timed: an ISO date-time with an offset. */
  start: string;
  /** All-day: exclusive `YYYY-MM-DD` (the day after the last day). Timed: ISO date-time. */
  end: string;
  allDay: boolean;
  location?: string;
  url?: string;
  description?: string;
  kind: "tournament" | "match" | "signup" | "session" | "custom";
}

const PRODUCT_ID = "-//OpenPong//Pong Calendar//EN";
const MAX_OCTETS = 75;
/** A continuation line starts with one space, leaving 74 octets for content. */
const CONTINUATION_OCTETS = MAX_OCTETS - 1;

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold one logical line at 75 octets without splitting a UTF-8 sequence.
 * Continuation lines begin with a single space, so they carry 74 content octets.
 */
export function foldLine(line: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let octets = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, "utf8");
    // The first line carries 75 octets; each continuation is prefixed with one
    // space, so it carries at most 74 octets of content.
    const limit = chunks.length === 0 ? MAX_OCTETS : CONTINUATION_OCTETS;
    if (octets + size > limit) {
      chunks.push(current);
      current = character;
      octets = size;
    } else {
      current += character;
      octets += size;
    }
  }
  chunks.push(current);
  return chunks.map((chunk, index) => (index === 0 ? chunk : ` ${chunk}`));
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** A civil date is already the value RFC 5545 wants after removing separators. */
function dateValue(value: string): string {
  return value.slice(0, 10).replace(/-/g, "");
}

function dateTimeValue(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid event time: ${value}`);
  return stamp(parsed);
}

function oneLine(value: string, field: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${field} must be a single line`);
  return value;
}

/**
 * The calendar body. `now` fixes DTSTAMP so tests (and identical re-reads) can
 * be byte-for-byte deterministic; production passes the current time.
 */
export function renderCalendar(events: readonly PongEvent[], now: Date = new Date()): string {
  const sorted = [...events].sort(
    (a, b) => a.start.localeCompare(b.start) || a.pongKey.localeCompare(b.pongKey),
  );
  const dtstamp = stamp(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODUCT_ID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Pong",
  ];
  for (const event of sorted) {
    const uid = `${oneLine(event.pongKey, "pongKey")}@openpong`;
    lines.push("BEGIN:VEVENT", `UID:${escapeText(uid)}`, `DTSTAMP:${dtstamp}`);
    if (event.allDay) {
      lines.push(
        `DTSTART;VALUE=DATE:${dateValue(event.start)}`,
        `DTEND;VALUE=DATE:${dateValue(event.end)}`,
      );
    } else {
      lines.push(`DTSTART:${dateTimeValue(event.start)}`, `DTEND:${dateTimeValue(event.end)}`);
    }
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.url) lines.push(`URL:${oneLine(event.url, "url")}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.flatMap(foldLine).join("\r\n")}\r\n`;
}

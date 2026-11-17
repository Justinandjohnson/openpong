import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeText,
  foldLine,
  type PongEvent,
  renderCalendar,
} from "../apps/server/src/calendar/ics.ts";

const now = new Date("2026-11-16T12:00:00Z");

function event(overrides: Partial<PongEvent> = {}): PongEvent {
  return {
    pongKey: "tournament:T-tourney.asp?t=100&r=6157",
    title: "Top Spin USA Thanksgiving Open",
    start: "2026-11-28",
    end: "2026-11-29",
    allDay: true,
    location: "Plano, TX",
    url: "https://www.omnipong.com/T-tourney.asp?t=100&r=6157",
    description: "Confirmed registration · Pong · tournament",
    kind: "tournament",
    ...overrides,
  };
}

/** Decode a folded physical line into its logical bytes. */
function unfold(ics: string): string[] {
  return ics
    .split("\r\n")
    .filter(Boolean)
    .reduce<string[]>((lines, line) => {
      if (line.startsWith(" ") && lines.length) lines[lines.length - 1] += line.slice(1);
      else lines.push(line);
      return lines;
    }, []);
}

test("folds every physical line at 75 octets and marks continuations with a space", () => {
  const long = `DESCRIPTION:${"a".repeat(200)}`;
  const folded = foldLine(long);
  assert.ok(folded.length > 1);
  for (const line of folded) assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  assert.ok(folded.slice(1).every((line) => line.startsWith(" ")));
  assert.equal(folded.map((line, index) => (index ? line.slice(1) : line)).join(""), long);

  // The whole document, not just one helper call, must respect the limit.
  const ics = renderCalendar([event({ description: "é".repeat(120) })], now);
  for (const physical of ics.split("\r\n").filter(Boolean))
    assert.ok(Buffer.byteLength(physical, "utf8") <= 75, physical);
});

test("folding never splits a UTF-8 sequence", () => {
  const ics = renderCalendar([event({ title: "🥇".repeat(60) })], now);
  const summary = unfold(ics).find((line) => line.startsWith("SUMMARY:"));
  assert.ok(summary);
  assert.equal(summary, `SUMMARY:${"🥇".repeat(60)}`);
});

test("escapes backslash, semicolon, comma and newlines in text values", () => {
  assert.equal(escapeText("a\\b;c,d\ne\r\nf"), "a\\\\b\\;c\\,d\\ne\\nf");
  const ics = renderCalendar(
    [
      event({
        title: "Club night; bring, bat\\gear",
        location: "Line one\nLine two",
        description: "Coach said: yes; then no, maybe",
      }),
    ],
    now,
  );
  const lines = unfold(ics);
  assert.ok(lines.includes("SUMMARY:Club night\\; bring\\, bat\\\\gear"));
  assert.ok(lines.includes("LOCATION:Line one\\nLine two"));
  assert.ok(lines.includes("DESCRIPTION:Coach said: yes\\; then no\\, maybe"));
});

test("uses stable UIDs and exclusive all-day dates", () => {
  const ics = renderCalendar([event()], now);
  const lines = unfold(ics);
  assert.ok(lines.includes(`UID:${event().pongKey}@openpong`));
  assert.ok(lines.includes("DTSTART;VALUE=DATE:20261128"));
  assert.ok(lines.includes("DTEND;VALUE=DATE:20261129"));
  assert.ok(lines.includes(`PRODID:-//OpenPong//Pong Calendar//EN`));
  // Same key, same UID, even for a different render.
  const again = renderCalendar([event({ title: "Renamed" })], now);
  assert.ok(unfold(again).includes(`UID:${event().pongKey}@openpong`));
});

test("renders timed events as UTC date-times and requires a single-line URL", () => {
  const ics = renderCalendar(
    [
      event({
        allDay: false,
        start: "2026-11-20T18:00:00-06:00",
        end: "2026-11-20T20:00:00-06:00",
        kind: "match",
      }),
    ],
    now,
  );
  const lines = unfold(ics);
  assert.ok(lines.includes("DTSTART:20261121T000000Z"));
  assert.ok(lines.includes("DTEND:20261121T020000Z"));
  assert.throws(
    () => renderCalendar([event({ url: "https://example.com/\r\nBad" })], now),
    /single line/,
  );
});

test("output is deterministic and sorted regardless of input order", () => {
  const early = event({ pongKey: "match:1", start: "2026-11-01", end: "2026-11-02" });
  const late = event();
  const first = renderCalendar([late, early], now);
  const second = renderCalendar([early, late], now);
  assert.equal(first, second);
  assert.ok(first.indexOf("UID:match:1@openpong") < first.indexOf("UID:tournament:"));
  assert.ok(first.endsWith("\r\n"));
  assert.equal(first.replace(/\r\n/g, "").includes("\n"), false);
  // DTSTAMP is fixed by `now`, so a re-read is byte-for-byte identical.
  assert.equal((first.match(/DTSTAMP:20261116T120000Z/g) ?? []).length, 2);
});

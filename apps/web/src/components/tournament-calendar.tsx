"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Tournament } from "@/lib/api";
import { cn } from "@/lib/utils";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function parseDates(range?: string): string[] {
  if (!range) return [];
  return [...range.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g)].map((match) => {
    const [, month, day, year] = match;
    const fullYear = year.length === 2 ? 2000 + Number(year) : Number(year);
    return `${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  });
}

export function TournamentCalendar({ tournaments }: { tournaments: Tournament[] }) {
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState<string | null>(null);

  const byDate = useMemo(() => {
    const map = new Map<string, Tournament[]>();
    for (const tournament of tournaments) {
      for (const date of parseDates(tournament.date_range)) {
        map.set(date, [...(map.get(date) ?? []), tournament]);
      }
    }
    return map;
  }, [tournaments]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDay }, () => null),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
  const key = (day: number) =>
    `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const selectedEvents = selected ? (byDate.get(selected) ?? []) : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="rounded-xl border border-border bg-card/60 p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-bold">
              {MONTHS[month]} {year}
            </p>
            <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {byDate.size} dated events
            </p>
          </div>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Previous month"
              onClick={() => setCursor(new Date(year, month - 1, 1))}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Next month"
              onClick={() => setCursor(new Date(year, month + 1, 1))}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {WEEKDAYS.map((day, index) => (
            <span
              key={`${day}-${index}`}
              className="pb-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70"
            >
              {day}
            </span>
          ))}
          {cells.map((day, index) => {
            if (day === null) return <span key={`empty-${index}`} />;
            const date = key(day);
            const events = byDate.get(date) ?? [];
            const isToday = date === new Date().toISOString().slice(0, 10);
            return (
              <button
                key={date}
                type="button"
                onClick={() => setSelected(events.length ? date : null)}
                className={cn(
                  "relative aspect-square rounded-lg border text-xs transition-colors",
                  events.length
                    ? "border-accent/25 bg-accent/8 font-bold text-foreground hover:border-accent/60"
                    : "border-transparent text-muted-foreground hover:bg-secondary",
                  selected === date && "ring-2 ring-accent/60",
                  isToday && "border-primary/50",
                )}
              >
                {day}
                {events.length > 0 && (
                  <span className="absolute inset-x-0 bottom-1.5 mx-auto size-1 rounded-full bg-accent" />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card/60 p-4">
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          {selected ? selected : "Pick a highlighted day"}
        </p>
        <div className="mt-3 space-y-3">
          {selectedEvents.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Highlighted days have tournaments. Click one to see its details, or open the List tab
              for everything.
            </p>
          )}
          {selectedEvents.map((event, index) => (
            <div
              key={`${event.title}-${event.date_range}-${index}`}
              className="rounded-lg border border-border bg-background/40 p-3"
            >
              <p className="text-xs font-bold leading-snug">{event.title}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {event.city_state || event.location}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{event.date_range}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

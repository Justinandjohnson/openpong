"use client";

import { cn } from "@/lib/utils";

export interface FormResult {
  id?: number | string;
  date?: string;
  opponent_name?: string;
  score_summary?: string | null;
  result?: string;
  is_win?: boolean;
}

function won(match: FormResult): boolean | null {
  if (typeof match.is_win === "boolean" && (match.result || match.score_summary)) {
    return match.is_win;
  }
  if (match.result === "Win" || match.result === "W") return true;
  if (match.result === "Loss" || match.result === "L") return false;
  if (match.result?.includes("-")) {
    const [a, b] = match.result.split("-").map((part) => Number.parseInt(part, 10));
    return Number.isFinite(a) && Number.isFinite(b) ? a > b : null;
  }
  return null;
}

/**
 * Last-N form as a row of W/L chips, newest on the right. Reads at a glance the
 * way a scoreboard does: green blocks in a row mean a run.
 */
export function FormStrip({
  matches,
  limit = 10,
  className,
}: {
  matches: FormResult[];
  limit?: number;
  className?: string;
}) {
  const recent = matches.slice(0, limit).reverse();
  const decided = recent
    .map((match) => ({ match, win: won(match) }))
    .filter((entry): entry is { match: FormResult; win: boolean } => entry.win !== null);
  const wins = decided.filter((entry) => entry.win).length;

  if (!decided.length) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        No scored results yet — they appear here as soon as a match is logged.
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center gap-1">
        {decided.map(({ match, win }) => {
          const opponent = match.opponent_name || "opponent";
          const score = match.score_summary ? ` ${match.score_summary}` : "";
          return (
            <span
              key={`${match.id ?? match.date ?? ""}-${opponent}`}
              title={`${win ? "Win" : "Loss"} vs ${opponent}${score}${match.date ? ` · ${match.date.slice(0, 10)}` : ""}`}
              className={cn(
                "grid h-7 min-w-0 flex-1 place-items-center rounded-md text-[11px] font-black text-background",
                win ? "bg-accent" : "bg-primary/85",
              )}
            >
              {win ? "W" : "L"}
            </span>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        <span className="font-bold text-foreground tabular-nums">
          {wins}–{decided.length - wins}
        </span>{" "}
        in the last {decided.length} scored
      </p>
    </div>
  );
}

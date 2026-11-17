"use client";

import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { isWin, type Match, sourceLabel, when } from "@/lib/api";
import { cn } from "@/lib/utils";

export function MatchList({ matches, compact = false }: { matches: Match[]; compact?: boolean }) {
  if (matches.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6 text-center">
        <p className="text-sm font-semibold">No matches in the ledger yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ask the coach to sync your OmniPong match history.
        </p>
        <Link
          href={`/chat?prompt=${encodeURIComponent("Sync my match history from OmniPong.")}`}
          className={cn(buttonClassName({ variant: "accent", size: "sm" }), "mt-3")}
        >
          <Sparkles className="size-3.5" /> Sync matches
        </Link>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/70">
      {matches.map((match, index) => {
        const won = isWin(match);
        return (
          <div
            key={`${match.id ?? index}-${match.date}`}
            className="flex items-center gap-3 py-2.5"
          >
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-lg border text-[10px] font-black",
                won
                  ? "border-accent/30 bg-accent/10 text-accent"
                  : "border-primary/25 bg-primary/10 text-primary",
              )}
            >
              {won ? "W" : "L"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-foreground">
                {match.opponent_name || "Unknown opponent"}
                {match.opponent_rating != null && (
                  <span className="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground">
                    ({match.opponent_rating})
                  </span>
                )}
              </p>
              <p className="truncate text-[10px] text-muted-foreground">
                {when(match.date)} · {match.score_summary || match.set_scores || "score pending"}
              </p>
            </div>
            {!compact && <Badge variant="outline">{sourceLabel(match.source)}</Badge>}
          </div>
        );
      })}
      {compact && (
        <Link
          href="/scoreboard"
          className="flex items-center justify-between py-3 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
        >
          Open the full ledger <ArrowRight className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

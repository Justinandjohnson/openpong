"use client";

import { Filter, Search, Swords } from "lucide-react";
import { useMemo, useState } from "react";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { isWin, type Match, type MatchSummary, sourceLabel, useOpenPong } from "@/lib/api";
import { cn } from "@/lib/utils";

const FILTERS = ["all", "omnipong", "stadium_league", "stadium", "arcade"] as const;

export default function ScoreboardPage() {
  const [source, setSource] = useState<(typeof FILTERS)[number]>("all");
  const [search, setSearch] = useState("");
  const query = source === "all" ? "/matches" : `/matches?source=${source}`;
  const { data, loading, error } = useOpenPong<Match[]>(query);
  const summary = useOpenPong<MatchSummary>("/matches/summary");

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data ?? []).filter((match) =>
      needle
        ? `${match.opponent_name ?? ""} ${match.date ?? ""}`.toLowerCase().includes(needle)
        : true,
    );
  }, [data, search]);

  const wins = rows.filter(isWin).length;
  const losses = rows.length - wins;
  const overall = summary.data?.overall;

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Matches shown"
          value={rows.length}
          hint={source === "all" ? "All sources" : sourceLabel(source)}
          icon={Swords}
          loading={loading && !data}
        />
        <StatCard
          label="Wins"
          value={wins}
          hint="In this view"
          icon={Swords}
          tone="accent"
          loading={loading && !data}
        />
        <StatCard
          label="Losses"
          value={losses}
          hint="In this view"
          icon={Swords}
          tone="primary"
          loading={loading && !data}
        />
        <StatCard
          label="Career win rate"
          value={overall ? `${overall.win_rate ?? 0}%` : undefined}
          hint={overall ? `${overall.wins ?? 0}–${overall.losses ?? 0} overall` : "Full ledger"}
          icon={Filter}
          loading={summary.loading && !summary.data}
        />
      </section>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-background/40 p-1">
            {FILTERS.map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setSource(filter)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-colors",
                  source === filter
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {filter === "all" ? "All" : sourceLabel(filter)}
              </button>
            ))}
          </div>
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search opponent or date…"
              className="pl-9"
            />
          </div>
          <Badge variant="outline">{rows.length} results</Badge>
        </div>
      </Card>

      {error && (
        <div className="rounded-xl border border-primary/30 bg-primary/8 px-3 py-2 text-xs">
          Could not load matches: {error}
        </div>
      )}

      {loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card className="grid place-items-center p-12 text-center">
          <Swords className="mb-2 size-7 text-muted-foreground/60" />
          <p className="text-sm font-semibold">No matches in this view</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Sync your history from the coach, or pick a different source.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  <th className="px-4 py-3 font-bold">Result</th>
                  <th className="px-4 py-3 font-bold">Opponent</th>
                  <th className="px-4 py-3 text-right font-bold">Rating</th>
                  <th className="px-4 py-3 font-bold">Score</th>
                  <th className="px-4 py-3 font-bold">Sets</th>
                  <th className="px-4 py-3 font-bold">Date</th>
                  <th className="px-4 py-3 font-bold">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((match, index) => {
                  const won = isWin(match);
                  return (
                    <tr
                      key={`${match.id ?? index}`}
                      className="border-b border-border/60 transition-colors hover:bg-secondary/30"
                    >
                      <td className="px-4 py-3">
                        <Badge variant={won ? "accent" : "primary"}>{won ? "Win" : "Loss"}</Badge>
                      </td>
                      <td className="px-4 py-3 font-semibold">
                        {match.opponent_name || "Unknown"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                        {match.opponent_rating ?? "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{match.score_summary || "—"}</td>
                      <td className="max-w-[220px] truncate px-4 py-3 font-mono text-[11px] text-muted-foreground">
                        {match.set_scores || "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
                        {match.date}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">{sourceLabel(match.source)}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

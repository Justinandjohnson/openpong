"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Flame,
  Gauge,
  Scale,
  Sparkles,
  Swords,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { RatingChart } from "@/components/rating-chart";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  isWin,
  type MatchSummary,
  type RatingPoint,
  type Stats,
  useOpenPong,
  when,
} from "@/lib/api";

type Source = "usatt" | "league";

export default function AnalyticsPage() {
  const [source, setSource] = useState<Source>("usatt");
  const stats = useOpenPong<Stats>(`/stats?source=${source}`);
  const history = useOpenPong<RatingPoint[]>(`/rating_history?source=${source}`);
  const summary = useOpenPong<MatchSummary>("/matches/summary");

  const trendValue = Number.parseInt(String(stats.data?.trend ?? "").replace(/[^-\d]/g, ""), 10);
  const trendUp = Number.isFinite(trendValue) && trendValue > 0;
  const trendDown = Number.isFinite(trendValue) && trendValue < 0;

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Badge variant="accent">
            <Sparkles className="size-2.5" /> Performance
          </Badge>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Rating trajectory, record and the patterns the coach uses when it talks about your game.
          </p>
        </div>
        <div className="flex rounded-xl border border-border bg-card p-1">
          <button
            type="button"
            onClick={() => setSource("usatt")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${source === "usatt" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
          >
            Official USATT
          </button>
          <button
            type="button"
            onClick={() => setSource("league")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${source === "league" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
          >
            Club league
          </button>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Win rate"
          value={stats.data?.win_rate}
          hint={
            stats.data?.rating_context || (source === "usatt" ? "USATT Official" : "Club League")
          }
          icon={Gauge}
          tone="accent"
          loading={stats.loading && !stats.data}
        />
        <StatCard
          label="Record"
          value={stats.data ? `${stats.data.wins ?? 0}–${stats.data.losses ?? 0}` : undefined}
          hint="Wins – losses"
          icon={Swords}
          loading={stats.loading && !stats.data}
        />
        <StatCard
          label="Sessions"
          value={stats.data?.tournaments}
          hint="Distinct match days"
          icon={Activity}
          loading={stats.loading && !stats.data}
        />
        <StatCard
          label="Trend"
          value={stats.data?.trend}
          hint={
            trendUp ? "Recent points gained" : trendDown ? "Recent points lost" : "Recent points"
          }
          icon={trendUp ? ArrowUpRight : ArrowDownRight}
          tone={trendDown ? "primary" : "default"}
          loading={stats.loading && !stats.data}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Rating trajectory</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                {source === "usatt" ? "Official USATT points." : "Club league points."}
              </p>
            </div>
            <Badge variant="outline">{history.data?.length ?? 0} points</Badge>
          </CardHeader>
          <CardContent>
            <RatingChart points={history.data ?? []} loading={history.loading && !history.data} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Flame className="size-4 text-primary" /> Match patterns
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Derived from set scores, not guesswork.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              {
                label: "Comeback wins",
                value: stats.data?.patterns?.comebacks ?? 0,
                hint: "Lost set one, won the match",
                icon: Flame,
                tone: "text-accent",
              },
              {
                label: "Lost leads",
                value: stats.data?.patterns?.chokes ?? 0,
                hint: "Won set one, lost the match",
                icon: Scale,
                tone: "text-primary",
              },
              {
                label: "Close-game wins",
                value: `${stats.data?.patterns?.close_game_win_rate ?? 0}%`,
                hint: "Deciding points within two",
                icon: Gauge,
                tone: "text-foreground",
              },
            ].map(({ label, value, hint, icon: Icon, tone }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-xl border border-border bg-background/40 p-3"
              >
                <span className="grid size-9 place-items-center rounded-xl border border-border bg-secondary">
                  <Icon className={`size-4 ${tone}`} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {label}
                  </p>
                  <p className="text-lg font-black tabular-nums">{value}</p>
                  <p className="text-[10px] text-muted-foreground">{hint}</p>
                </div>
              </div>
            ))}
            <Link
              href={`/chat?prompt=${encodeURIComponent("Analyze my match patterns and tell me what to work on.")}`}
              className={`${buttonClassName({ variant: "accent", size: "sm" })} w-full`}
            >
              <Sparkles className="size-3.5" /> Ask for a plan
            </Link>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Season breakdown</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Every match in the ledger, grouped by year.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {(summary.data?.years ?? []).map((year) => (
            <details
              key={year.year}
              className="overflow-hidden rounded-xl border border-border bg-background/30"
              open
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="text-sm font-bold">{year.year}</span>
                <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <Badge variant="accent">{year.wins}W</Badge>
                  <Badge variant="primary">{year.losses}L</Badge>
                  <span>
                    {year.win_rate}% · {year.tournaments} session{year.tournaments === 1 ? "" : "s"}
                  </span>
                </span>
              </summary>
              <div className="divide-y divide-border/60 border-t border-border/60">
                {year.matches.slice(0, 10).map((match, index) => (
                  <div
                    key={`${match.id ?? index}`}
                    className="flex items-center gap-3 px-4 py-2.5 text-xs"
                  >
                    <Badge variant={isWin(match) ? "accent" : "primary"}>
                      {isWin(match) ? "W" : "L"}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {match.opponent_name || "Unknown"}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {when(match.date)}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {match.score_summary || ""}
                    </span>
                  </div>
                ))}
                {year.matches.length > 10 && (
                  <div className="px-4 py-2 text-[10px] text-muted-foreground">
                    +{year.matches.length - 10} more in the ledger
                  </div>
                )}
              </div>
            </details>
          ))}
          {(summary.data?.years ?? []).length === 0 && (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              No match history stored yet. Ask the coach to sync your OmniPong data.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

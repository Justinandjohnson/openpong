"use client";

import {
  Activity,
  ArrowRight,
  Bell,
  CalendarDays,
  Flame,
  Gauge,
  MapPin,
  MessageSquare,
  Trophy,
} from "lucide-react";
import Link from "next/link";
import { FormStrip } from "@/components/form-strip";
import { MatchList } from "@/components/match-list";
import { RatingChart } from "@/components/rating-chart";
import { RatingSpark } from "@/components/rating-spark";
import { RecordRing } from "@/components/record-ring";
import { StatCard } from "@/components/stat-card";
import { SyncCard } from "@/components/sync-card";
import { buttonClassName } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentSnapshot,
  type Match,
  type MatchSummary,
  type RatingPoint,
  type Stats,
  type Tournament,
  type UserProfile,
  useOpenPong,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const QUICK_ACTIONS = [
  { label: "My rating", prompt: "What's my USATT rating?", icon: Gauge },
  { label: "Tournaments", prompt: "Find tournaments near me", icon: MapPin },
  { label: "Last match", prompt: "Show my last match", icon: Flame },
  { label: "Watch area", prompt: "Watch tournaments near me", icon: Bell },
];

const HERO_LINKS = [{ label: "Calendar", href: "/calendar", icon: CalendarDays }];

function greeting(name?: string): string {
  const hour = new Date().getHours();
  const part = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = name?.trim().split(/\s+/)[0];
  return first ? `${part}, ${first}.` : `${part}.`;
}

function eventDates(range?: string): number[] {
  if (!range) return [];
  return [...range.matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g)].map((match) => {
    const [, month, day, year] = match;
    const fullYear = year.length === 2 ? 2000 + Number(year) : Number(year);
    return new Date(fullYear, Number(month) - 1, Number(day)).getTime();
  });
}

function upcoming(tournaments: Tournament[]): Tournament[] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return tournaments
    .filter((tournament) => {
      const dates = eventDates(tournament.date_range);
      return dates.length > 0 && Math.max(...dates) >= now.getTime();
    })
    .sort((a, b) => Math.min(...eventDates(a.date_range)) - Math.min(...eventDates(b.date_range)));
}

function _when(iso?: string): string {
  if (!iso) return "No date";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso.slice(0, 10);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function DashboardPage() {
  const user = useOpenPong<UserProfile>("/user");
  const agent = useOpenPong<AgentSnapshot>("/agent", { refreshMs: 60_000 });
  const summary = useOpenPong<MatchSummary>("/matches/summary");
  const stats = useOpenPong<Stats>("/stats?source=league");
  const history = useOpenPong<RatingPoint[]>("/rating_history");
  const officialHistory = useOpenPong<RatingPoint[]>("/rating_history?source=usatt");
  const matches = useOpenPong<Match[]>("/matches");
  const tournaments = useOpenPong<Tournament[]>("/tournaments?region=local");

  const overall = summary.data?.overall;
  const ledger = matches.data ?? [];
  const decided = ledger.filter(
    (match) => match.result === "Win" || match.result === "Loss" || Boolean(match.score_summary),
  );
  const recent = (decided.length ? decided : ledger).slice(0, 2);
  const next = upcoming(tournaments.data ?? []).slice(0, 2);
  const _agentName = agent.data?.identity?.name || "OpenPong";
  const tasksOpen = (agent.data?.tasks ?? []).filter(
    (task) => task.status && !["succeeded", "cancelled", "failed"].includes(task.status),
  );
  const unread = (agent.data?.notifications ?? []).filter((notification) => !notification.read);
  const hasError = user.error || summary.error || tournaments.error;
  const official = stats.data?.rating_context || "USATT official";
  const officialPoints = (officialHistory.data ?? [])
    .filter((point) => Number.isFinite(point.rating))
    .slice()
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
  const delta = (() => {
    const points = officialPoints.length > 1 ? officialPoints : (history.data ?? []);
    const last = points.at(-1);
    const previous = points.at(-2);
    if (!last || !previous) return null;
    return last.rating - previous.rating;
  })();
  // Every rating point the service has for this owner, deduplicated by day+rating.
  const trend = (() => {
    const seen = new Set<string>();
    return [...(history.data ?? []), ...(officialHistory.data ?? [])]
      .filter((point) => Number.isFinite(point.rating))
      .filter((point) => {
        const key = `${point.date}:${point.rating}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
  })();
  // The official USATT series is the headline trend; league ratings are the fallback.
  const chartPoints = officialPoints.length ? officialPoints : trend;

  return (
    <div className="flex flex-col gap-[clamp(6px,0.9vh,10px)]">
      {hasError && (
        <div className="rounded-xl border border-primary/30 bg-primary/8 px-4 py-2 text-xs text-foreground">
          <span className="font-bold text-primary">Live data unavailable.</span>{" "}
          {user.error || summary.error || tournaments.error} The dashboard keeps the last known view
          while the connection recovers.
        </div>
      )}

      {/* Row 1 — who you are, your rating, and the one button that refreshes everything */}
      <section className="grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1.1fr)_minmax(0,0.85fr)] [@media(max-height:820px)]:gap-2">
        <Card className="relative min-w-0 overflow-hidden p-0">
          <div className="pointer-events-none absolute inset-0 pong-grid opacity-40" />
          <div className="relative flex h-full min-w-0 flex-col justify-center gap-2.5 p-4">
            <div>
              <h2 className="text-balance text-2xl font-black leading-[1.05] tracking-tight">
                {user.loading && !user.data ? (
                  <span className="inline-block h-8 w-56 animate-pulse rounded-xl bg-secondary/70" />
                ) : (
                  greeting(user.data?.full_name)
                )}
              </h2>
              <p className="mt-1.5 max-w-md text-xs text-muted-foreground">
                Ratings, matches and area tournaments — one agent that can act on all of it.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_ACTIONS.map(({ label, prompt, icon: Icon }) => (
                <Link
                  key={prompt}
                  href={`/chat?prompt=${encodeURIComponent(prompt)}`}
                  className={buttonClassName({ variant: "secondary", size: "sm" })}
                >
                  <Icon className="size-3.5 text-accent" /> {label}
                </Link>
              ))}
              {HERO_LINKS.map(({ label, href, icon: Icon }) => (
                <Link
                  key={href}
                  href={href}
                  className={buttonClassName({ variant: "secondary", size: "sm" })}
                >
                  <Icon className="size-3.5 text-primary" /> {label}
                </Link>
              ))}
            </div>
          </div>
        </Card>

        <Card className="relative min-w-0 overflow-hidden p-0">
          <div className="absolute right-[-3rem] top-[-3rem] size-36 rounded-full bg-primary/10 blur-2xl" />
          <div className="relative flex h-full flex-col gap-2 p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  USATT rating
                </p>
                <div className="flex items-end gap-2">
                  <span className="text-4xl font-black tabular-nums leading-none tracking-tight">
                    {user.loading && !user.data ? (
                      <Skeleton className="h-9 w-24" />
                    ) : (
                      (user.data?.rating ?? "—")
                    )}
                  </span>
                  {delta !== null && (
                    <span
                      className={cn(
                        "mb-0.5 rounded-full border px-2 py-0.5 text-[10px] font-bold tabular-nums",
                        delta >= 0
                          ? "border-accent/30 bg-accent/10 text-accent"
                          : "border-primary/30 bg-primary/10 text-primary",
                      )}
                      title="Change since your previous rated session"
                    >
                      {delta >= 0 ? "+" : ""}
                      {delta}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {user.data?.usatt_number
                    ? `USATT #${user.data.usatt_number}`
                    : "Add your USATT id in Settings"}
                </p>
              </div>
              <span className="grid size-10 place-items-center rounded-2xl border border-accent/25 bg-accent/10 text-accent">
                <Trophy className="size-5" />
              </span>
            </div>
            <RatingSpark
              points={(officialPoints.length ? officialPoints : trend).slice(-14)}
              height={42}
              className="mt-auto"
            />
            <div className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-2.5 py-1">
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Official context
              </span>
              <span className="text-[11px] font-bold text-accent">{official}</span>
            </div>
          </div>
        </Card>

        <SyncCard />
      </section>

      {/* Row 2 — the four numbers people track */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 [@media(max-height:820px)]:gap-2">
        <Card className="flex min-w-0 items-center gap-3 p-2.5">
          <RecordRing
            wins={overall?.wins ?? 0}
            losses={overall?.losses ?? 0}
            size={58}
            label="won"
          />
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Overall record
            </p>
            <p className="mt-1 truncate text-xl font-black tabular-nums tracking-tight">
              {overall ? `${overall.wins ?? 0}–${overall.losses ?? 0}` : "—"}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {overall?.total ?? 0} scored matches
            </p>
          </div>
        </Card>
        <StatCard
          label="Win rate"
          value={overall ? `${overall.win_rate ?? 0}%` : undefined}
          hint="Across every source"
          icon={Gauge}
          tone="accent"
          loading={summary.loading && !summary.data}
        />
        <StatCard
          label="League sessions"
          value={stats.data?.tournaments}
          hint={stats.data?.rating_context || "Club league"}
          icon={Activity}
          loading={stats.loading && !stats.data}
        />
        <StatCard
          label="Area events"
          value={tournaments.data?.length}
          hint="Upcoming near you"
          icon={CalendarDays}
          tone="primary"
          loading={tournaments.loading && !tournaments.data}
        />
      </section>

      {/* Row 3 — trend, form, results, what's next */}
      <section className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] [@media(max-height:820px)]:gap-2">
        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between pb-1">
            <div>
              <CardTitle>Rating trend</CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Official USATT ratings · {chartPoints.length} points
              </p>
            </div>
            <Link href="/analytics" className={buttonClassName({ variant: "ghost", size: "sm" })}>
              Analytics <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent>
            <RatingChart
              points={chartPoints}
              loading={(history.loading || officialHistory.loading) && chartPoints.length === 0}
              compact
            />
          </CardContent>
        </Card>

        <Card className="flex min-h-0 flex-col p-0">
          <CardHeader className="flex-row items-center justify-between pb-1">
            <div>
              <CardTitle>Recent matches</CardTitle>
              <p className="text-[11px] text-muted-foreground">Scored results, newest first.</p>
            </div>
            <Link href="/scoreboard" className={buttonClassName({ variant: "ghost", size: "sm" })}>
              All <ArrowRight className="size-3.5" />
            </Link>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2">
            <FormStrip matches={decided} limit={10} />
            <div className="min-h-0 flex-1 overflow-hidden">
              {matches.loading && !matches.data ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <MatchList matches={recent} compact />
              )}
            </div>
            <Link
              href="/matches/new"
              className="text-[10px] font-bold uppercase tracking-wider text-accent hover:underline"
            >
              Log a match
            </Link>
          </CardContent>
        </Card>
      </section>

      {/* Row 4 — the agent, kept to one line so nothing needs scrolling */}
      <section className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-2xl border border-border bg-card/50 px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative grid size-7 place-items-center rounded-lg border border-accent/25 bg-accent/10">
            <span className="pong-ball size-2 rounded-full" />
          </span>
          <div>
            <p className="text-[11px] font-bold leading-tight">
              {agent.data?.worker?.running ? "Agent running" : "Agent idle"}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {tasksOpen.length} open {tasksOpen.length === 1 ? "task" : "tasks"} · {unread.length}{" "}
              unread
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
            Next up
          </span>
          {next.length ? (
            next.map((tournament) => (
              <Link
                key={`${tournament.title}-${tournament.date_range}`}
                href={`/chat?prompt=${encodeURIComponent(`Tell me about "${tournament.title ?? "this tournament"}" and whether it fits my rating. If it does, prepare a signup for my approval.`)}`}
                className="max-w-[24rem] min-w-0 truncate rounded-full border border-border bg-background/50 px-2.5 py-1 text-[10px] font-medium hover:border-primary/40"
              >
                {tournament.title || "Tournament"}
                {tournament.city_state ? ` · ${tournament.city_state.split(",")[0]}` : ""}
              </Link>
            ))
          ) : (
            <span className="text-[10px] text-muted-foreground">
              The scout fills this in daily.
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Link href="/tournaments" className={buttonClassName({ variant: "ghost", size: "sm" })}>
            <CalendarDays className="size-3.5" /> Events
          </Link>
          <Link href="/activity" className={buttonClassName({ variant: "ghost", size: "sm" })}>
            <Activity className="size-3.5" /> Activity
          </Link>
          <Link href="/chat" className={buttonClassName({ variant: "accent", size: "sm" })}>
            <MessageSquare className="size-3.5" /> Ask the coach
          </Link>
        </div>
      </section>
    </div>
  );
}

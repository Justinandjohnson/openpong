"use client";

import {
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Loader2,
  PauseCircle,
  Play,
  Radar,
  RefreshCw,
  Target,
  Trophy,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenPong } from "@/lib/api";

/**
 * Goals: the owner's goals, recurring watches and the always-on daily scout.
 *
 * The scout runs in the server's durable task worker at the owner's chosen local
 * hour (or on demand). It reads the same area list the coach uses and announces
 * each new tournament exactly once; this page only shows the last run and lets
 * the owner change the switch and hour.
 */

interface ScoutState {
  enabled: boolean;
  hour: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastResult?: { found: number; newCount: number };
  seenCount?: number;
}

interface Goal {
  id: string;
  title: string;
  description?: string;
  status?: string;
  milestones?: { id: string; title: string; done: boolean }[];
}

interface Watch {
  id: string;
  title: string;
  status?: string;
  intervalMinutes?: number;
  kind?: string;
  region?: string;
  nextCheckAt?: string;
}

interface Snapshot {
  goals?: Goal[];
  monitors?: Watch[];
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:00 ${suffix}`;
}

function dateTime(value?: string): string {
  if (!value) return "not yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function scout<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/scout${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message =
      (data as { error?: string } | null)?.error || `Scout request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function GoalsPage() {
  const agent = useOpenPong<Snapshot>("/agent", { refreshMs: 30_000 });
  const [scoutState, setScoutState] = useState<ScoutState | null>(null);
  const [scoutError, setScoutError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadScout = useCallback(async () => {
    try {
      setScoutState(await scout<ScoutState>(""));
      setScoutError(null);
    } catch (cause) {
      setScoutError(cause instanceof Error ? cause.message : "Scout unavailable");
    }
  }, []);

  useEffect(() => {
    void loadScout();
  }, [loadScout]);

  const saveScout = async (patch: { enabled?: boolean; hour?: number }) => {
    setSaving(true);
    setNotice(null);
    try {
      setScoutState(await scout<ScoutState>("", { method: "PUT", body: JSON.stringify(patch) }));
      setScoutError(null);
    } catch (cause) {
      setScoutError(cause instanceof Error ? cause.message : "That setting was not saved");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setNotice(null);
    try {
      await scout<{ task: { id: string; status?: string } }>("/run", { method: "POST" });
      setNotice("Scout queued. Checking the feed now…");
      // The durable task finishes within a worker tick; let it record the run.
      await sleep(2500);
      await loadScout();
      agent.refresh();
      setNotice("Scout finished. New tournaments appear in Activity.");
    } catch (cause) {
      setScoutError(cause instanceof Error ? cause.message : "The scout could not be started");
    } finally {
      setRunning(false);
    }
  };

  const goals = agent.data?.goals ?? [];
  const watches = agent.data?.monitors ?? [];

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant="primary">
              <Target className="size-2.5" /> Goals
            </Badge>
            <Badge variant="outline">{goals.length} goals</Badge>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            What the coach is working toward, the watches that keep an eye on your area, and the
            daily scout that looks for new tournaments on its own.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={agent.refresh} disabled={agent.loading}>
          <RefreshCw className={agent.loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </section>

      {agent.error && (
        <div className="rounded-xl border border-primary/30 bg-primary/8 px-3 py-2 text-xs">
          Could not load the agent workspace: {agent.error}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Radar className="size-4 text-accent" /> Daily scout
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Every day at {hourLabel(scoutState?.hour ?? 8)}, look for new tournaments in your area
              and notify you once per tournament. Uses your saved area, never a fixed region.
            </p>
          </div>
          <Badge variant={scoutState?.enabled ? "success" : "outline"}>
            {scoutState?.enabled ? "On" : "Off"}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {!scoutState && !scoutError ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2 text-xs font-semibold">
                  <input
                    type="checkbox"
                    className="size-4 accent-emerald-500"
                    checked={scoutState?.enabled ?? false}
                    disabled={saving}
                    onChange={(event) => void saveScout({ enabled: event.target.checked })}
                  />
                  {scoutState?.enabled ? "Enabled" : "Disabled"}
                </label>
                <label className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-3 py-2 text-xs">
                  <CalendarClock className="size-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">Hour</span>
                  <select
                    className="rounded-md border border-border bg-card px-2 py-1 text-xs font-semibold"
                    value={scoutState?.hour ?? 8}
                    disabled={saving}
                    onChange={(event) =>
                      void saveScout({ hour: Number.parseInt(event.target.value, 10) })
                    }
                  >
                    {HOURS.map((hour) => (
                      <option key={hour} value={hour}>
                        {hourLabel(hour)}
                      </option>
                    ))}
                  </select>
                </label>
                <Button variant="accent" size="sm" onClick={runNow} disabled={running}>
                  {running ? <Loader2 className="animate-spin" /> : <Play />} Run now
                </Button>
                {saving && <span className="text-[11px] text-muted-foreground">Saving…</span>}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-background/40 px-3 py-2 text-xs">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                    Last run
                  </p>
                  <p className="mt-1 flex items-center gap-1.5">
                    {scoutState?.lastRunAt ? (
                      <>
                        <CheckCircle2 className="size-3.5 text-emerald-400" />
                        {dateTime(scoutState.lastRunAt)}
                        <span className="text-muted-foreground">
                          · found {scoutState.lastResult?.newCount ?? 0} new of{" "}
                          {scoutState.lastResult?.found ?? 0}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Hasn't run yet.</span>
                    )}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-background/40 px-3 py-2 text-xs">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                    Next run
                  </p>
                  <p className="mt-1 flex items-center gap-1.5">
                    <CircleDot className="size-3.5 text-accent" />
                    {scoutState?.enabled ? dateTime(scoutState.nextRunAt) : "Scout is off"}
                    <span className="text-muted-foreground">
                      · {scoutState?.seenCount ?? 0} tournaments remembered
                    </span>
                  </p>
                </div>
              </div>

              {notice && (
                <p className="rounded-lg border border-accent/25 bg-accent/8 px-3 py-2 text-xs">
                  {notice}
                </p>
              )}
              {scoutError && (
                <p className="rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-xs">
                  {scoutError}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="size-4 text-accent" /> Goals
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Created from chat or an accepted idea; milestones are completed by finished tasks.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {agent.loading && !agent.data ? (
              <Skeleton className="h-24 w-full" />
            ) : goals.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No goals yet. Ask the coach to plan something.
              </p>
            ) : (
              goals.map((goal) => {
                const done = (goal.milestones ?? []).filter((item) => item.done).length;
                const total = (goal.milestones ?? []).length;
                return (
                  <div
                    key={goal.id}
                    className="rounded-lg border border-border bg-background/40 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold">{goal.title}</p>
                      <Badge variant={goal.status === "active" ? "accent" : "outline"}>
                        {goal.status ?? "active"}
                      </Badge>
                    </div>
                    {goal.description && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                        {goal.description}
                      </p>
                    )}
                    {total > 0 && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {done}/{total} milestones
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="size-4 text-primary" /> Watches
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Recurring checks the coach runs for you. Manage them in Activity.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {agent.loading && !agent.data ? (
              <Skeleton className="h-24 w-full" />
            ) : watches.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No watches yet. Ask the coach to watch a page or your area tournaments.
              </p>
            ) : (
              watches.map((watch) => (
                <div
                  key={watch.id}
                  className="rounded-lg border border-border bg-background/40 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold">{watch.title}</p>
                    <Badge variant={watch.status === "active" ? "success" : "warning"}>
                      {watch.status === "active" ? "active" : (watch.status ?? "paused")}
                    </Badge>
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    {watch.status === "active" ? (
                      <CircleDot className="size-3" />
                    ) : (
                      <PauseCircle className="size-3" />
                    )}
                    {watch.kind === "tournament"
                      ? `${watch.region ?? "your area"} tournaments`
                      : `every ${watch.intervalMinutes ?? 15} min`}
                    {watch.nextCheckAt ? ` · next ${dateTime(watch.nextCheckAt)}` : ""}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

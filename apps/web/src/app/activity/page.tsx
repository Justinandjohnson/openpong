"use client";

import {
  Bell,
  Check,
  CircleSlash,
  Loader2,
  Pause,
  Play,
  Radar,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentSnapshot, useOpenPong, when } from "@/lib/api";

/**
 * Activity: the whole agent, operable from the dashboard.
 *
 * Anything the agent wants to do that touches the outside world lands here as a
 * proposal. Approving and denying happen here (not in chat), long tasks can be
 * paused, resumed, cancelled or retried, watches can be checked or paused, and
 * every notification can be read. Same endpoints the native app uses.
 */

interface ActionProposal {
  id: string;
  title: string;
  kind: string;
  status: string;
  hash: string;
  createdAt?: string;
  expiresAt?: string;
  result?: string;
  error?: string;
}

interface TaskStep {
  id: string;
  title: string;
  status: string;
  detail?: string;
}

interface AgentTask {
  id: string;
  title: string;
  prompt?: string;
  kind: string;
  status: string;
  plan?: TaskStep[];
  createdAt?: string;
  updatedAt?: string;
  nextRunAt?: string;
  attempts?: number;
  question?: string;
  error?: string;
  result?: string;
  actionId?: string;
}

interface Monitor {
  id: string;
  title: string;
  url: string;
  condition: string;
  intervalMinutes: number;
  status: string;
  nextCheckAt?: string;
}

interface Notification {
  id: string;
  title: string;
  body?: string;
  createdAt?: string;
  read?: boolean;
}

/**
 * OpenPong v1 ships no mail or calendar integrations (they were OpenMuse's).
 * Old proposals from a previous life stay in storage; hiding them keeps this
 * list about work the product can actually execute today.
 */
const REMOVED_INTEGRATION = /^(email|calendar)\./i;

const statusVariant = (status: string) => {
  switch (status) {
    case "succeeded":
    case "sent":
    case "approved":
      return "success" as const;
    case "running":
    case "executing":
    case "awaiting_review":
    case "waiting_approval":
    case "waiting_input":
      return "warning" as const;
    case "failed":
    case "denied":
    case "cancelled":
    case "expired":
    case "outcome_unknown":
      return "outline" as const;
    default:
      return "default" as const;
  }
};

async function agentPost(path: string, body: unknown): Promise<void> {
  const response = await fetch(`/api/openpong/agent/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
}

export default function ActivityPage() {
  const snapshot = useOpenPong<AgentSnapshot>("/agent", { refreshMs: 15_000 });
  const actions = useOpenPong<ActionProposal[]>("/agent/actions", { refreshMs: 15_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const tasks = (snapshot.data?.tasks ?? []) as AgentTask[];
  const monitors = (snapshot.data?.monitors ?? []) as Monitor[];
  const notifications = (snapshot.data?.notifications ?? []) as Notification[];

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      snapshot.refresh();
      actions.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not go through");
    } finally {
      setBusy(null);
    }
  }

  const pending = (actions.data ?? []).filter(
    (action) => action.status === "awaiting_review" && !REMOVED_INTEGRATION.test(action.kind),
  );
  const open = tasks.filter((task) =>
    ["queued", "running", "waiting_input", "waiting_approval", "scheduled", "paused"].includes(
      task.status,
    ),
  );
  const recent = tasks
    .filter((task) => !open.includes(task))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, 8);

  const loading = snapshot.loading && !snapshot.data;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Activity</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Approvals, running work, watches and alerts. Nothing reaches the outside world until you
            approve it here.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            snapshot.refresh();
            actions.refresh();
          }}
          disabled={snapshot.loading || actions.loading}
        >
          <RefreshCw
            className={`size-3.5 ${snapshot.loading || actions.loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          {error}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-accent" /> Needs your approval
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              A prepared signup or message is a proposal, never an action taken.
            </p>
          </div>
          <Badge variant={pending.length ? "warning" : "outline"}>{pending.length} pending</Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <Skeleton className="h-16 w-full" />
          ) : pending.length === 0 ? (
            <p className="rounded-xl border border-border bg-background/40 px-3 py-4 text-xs text-muted-foreground">
              Nothing waiting. When the coach prepares something that touches the outside world, it
              appears here with the details and an approve button.
            </p>
          ) : (
            pending.map((action) => (
              <div
                key={action.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/5 px-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{action.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    <span className="font-mono">{action.kind}</span> · prepared{" "}
                    {when(action.createdAt)}
                    {action.expiresAt ? ` · expires ${when(action.expiresAt)}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      run(`approve-${action.id}`, () =>
                        agentPost(`actions/${action.id}/decide`, {
                          hash: action.hash,
                          decision: "approve",
                        }),
                      )
                    }
                    disabled={busy === `approve-${action.id}`}
                  >
                    {busy === `approve-${action.id}` ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      run(`deny-${action.id}`, () =>
                        agentPost(`actions/${action.id}/decide`, {
                          hash: action.hash,
                          decision: "deny",
                        }),
                      )
                    }
                    disabled={busy === `deny-${action.id}`}
                  >
                    <X className="size-3.5" /> Deny
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Radar className="size-4 text-primary" /> Open work
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Durable tasks survive restarts. Pause, resume, retry or cancel at any time.
            </p>
          </div>
          <Badge variant="primary">{open.length} open</Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : open.length === 0 ? (
            <p className="rounded-xl border border-border bg-background/40 px-3 py-4 text-xs text-muted-foreground">
              No open tasks. Ask the coach for a sync, a watch or a signup preview to start one.
            </p>
          ) : (
            open.map((task) => (
              <div key={task.id} className="rounded-xl border border-border bg-background/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-semibold">{task.title}</p>
                  <Badge variant={statusVariant(task.status)}>
                    {task.status.replaceAll("_", " ")}
                  </Badge>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {task.kind} · updated {when(task.updatedAt)}
                  {task.attempts ? ` · attempt ${task.attempts}` : ""}
                  {task.nextRunAt ? ` · next ${when(task.nextRunAt)}` : ""}
                </p>
                {task.plan && task.plan.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {task.plan.slice(0, 6).map((step) => (
                      <li key={step.id} className="flex items-start gap-2 text-[11px]">
                        <span
                          className={`mt-1 size-1.5 shrink-0 rounded-full ${
                            step.status === "succeeded"
                              ? "bg-emerald-400"
                              : step.status === "running"
                                ? "bg-amber-400 animate-pong-pulse"
                                : step.status === "failed"
                                  ? "bg-red-400"
                                  : "bg-muted-foreground/40"
                          }`}
                        />
                        <span
                          className={
                            step.status === "succeeded" ? "text-muted-foreground line-through" : ""
                          }
                        >
                          {step.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {task.question && (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <Input
                      className="h-9 min-w-40 flex-1"
                      placeholder={task.question}
                      value={answers[task.id] ?? ""}
                      onChange={(event) =>
                        setAnswers((current) => ({ ...current, [task.id]: event.target.value }))
                      }
                    />
                    <Button
                      size="sm"
                      disabled={!answers[task.id]?.trim() || busy === `answer-${task.id}`}
                      onClick={() =>
                        run(`answer-${task.id}`, () =>
                          agentPost(`tasks/${task.id}/input`, { answer: answers[task.id]?.trim() }),
                        )
                      }
                    >
                      Answer
                    </Button>
                  </div>
                )}
                {task.error && <p className="mt-2 text-[11px] text-red-300">{task.error}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {["running", "queued", "scheduled", "waiting_approval"].includes(task.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        run(`pause-${task.id}`, () =>
                          agentPost(`tasks/${task.id}/control`, { action: "pause" }),
                        )
                      }
                      disabled={busy === `pause-${task.id}`}
                    >
                      <Pause className="size-3.5" /> Pause
                    </Button>
                  )}
                  {task.status === "paused" && (
                    <Button
                      size="sm"
                      onClick={() =>
                        run(`resume-${task.id}`, () =>
                          agentPost(`tasks/${task.id}/control`, { action: "resume" }),
                        )
                      }
                      disabled={busy === `resume-${task.id}`}
                    >
                      <Play className="size-3.5" /> Resume
                    </Button>
                  )}
                  {["failed", "cancelled"].includes(task.status) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        run(`retry-${task.id}`, () =>
                          agentPost(`tasks/${task.id}/control`, { action: "retry" }),
                        )
                      }
                      disabled={busy === `retry-${task.id}`}
                    >
                      <RefreshCw className="size-3.5" /> Retry
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      run(`cancel-${task.id}`, () =>
                        agentPost(`tasks/${task.id}/control`, { action: "cancel" }),
                      )
                    }
                    disabled={busy === `cancel-${task.id}`}
                  >
                    <CircleSlash className="size-3.5" /> Cancel
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Radar className="size-4 text-accent" /> Watches
              </CardTitle>
              <p className="text-[11px] text-muted-foreground">
                Recurring checks, deduplicated alerts.
              </p>
            </div>
            <Badge variant="outline">{monitors.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {monitors.length === 0 ? (
              <p className="rounded-xl border border-border bg-background/40 px-3 py-4 text-xs text-muted-foreground">
                No watches yet. Ask the coach to watch tournaments near you.
              </p>
            ) : (
              monitors.map((monitor) => (
                <div
                  key={monitor.id}
                  className="rounded-xl border border-border bg-background/40 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold">{monitor.title}</p>
                    <Badge variant={monitor.status === "paused" ? "outline" : "success"}>
                      {monitor.status}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    every {monitor.intervalMinutes} min · next {when(monitor.nextCheckAt)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        run(`check-${monitor.id}`, () =>
                          agentPost(`monitors/${monitor.id}/control`, { action: "check" }),
                        )
                      }
                      disabled={busy === `check-${monitor.id}`}
                    >
                      Check now
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        run(`monitor-${monitor.id}`, () =>
                          agentPost(`monitors/${monitor.id}/control`, {
                            action: monitor.status === "paused" ? "resume" : "pause",
                          }),
                        )
                      }
                      disabled={busy === `monitor-${monitor.id}`}
                    >
                      {monitor.status === "paused" ? "Resume" : "Pause"}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Bell className="size-4 text-primary" /> Alerts
              </CardTitle>
              <p className="text-[11px] text-muted-foreground">
                New tournaments and finished tasks.
              </p>
            </div>
            <Badge variant="outline">
              {notifications.filter((item) => !item.read).length} unread
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {notifications.length === 0 ? (
              <p className="rounded-xl border border-border bg-background/40 px-3 py-4 text-xs text-muted-foreground">
                No alerts yet.
              </p>
            ) : (
              notifications
                .slice()
                .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
                .slice(0, 8)
                .map((notification) => (
                  <div
                    key={notification.id}
                    className={`rounded-xl border px-3 py-2.5 ${
                      notification.read
                        ? "border-border bg-background/30"
                        : "border-primary/25 bg-primary/5"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{notification.title}</p>
                        {notification.body && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                            {notification.body}
                          </p>
                        )}
                        <p className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          {when(notification.createdAt)}
                        </p>
                      </div>
                      {!notification.read && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            run(`read-${notification.id}`, () =>
                              agentPost(`notifications/${notification.id}/read`, {}),
                            )
                          }
                          disabled={busy === `read-${notification.id}`}
                        >
                          Mark read
                        </Button>
                      )}
                    </div>
                  </div>
                ))
            )}
          </CardContent>
        </Card>
      </div>

      {recent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="size-4 text-muted-foreground" /> Recent
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">Finished work, kept as a receipt.</p>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {recent.map((task) => (
              <div
                key={task.id}
                className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <Badge variant={statusVariant(task.status)}>
                  {task.status.replaceAll("_", " ")}
                </Badge>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  {when(task.updatedAt)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

"use client";

import {
  Apple,
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Status {
  provider: "google" | "ics" | null;
  calendarId?: string;
  connected: boolean;
  feedUrl?: string;
  lastSyncAt?: string;
  error?: string;
}

interface SyncResult {
  created?: number;
  updated?: number;
  skipped?: number;
  warnings?: string[];
  lastSyncAt?: string;
  error?: string;
}

const ENDPOINT = "/api/openpong/agent/calendar";

async function call<T>(path: string, method: "GET" | "POST" | "DELETE" = "GET"): Promise<T> {
  const response = await fetch(path ? `${ENDPOINT}/${path}` : ENDPOINT, {
    method,
    headers: { accept: "application/json" },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The calendar service refused that request.");
  return body;
}

const WHAT_GOES_IN = [
  "Tournaments in your area, with venue and entry link",
  "Every registration you approve",
  "League nights and sessions you played",
  "Your match results, so a week is visible at a glance",
];

export default function CalendarPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await call<Status>("");
      setStatus(next);
      if (next.feedUrl) setFeed(next.feedUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the calendar.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect() {
    setBusy("connect");
    setError(null);
    try {
      const result = await call<{ kind: "google" | "ics"; url?: string; feedUrl?: string }>(
        "connect",
        "POST",
      );
      if (result.kind === "google" && result.url) {
        window.location.href = result.url;
        return;
      }
      setFeed(result.feedUrl ?? null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the connection.");
    } finally {
      setBusy(null);
    }
  }

  async function runSync() {
    setBusy("sync");
    setError(null);
    try {
      const result = await call<SyncResult>("sync", "POST");
      setSync(result);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sync did not finish.");
    } finally {
      setBusy(null);
    }
  }

  async function rotate() {
    setBusy("rotate");
    try {
      const result = await call<{ feedUrl: string }>("feed/rotate", "POST");
      setFeed(result.feedUrl);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rotate the link.");
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    try {
      await call("", "DELETE");
      setSync(null);
      setFeed(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect.");
    } finally {
      setBusy(null);
    }
  }

  async function copyFeed() {
    if (!feed) return;
    try {
      await navigator.clipboard.writeText(feed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Your browser blocked the clipboard. Select the link and copy it manually.");
    }
  }

  const provider = status?.provider;
  const webcal = feed ? feed.replace(/^https?:\/\//, "webcal://") : null;

  return (
    <div className="flex flex-col gap-3 pb-2">
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary">
              One calendar
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight">
              The Pong calendar is the hub.
            </h2>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Matches, tournaments and registrations land in one place you already check. The coach
              may add, move or remove items it created — never anything else on your calendar.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {status === null ? (
              <Skeleton className="h-6 w-24" />
            ) : (
              <Badge variant={status.connected ? "accent" : "default"}>
                {provider === "google"
                  ? "Google · Pong"
                  : provider === "ics"
                    ? "iCal subscription"
                    : "Not connected"}
              </Badge>
            )}
          </div>
        </div>
      </Card>

      {error && (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive-foreground">
          {error}
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarDays className="size-4 text-primary" /> Connect
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              One tap. Google gets a real Pong calendar; Apple and Outlook subscribe to a private
              read-only feed.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {status === null ? (
              <Skeleton className="h-11 w-full" />
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="accent" onClick={connect} disabled={busy !== null}>
                  {busy === "connect" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : provider === "google" ? (
                    <RefreshCw className="size-4" />
                  ) : (
                    <CalendarDays className="size-4" />
                  )}
                  {provider === "google"
                    ? "Reconnect Google"
                    : status.connected
                      ? "Connect Google instead"
                      : "Connect my calendar"}
                </Button>
                {status.connected && (
                  <Button variant="ghost" onClick={disconnect} disabled={busy !== null}>
                    {busy === "disconnect" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Unplug className="size-4" />
                    )}
                    Disconnect
                  </Button>
                )}
              </div>
            )}

            {webcal && (
              <div className="rounded-xl border border-border bg-background/50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    <Apple className="size-3.5" /> Subscribe once
                  </span>
                  {provider !== "google" && (
                    <Button variant="ghost" size="sm" onClick={rotate} disabled={busy !== null}>
                      {busy === "rotate" ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="size-3.5" />
                      )}
                      New link
                    </Button>
                  )}
                </div>
                <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {feed}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a href={webcal ?? "#"} className="text-[11px] font-bold text-accent underline">
                    Add to Apple Calendar
                  </a>
                  <button
                    type="button"
                    onClick={copyFeed}
                    className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? "Copied" : "Copy link"}
                  </button>
                  <a
                    href="https://calendar.google.com/calendar/u/0/r/settings/addbyurl"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="size-3.5" /> Add to Google by URL
                  </a>
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">
                  The link is private to your account. Rotating it cancels every old subscription.
                </p>
              </div>
            )}

            <div className="rounded-xl border border-border bg-background/40 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                What lands in Pong
              </p>
              <ul className="mt-1.5 grid gap-1 text-[11px] sm:grid-cols-2">
                {WHAT_GOES_IN.map((item) => (
                  <li key={item} className="flex items-start gap-1.5">
                    <Check className="mt-0.5 size-3 shrink-0 text-primary" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="size-4 text-accent" /> Keep it current
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Every league sync and scout run writes here too. A calendar outage never fails a job.
            </p>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-2">
            {status?.lastSyncAt && (
              <p className="text-[11px] text-muted-foreground">
                Last write{" "}
                <span className="font-semibold text-foreground">
                  {new Date(status.lastSyncAt).toLocaleString()}
                </span>
              </p>
            )}
            {sync && (
              <div className="rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-[11px]">
                <span className="font-bold text-primary">
                  {sync.created ?? 0} new · {sync.updated ?? 0} updated
                </span>
                {sync.skipped ? (
                  <span className="text-muted-foreground"> · {sync.skipped} unchanged</span>
                ) : null}
                {sync.warnings?.length ? (
                  <p className="mt-1 text-muted-foreground">{sync.warnings[0]}</p>
                ) : null}
              </div>
            )}
            <Button
              variant="outline"
              onClick={runSync}
              disabled={busy !== null || !status?.connected}
            >
              {busy === "sync" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Sync to Pong
            </Button>
            {!status?.connected && (
              <p className="text-[10px] text-muted-foreground">
                Connect first — there is nothing to write to yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

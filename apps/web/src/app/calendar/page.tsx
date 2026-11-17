"use client";

import {
  Apple,
  CalendarDays,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CalendarMcpCard } from "@/components/calendar-mcp-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchGoogleStatus,
  GOOGLE_SETUP_DOC,
  type GoogleCalendarStatus,
  startGoogleConnect,
} from "@/lib/google-calendar";

interface Status {
  provider: "google" | "ics" | null;
  calendarId?: string;
  connected: boolean;
  feedUrl?: string;
  lastSyncAt?: string;
  error?: string;
}

interface AgendaEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  calendar: string;
}

interface Agenda {
  events: AgendaEvent[];
  calendars: string[];
  truncated: boolean;
  connected: boolean;
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

const CONTEXT_GRANTED = [
  "See the events on the calendars you choose, so the coach can answer schedule questions and spot clashes",
  "Create and manage the Pong calendar it made",
  "Never your mail, and never changes to the calendars you already own",
];

function formatDay(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
    : value.slice(0, 10);
}

function formatTime(event: AgendaEvent): string {
  if (event.allDay) return "All day";
  const date = new Date(event.start);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : event.start.slice(11, 16);
}

export default function CalendarPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<string | null>(null);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [agendaError, setAgendaError] = useState<string | null>(null);
  const [google, setGoogle] = useState<GoogleCalendarStatus | null>(null);
  const [googleLoaded, setGoogleLoaded] = useState(false);
  const [googleNote, setGoogleNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await call<Status>("");
      setStatus(next);
      if (next.feedUrl) setFeed(next.feedUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the calendar.");
    }
    try {
      setGoogle(await fetchGoogleStatus());
    } catch {
      setGoogle(null);
    } finally {
      setGoogleLoaded(true);
    }
  }, []);

  const loadAgenda = useCallback(async () => {
    setAgendaError(null);
    try {
      const response = await fetch(`${ENDPOINT}/agenda`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as Agenda & { error?: string };
      // The server answers 409 when reading has no Google connection; that is a
      // state, not a failure, and the card explains it.
      if (response.status === 409) {
        setAgenda({ events: [], calendars: [], truncated: false, connected: false });
        return;
      }
      if (!response.ok) throw new Error(body.error || "Could not read your calendars.");
      setAgenda(body);
    } catch (cause) {
      setAgendaError(cause instanceof Error ? cause.message : "Could not read your calendars.");
    }
  }, []);

  useEffect(() => {
    void load();
    void loadAgenda();
  }, [load, loadAgenda]);

  // The consent round trip lands back here with ?google=connected or
  // ?google=error: show the result, refresh the preview, then clean the URL so a
  // reload does not repeat the note.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("google");
    if (!outcome) return;
    if (outcome === "connected") {
      setGoogleNote({ kind: "ok", text: "Google is connected. Reading your calendars now." });
      void load();
      void loadAgenda();
    } else {
      const reason = params.get("reason");
      setGoogleNote({
        kind: "error",
        text: reason
          ? `Google could not be connected (${reason}). Try again.`
          : "Google could not be connected. Try again.",
      });
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("google");
    url.searchParams.delete("reason");
    window.history.replaceState({}, "", url.toString());
  }, [load, loadAgenda]);

  async function connectGoogle() {
    setBusy("google");
    setGoogleNote(null);
    setError(null);
    try {
      const result = await startGoogleConnect();
      if (result.url) {
        window.location.assign(result.url);
        return;
      }
      setGoogleNote({ kind: "ok", text: "Google is already connected." });
      await load();
      await loadAgenda();
    } catch (cause) {
      setGoogleNote({
        kind: "error",
        text: cause instanceof Error ? cause.message : "Could not start the Google connection.",
      });
    } finally {
      setBusy(null);
    }
  }

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
      await loadAgenda();
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
  const nowMs = Date.now();
  const upcoming = (agenda?.events ?? [])
    .filter((event) => {
      const start = Date.parse(event.start);
      return (
        Number.isFinite(start) && start >= nowMs - 12 * 3600000 && start <= nowMs + 7 * 86400000
      );
    })
    .slice(0, 8);

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

      <Card className="flex flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="size-4 text-primary" /> Your calendars as context
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Connecting lets OpenPong (a) see the events on the calendars you choose, so the coach
            can answer schedule questions and spot clashes, and (b) create and manage the Pong
            calendar. It never reads your mail, and it never changes events on the calendars you
            already own.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="rounded-xl border border-border bg-background/40 p-3">
            <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              <ShieldCheck className="size-3.5" /> What you grant
            </p>
            <ul className="mt-1.5 grid gap-1 text-[11px] sm:grid-cols-2">
              {CONTEXT_GRANTED.map((item) => (
                <li key={item} className="flex items-start gap-1.5">
                  <Check className="mt-0.5 size-3 shrink-0 text-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {googleNote && (
            <p
              className={`rounded-xl border px-3 py-2 text-[11px] ${
                googleNote.kind === "ok"
                  ? "border-accent/40 bg-accent/10 text-foreground"
                  : "border-destructive/40 bg-destructive/10 text-destructive-foreground"
              }`}
            >
              {googleNote.text}
            </p>
          )}

          {!googleLoaded ? (
            <Skeleton className="h-20 w-full" />
          ) : google === null ? (
            <p className="rounded-xl border border-border bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
              Could not check the Google connection here. Refresh the page to try again.
            </p>
          ) : !google.configured ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-background/40 p-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                This server has no Google app set up, so the coach cannot read your calendars here.
                The private iCal link above still works — it publishes the Pong calendar, but it is
                write-only and cannot be read back.
              </p>
              <a
                href={GOOGLE_SETUP_DOC}
                target="_blank"
                rel="noreferrer"
                className="flex w-fit items-center gap-1 text-[11px] font-bold text-accent underline"
              >
                <ExternalLink className="size-3.5" /> Set up Google
              </a>
            </div>
          ) : !google.connected ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-background/40 p-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Connect Google once so the coach can read the calendars you choose as context and
                keep the Pong calendar current. It never reads your mail and never changes events on
                calendars you already own.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="accent" size="sm" onClick={connectGoogle} disabled={busy !== null}>
                  {busy === "google" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <CalendarDays className="size-3.5" />
                  )}
                  Connect Google Calendar
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <Badge variant="accent">
                  <Check className="size-3" /> Connected
                </Badge>
                <span>
                  {google.calendars === 1
                    ? "Seeing 1 calendar"
                    : `Seeing ${google.calendars} calendars`}
                  {agenda?.calendars?.length ? `: ${agenda.calendars.slice(0, 3).join(", ")}` : ""}
                </span>
                <button
                  type="button"
                  onClick={connectGoogle}
                  disabled={busy !== null}
                  className="font-bold text-accent underline"
                >
                  Reconnect
                </button>
              </div>

              {agendaError ? (
                <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive-foreground">
                  {agendaError}
                </p>
              ) : agenda === null ? (
                <Skeleton className="h-20 w-full" />
              ) : agenda.connected ? (
                <div className="rounded-xl border border-border bg-background/50 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Next 7 days
                  </p>
                  {upcoming.length ? (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {upcoming.map((event) => (
                        <li
                          key={`${event.calendar}:${event.start}:${event.title}`}
                          className="flex items-baseline justify-between gap-3 text-[11px]"
                        >
                          <span className="min-w-0 truncate font-semibold text-foreground">
                            {event.title}
                          </span>
                          <span className="shrink-0 text-muted-foreground">
                            {formatDay(event.start)} · {formatTime(event)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Nothing on your calendars in the next 7 days.
                    </p>
                  )}
                  {agenda.truncated && (
                    <p className="mt-1.5 text-[10px] text-muted-foreground/80">
                      Showing the first few; there may be more.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Reading your calendars needs Google connected. The private iCal feed is write-only
                  and cannot be read back.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <CalendarMcpCard />
    </div>
  );
}

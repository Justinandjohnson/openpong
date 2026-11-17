"use client";

import { CalendarClock, CheckCircle2, Loader2, Plug, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const BASE = "/api/openpong/agent/calendar/mcp";

interface McpView {
  configured: boolean;
  provider?: "google";
  label?: string;
  url?: string;
  hint?: string;
  updatedAt?: string;
}

interface AgendaEvent {
  title: string;
  start?: string;
  allDay?: boolean;
  calendar?: string;
}

/**
 * The agent's own calendar connection, over MCP — straight to Google's own
 * Calendar MCP server, using the Google connection the owner already made.
 * No third party sits in the data path.
 */
export function CalendarMcpCard() {
  const [view, setView] = useState<McpView | null>(null);
  const [provider, setProvider] = useState<"google">("google");
  const [tools, setTools] = useState<string[] | null>(null);
  const [events, setEvents] = useState<AgendaEvent[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(BASE, { cache: "no-store" });
      const body = (await response.json()) as McpView;
      setView(body);
      if (body.provider) setProvider(body.provider);
    } catch {
      setView({ configured: false });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy("save");
    setNote(null);
    try {
      const response = await fetch(BASE, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = (await response.json()) as McpView & { error?: string };
      if (!response.ok) {
        setNote({ kind: "error", text: body.error ?? "Could not save that connection." });
      } else {
        setNote({ kind: "ok", text: "Saved. Ask the coach about your week to see it working." });
        await load();
      }
    } catch {
      setNote({ kind: "error", text: "Could not reach the server." });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setNote(null);
    try {
      await fetch(BASE, { method: "DELETE" });
      setTools(null);
      setEvents(null);
      await load();
      setNote({ kind: "ok", text: "Disconnected." });
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    setBusy("check");
    setNote(null);
    setTools(null);
    setEvents(null);
    try {
      const response = await fetch(`${BASE}/tools`, { method: "POST" });
      const body = (await response.json()) as { tools?: { name: string }[]; error?: string };
      if (!response.ok) {
        setNote({ kind: "error", text: body.error ?? "That connection did not answer." });
      } else {
        const names = (body.tools ?? []).map((tool) => tool.name);
        setTools(names);
        setNote({
          kind: "ok",
          text: `Connected — ${names.length} calendar tools available.`,
        });
      }
    } catch {
      setNote({ kind: "error", text: "Could not reach the calendar service." });
    } finally {
      setBusy(null);
    }
  }

  async function preview() {
    setBusy("preview");
    setNote(null);
    try {
      const response = await fetch(`${BASE}/agenda`, { cache: "no-store" });
      const body = (await response.json()) as { events?: AgendaEvent[]; error?: string };
      if (!response.ok) {
        setNote({ kind: "error", text: body.error ?? "Could not read your calendar." });
      } else {
        setEvents(body.events ?? []);
      }
    } catch {
      setNote({ kind: "error", text: "Could not read your calendar." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-4 text-accent" /> Calendar connection for the agent
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The coach reads your real calendar through an MCP server, so it can answer schedule
          questions and check for clashes.
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {view?.configured ? (
            <Badge variant="success">
              <CheckCircle2 className="mr-1 size-3" /> {view.label}
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
          {view?.updatedAt && (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              updated {new Date(view.updatedAt).toLocaleDateString()}
            </span>
          )}
        </div>

        <div className="rounded-xl border border-border p-3">
          <span className="flex items-center gap-2 text-xs font-semibold">
            <Sparkles className="size-3.5 text-primary" /> Google Calendar
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Google&apos;s own Calendar MCP server — the coach reads the calendar you choose and only
            ever adds an event you ask for. Connect Google above first.
          </span>
        </div>

        <Button onClick={save} disabled={busy === "save"} className="self-start">
          {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : null} Use my Google
          Calendar
        </Button>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={check}
            disabled={!view?.configured || busy === "check"}
          >
            {busy === "check" ? <Loader2 className="size-3.5 animate-spin" /> : null} Test
            connection
          </Button>
          <Button
            variant="outline"
            onClick={preview}
            disabled={!view?.configured || busy === "preview"}
          >
            {busy === "preview" ? <Loader2 className="size-3.5 animate-spin" /> : null} Read next 7
            days
          </Button>
          {view?.configured && (
            <Button variant="ghost" onClick={disconnect} disabled={busy === "disconnect"}>
              Disconnect
            </Button>
          )}
        </div>

        {note && (
          <p className={`text-[11px] ${note.kind === "ok" ? "text-accent" : "text-destructive"}`}>
            {note.text}
          </p>
        )}

        {tools && (
          <p className="text-[11px] text-muted-foreground">
            Tools: <span className="text-foreground">{tools.join(", ")}</span>
          </p>
        )}

        {events && (
          <div className="rounded-xl border border-border bg-background/40 p-2.5">
            {events.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Nothing on your calendar this week.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {events.slice(0, 8).map((event, index) => (
                  <li
                    key={`${event.title}-${index}`}
                    className="flex items-baseline gap-2 text-[11px]"
                  >
                    <span className="text-muted-foreground">
                      {event.allDay
                        ? "all day"
                        : event.start
                          ? new Date(event.start).toLocaleString(undefined, {
                              weekday: "short",
                              hour: "numeric",
                              minute: "2-digit",
                            })
                          : "—"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{event.title}</span>
                    {event.calendar && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {event.calendar}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

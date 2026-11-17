"use client";

import {
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  Circle,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AiKeyCard } from "@/components/ai-key-card";
import { FindPlayer, type PlayerCandidate } from "@/components/find-player";
import { InstallButton } from "@/components/pwa";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOpenPong } from "@/lib/api";
import { type InstallState, subscribeInstall } from "@/lib/install";

interface Profile {
  displayName?: string;
  usattId?: string;
  homeRegion?: string;
  cities?: string[];
  states?: string[];
  clubs?: string[];
  leagueUrls?: string[];
}

interface CalendarStatus {
  provider?: string;
  connected?: boolean;
  feedUrl?: string;
}

interface DomainUser {
  full_name?: string;
  rating?: number;
  phone_number?: string | null;
}

function Step({
  index,
  title,
  description,
  done,
  optional,
  children,
}: {
  index: number;
  title: string;
  description: string;
  done: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className={done ? "border-accent/40" : undefined}>
      <CardHeader className="flex-row items-start gap-3">
        <span
          className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
            done ? "bg-accent/15 text-accent" : "bg-secondary text-muted-foreground"
          }`}
        >
          {done ? <CheckCircle2 className="size-4" /> : index}
        </span>
        <div className="min-w-0 flex-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            {title}
            {done ? (
              <Badge variant="success">Done</Badge>
            ) : optional ? (
              <Badge variant="outline">Optional</Badge>
            ) : (
              <Badge variant="outline">Next</Badge>
            )}
          </CardTitle>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{description}</p>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default function SetupPage() {
  const [install, setInstall] = useState<InstallState | null>(null);
  const [profile, setProfile] = useState<{ profile: Profile | null; onboarded: boolean } | null>(
    null,
  );
  const [cal, setCal] = useState<CalendarStatus | null>(null);
  const user = useOpenPong<DomainUser>("/user");

  const [leagueDraft, setLeagueDraft] = useState("");
  const [leagueNote, setLeagueNote] = useState<string | null>(null);
  const [leagueBusy, setLeagueBusy] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [phoneNote, setPhoneNote] = useState<string | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [calBusy, setCalBusy] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameNote, setNameNote] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [picked, setPicked] = useState<PlayerCandidate | null>(null);

  useEffect(() => subscribeInstall(setInstall), []);

  // The agent-plane routes are not part of the plain data BFF, so they are read
  // directly; each one degrades to "unknown" rather than breaking the wizard.
  const loadProfile = useCallback(async () => {
    const response = await fetch("/api/profile", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    setProfile(
      (await response.json().catch(() => null)) as {
        profile: Profile | null;
        onboarded: boolean;
      } | null,
    );
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    let alive = true;
    fetch("/api/openpong/agent/calendar", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => alive && setCal(body))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const current = profile?.profile ?? null;
  useEffect(() => {
    if (current?.leagueUrls?.length) setLeagueDraft(current.leagueUrls.join("\n"));
    else if (current) setLeagueDraft("");
  }, [current]);
  useEffect(() => {
    if (user.data?.phone_number) setPhoneDraft(user.data.phone_number);
  }, [user.data]);
  useEffect(() => {
    if (current?.displayName) setNameDraft(current.displayName);
  }, [current?.displayName]);

  function applyCandidate(candidate: PlayerCandidate) {
    setPicked(candidate);
    setNameDraft(candidate.name);
    setNameNote(null);
  }

  async function saveName() {
    setNameBusy(true);
    setNameNote(null);
    const payload: Record<string, unknown> = {
      ...(current ?? {}),
      displayName: nameDraft.trim(),
    };
    if (picked?.usattId) payload.usattId = picked.usattId;
    if (picked?.state) {
      const states = new Set([...(current?.states ?? []), picked.state]);
      payload.states = [...states];
    }
    if (picked?.club) {
      const clubs = new Set([...(current?.clubs ?? []), picked.club]);
      payload.clubs = [...clubs];
    }
    const response = await fetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { error?: string } | null;
    setNameBusy(false);
    if (!response?.ok) {
      setNameNote(body?.error ?? "Could not save your name.");
      return;
    }
    setNameNote("Saved. The coach knows who you are now.");
    void loadProfile();
  }

  const hasName = Boolean(current?.displayName?.trim());
  const hasArea = Boolean(current?.cities?.length || current?.states?.length);
  const hasLeague = Boolean(current?.leagueUrls?.length);
  const calendarDone = Boolean(cal?.connected);
  const textsDone = Boolean(user.data?.phone_number);

  const required = [
    Boolean(install?.installed),
    hasName && hasArea,
    hasLeague,
    calendarDone,
    textsDone,
  ];
  const doneCount = required.filter(Boolean).length;
  const pct = Math.round((doneCount / required.length) * 100);

  async function saveLeague() {
    setLeagueBusy(true);
    setLeagueNote(null);
    const leagueUrls = leagueDraft
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("http") ? line : `https://${line}`));
    const response = await fetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(current ?? {}), leagueUrls }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { error?: string } | null;
    setLeagueBusy(false);
    if (!response?.ok) {
      setLeagueNote(body?.error ?? "Could not save that link.");
      return;
    }
    setLeagueNote("Saved. The sync button and the daily scout will use it.");
    void loadProfile();
  }

  async function savePhone() {
    setPhoneBusy(true);
    setPhoneNote(null);
    const response = await fetch("/api/openpong/agent/phone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: phoneDraft.trim() }),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as { error?: string } | null;
    setPhoneBusy(false);
    if (!response?.ok) {
      setPhoneNote(body?.error ?? "Could not save that number.");
      return;
    }
    setPhoneNote("Saved. The daily scout can text you now.");
    user.refresh();
  }

  async function sendTest() {
    setPhoneBusy(true);
    setPhoneNote(null);
    const response = await fetch("/api/openpong/agent/phone/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      error?: string;
      sent?: boolean;
      detail?: string;
    } | null;
    setPhoneBusy(false);
    if (!response?.ok) {
      setPhoneNote(body?.error ?? "Could not send a test text.");
      return;
    }
    setPhoneNote(
      body?.sent
        ? "Test text sent — check your phone."
        : (body?.detail ?? "The text could not be sent yet."),
    );
  }

  async function connectCalendar() {
    setCalBusy(true);
    const response = await fetch("/api/openpong/agent/calendar/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as {
      error?: string;
      kind?: string;
      url?: string;
      feedUrl?: string;
    } | null;
    setCalBusy(false);
    if (!response?.ok || !body) {
      setCal({ connected: false });
      return;
    }
    if (body.kind === "google" && body.url) {
      window.location.href = body.url;
      return;
    }
    setCal({ provider: "ics", connected: true, feedUrl: body.feedUrl });
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <Card>
        <CardHeader className="flex-row items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10">
            <Sparkles className="size-4 text-primary" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-base">Get set up</CardTitle>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              Five steps and OpenPong manages your table tennis life: it knows who you are and where
              you play, pulls your league results, and puts everything on one calendar. Optionally
              paste your own AI key so the coach runs on your account.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="shrink-0 text-[11px] font-bold tabular-nums text-muted-foreground">
                {doneCount} of {required.length}
              </span>
            </div>
          </div>
        </CardHeader>
      </Card>

      <Step
        index={1}
        title="Install the app"
        description="Add OpenPong to your home screen or dock. It then opens full screen and keeps working when your signal drops."
        done={Boolean(install?.installed)}
      >
        {install?.installed ? (
          <p className="text-xs text-muted-foreground">
            Installed on this device. Open it from your home screen any time.
          </p>
        ) : install?.canPrompt ? (
          <InstallButton size="lg" label="Install OpenPong" />
        ) : install?.ios ? (
          <p className="text-xs text-muted-foreground">
            On iPhone or iPad: tap <span className="font-semibold">Share</span>, then{" "}
            <span className="font-semibold">Add to Home Screen</span>.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Your browser will offer this once the app is served over https (or on localhost). In
            Chrome or Edge, the install icon appears in the address bar.
          </p>
        )}
      </Step>

      <Step
        index={2}
        title="Your name and area"
        description="Tournament searches, the daily scout and the coach all filter to your area, so nothing else's results get mixed in."
        done={hasName && hasArea}
      >
        <div className="mb-3 rounded-xl border border-border bg-background/40 p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            Give your name, and we'll find you
          </p>
          <p className="mt-1 mb-2 text-[11px] leading-snug text-muted-foreground">
            Type your name, pick the person who is you, and we fill in your USATT number and state.
            Could not find you? Just type your name and save it yourself.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              className="min-h-10 min-w-0 flex-1 rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary"
            />
            <Button size="sm" onClick={saveName} disabled={nameBusy || !nameDraft.trim()}>
              {nameBusy ? <Loader2 className="size-3.5 animate-spin" /> : null} Save name
            </Button>
          </div>
          <div className="mt-2">
            <FindPlayer initialName={nameDraft} onPick={applyCandidate} compact />
          </div>
          {nameNote && <p className="mt-2 text-[11px] text-muted-foreground">{nameNote}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <UserRound className="size-3.5" />
            {hasName ? current?.displayName : "No name yet"}
          </span>
          <span className="flex items-center gap-1.5">
            <Users className="size-3.5" />
            {current?.cities?.length
              ? current.cities.slice(0, 3).join(", ") +
                (current.cities.length > 3 ? ` +${current.cities.length - 3}` : "")
              : "No cities yet"}
          </span>
          {current?.usattId && (
            <span className="flex items-center gap-1.5">
              <BadgeCheck className="size-3.5" /> USATT {current.usattId}
            </span>
          )}
        </div>
        <Link
          href="/settings/profile"
          className="mt-2 inline-flex text-xs font-bold text-accent underline"
        >
          {hasName && hasArea ? "Edit my profile" : "Set up my profile"}
        </Link>
      </Step>

      <Step
        index={3}
        title="Your league"
        description="Paste the public page of your league (Stadium TT). The dashboard's Sync button then pulls every match — no login, no password."
        done={hasLeague}
      >
        <textarea
          value={leagueDraft}
          onChange={(event) => setLeagueDraft(event.target.value)}
          rows={2}
          placeholder={"https://stadiumtt.com/tournament/…\nOne link per line"}
          className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-xs outline-none focus:border-accent"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={saveLeague} disabled={leagueBusy}>
            {leagueBusy ? <Loader2 className="size-3.5 animate-spin" /> : null} Save league
          </Button>
          {hasLeague && <Badge variant="success">Saved</Badge>}
        </div>
        {leagueNote && <p className="mt-2 text-[11px] text-muted-foreground">{leagueNote}</p>}
      </Step>

      <Step
        index={4}
        title="Your calendar"
        description="Google connects once so the coach can read the calendars you choose as context and keep a Pong calendar of your tournaments, sign-ups and results; Apple and Outlook subscribe to a private, write-only link."
        done={calendarDone}
      >
        {calendarDone ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CalendarDays className="size-3.5" />
              {cal?.provider === "google" ? "Google · Pong calendar" : "iCal subscription"}
            </span>
            <Link href="/calendar" className="font-bold text-accent underline">
              Open the calendar hub
            </Link>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={connectCalendar} disabled={calBusy}>
              {calBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CalendarDays className="size-3.5" />
              )}
              Connect a calendar
            </Button>
            <Link href="/calendar" className="text-xs font-bold text-accent underline">
              See what lands in Pong
            </Link>
          </div>
        )}
      </Step>

      <Step
        index={5}
        title="Text alerts"
        description="Save a mobile number and the daily scout texts you when a new tournament appears near you. Replies are answered by rule, so a text can never spend your model credits."
        done={textsDone}
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={phoneDraft}
            onChange={(event) => setPhoneDraft(event.target.value)}
            placeholder="+1 512 555 0134"
            className="min-w-0 flex-1 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs outline-none focus:border-accent"
          />
          <Button size="sm" onClick={savePhone} disabled={phoneBusy || !phoneDraft.trim()}>
            {phoneBusy ? <Loader2 className="size-3.5 animate-spin" /> : null} Save number
          </Button>
          <Button size="sm" variant="ghost" onClick={sendTest} disabled={phoneBusy || !textsDone}>
            <MessageSquare className="size-3.5" /> Send a test text
          </Button>
        </div>
        {phoneNote && <p className="mt-2 text-[11px] text-muted-foreground">{phoneNote}</p>}
      </Step>

      <Step
        index={6}
        title="Your AI key"
        description="Optional. Paste a key from OpenRouter, OpenAI, Anthropic or Google Gemini and the coach runs on your key instead of the server's. It takes about a minute and nothing else needs installing."
        done={false}
        optional
      >
        <AiKeyCard bare />
      </Step>

      <Step
        index={7}
        title="Browser"
        description="Built in. The coach reads and acts on public pages in the app's own browser, and you can take over that same window whenever a page needs your login, 2FA or a captcha. Nothing to install."
        done
        optional
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <MonitorSmartphone className="size-3.5" />
            Ready — no extension, no companion
          </span>
        </div>
      </Step>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 pt-4 text-[11px] text-muted-foreground">
          {doneCount === required.length ? (
            <>
              <CheckCircle2 className="size-3.5 text-accent" />
              <span className="font-semibold text-foreground">You are set up.</span>
              <span>Ask the coach anything, or press Sync on the dashboard.</span>
            </>
          ) : (
            <>
              <Circle className="size-3.5" />
              <span>
                Steps 1–5 take about two minutes. You can come back to this page any time.
              </span>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

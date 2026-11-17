"use client";

import { CheckCircle2, Loader2, MapPin, Trophy, User } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { FindPlayer, type PlayerCandidate } from "@/components/find-player";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Your profile: the single record that says who you are and where you play.
 *
 * Everything the agent knows about "me" — name, USATT number, home area, clubs,
 * league URLs — comes from here. Nothing is a default or a literal, so a brand
 * new person can fill this in and the tournament search, the league sync and the
 * coach all follow their own region instead of someone else's.
 */

interface OwnerProfile {
  displayName?: string;
  usattId?: string;
  homeRegion?: string;
  cities?: string[];
  states?: string[];
  clubs?: string[];
  leagueUrls?: string[];
  updatedAt?: string;
}

interface ProfileView {
  profile: OwnerProfile | null;
  onboarded: boolean;
}

interface Draft {
  displayName: string;
  usattId: string;
  homeRegion: string;
  cities: string;
  states: string;
  clubs: string;
  leagueUrls: string;
}

const emptyDraft: Draft = {
  displayName: "",
  usattId: "",
  homeRegion: "",
  cities: "",
  states: "",
  clubs: "",
  leagueUrls: "",
};

function splitList(text: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of text.split(/[,\n]+/)) {
    const value = part.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

function withScheme(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function draftFrom(profile: OwnerProfile | null | undefined): Draft {
  if (!profile) return emptyDraft;
  return {
    displayName: profile.displayName ?? "",
    usattId: profile.usattId ?? "",
    homeRegion: profile.homeRegion ?? "",
    cities: (profile.cities ?? []).join(", "),
    states: (profile.states ?? []).join(", "),
    clubs: (profile.clubs ?? []).join(", "),
    leagueUrls: (profile.leagueUrls ?? []).join("\n"),
  };
}

function payloadFrom(draft: Draft) {
  const optional = (value: string) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };
  const list = (value: string) => {
    const values = splitList(value);
    return values.length ? values : undefined;
  };
  const usattId = optional(draft.usattId);
  const homeRegion = optional(draft.homeRegion);
  const cities = list(draft.cities);
  const states = list(draft.states);
  const clubs = list(draft.clubs);
  const leagueUrls = splitList(draft.leagueUrls).map(withScheme).filter(Boolean);
  return {
    displayName: draft.displayName.trim(),
    ...(usattId ? { usattId } : {}),
    ...(homeRegion ? { homeRegion } : {}),
    ...(cities ? { cities } : {}),
    ...(states ? { states } : {}),
    ...(clubs ? { clubs } : {}),
    ...(leagueUrls.length ? { leagueUrls } : {}),
  };
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="block">
      <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
        {required && <span className="text-accent"> *</span>}
      </span>
      <Input
        aria-label={label}
        className="mt-1"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

export default function ProfilePage() {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await fetch("/api/profile", { cache: "no-store" });
        const body = (await response.json()) as ProfileView & { error?: string };
        if (!response.ok) throw new Error(body?.error || "Could not load your profile");
        if (!alive) return;
        setDraft(draftFrom(body.profile));
        setOnboarded(Boolean(body.onboarded));
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "Could not load your profile");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const set = (key: keyof Draft) => (value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(null);
  };

  // Filling a chosen candidate sets the name and USATT number, and — when the
  // public result carries them — the state and club. We never invent a region or
  // city the search did not provide.
  function applyCandidate(candidate: PlayerCandidate) {
    setDraft((current) => {
      const withValue = (text: string, value: string) => {
        const existing = splitList(text);
        if (existing.some((item) => item.toLowerCase() === value.toLowerCase())) return text;
        return [...existing, value].join(", ");
      };
      const states = candidate.state ? withValue(current.states, candidate.state) : current.states;
      const clubs = candidate.club ? withValue(current.clubs, candidate.club) : current.clubs;
      const homeRegion = current.homeRegion || candidate.homeRegion || candidate.region || "";
      return {
        ...current,
        displayName: candidate.name,
        usattId: candidate.usattId ?? current.usattId,
        homeRegion,
        states,
        clubs,
      };
    });
    setSaved(null);
  }

  async function save() {
    if (!draft.displayName.trim()) {
      setError("Your name is the one thing the profile needs.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payloadFrom(draft)),
      });
      const body = (await response.json()) as OwnerProfile & { error?: string };
      if (!response.ok) throw new Error(body?.error || "Those details were not saved");
      setDraft(draftFrom(body));
      setOnboarded(true);
      setSaved("Saved. The coach, the tournament search and the league sync all use this now.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Those details were not saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Your profile</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Who you are and where you play. The agent reads this instead of assuming anything.
          </p>
        </div>
        <Badge variant={onboarded ? "success" : "outline"}>
          {onboarded ? "Profile set" : "First run"}
        </Badge>
      </div>

      {loading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="size-4 text-primary" /> Identity
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Only your name is required. Everything else is optional and editable at any time.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Your name"
                required
                value={draft.displayName}
                onChange={set("displayName")}
                placeholder="How the coach should address you"
              />
              <Field
                label="USATT number"
                hint="Optional. Used to match official ratings and results."
                value={draft.usattId}
                onChange={set("usattId")}
                placeholder="e.g. 1234567"
              />
            </div>

            <div className="rounded-xl border border-border bg-background/40 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Give your name, and we'll find you
              </p>
              <p className="mt-1 mb-2 text-[11px] leading-snug text-muted-foreground">
                Search the public results, then pick the person who is you. It fills your name,
                USATT number and state below — you can change anything before saving.
              </p>
              <FindPlayer initialName={draft.displayName} onPick={applyCandidate} />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <MapPin className="size-3.5 text-accent" />
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                My area
              </span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Home region"
                hint="Optional region label or number you play in."
                value={draft.homeRegion}
                onChange={set("homeRegion")}
                placeholder="e.g. 8"
              />
              <Field
                label="States"
                hint="Comma separated, names or abbreviations."
                value={draft.states}
                onChange={set("states")}
                placeholder="e.g. Texas"
              />
              <Field
                label="Cities"
                hint="Comma separated. Tournament search filters to these."
                value={draft.cities}
                onChange={set("cities")}
                placeholder="e.g. Plano, Dallas"
              />
              <Field
                label="Clubs"
                hint="Comma separated. Clubs you play or train at."
                value={draft.clubs}
                onChange={set("clubs")}
                placeholder="e.g. Top Spin USA"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Trophy className="size-3.5 text-accent" />
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                League data
              </span>
            </div>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                League URLs
              </span>
              <textarea
                className="mt-1 min-h-24 w-full rounded-xl border border-input bg-background/60 px-3.5 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
                value={draft.leagueUrls}
                onChange={(event) => set("leagueUrls")(event.target.value)}
                placeholder={"https://stadiumtt.com/... (one per line)"}
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Public league pages the agent may read. Syncing league results uses these URLs.
              </span>
            </label>

            {error && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
                {error}
              </p>
            )}
            {saved && (
              <p className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-accent" /> {saved}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={save} disabled={saving || !draft.displayName.trim()}>
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {onboarded ? "Save profile" : "Finish setup"}
              </Button>
              <Link href="/" className={buttonClassName({ variant: "ghost", size: "sm" })}>
                Back to dashboard
              </Link>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

"use client";

import { Loader2, Search, UserRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * "Give your name, and I'll find you."
 *
 * Calls the public player search and shows every candidate as a selectable row
 * so the person confirms which one is them — the app never silently picks one.
 * A miss is honest: we say so and invite them to type their details themselves.
 */

export interface PlayerCandidate {
  name: string;
  usattId?: string;
  rating?: number;
  state?: string;
  club?: string;
  /** Optional area hints an upstream may provide; used only when present. */
  region?: string;
  homeRegion?: string;
  cities?: string[];
}

function candidateLabel(candidate: PlayerCandidate): string {
  const parts = [candidate.name];
  if (candidate.rating !== undefined) parts.push(`rating ${candidate.rating}`);
  if (candidate.state) parts.push(candidate.state);
  if (candidate.club) parts.push(candidate.club);
  return parts.join(" · ");
}

export function FindPlayer({
  initialName = "",
  onPick,
  compact,
}: {
  initialName?: string;
  onPick: (candidate: PlayerCandidate) => void;
  compact?: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<PlayerCandidate[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function find() {
    const query = name.trim();
    if (!query) return;
    setBusy(true);
    setNote(null);
    setCandidates(null);
    try {
      const response = await fetch("/api/openpong/agent/profile/find", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: query }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        candidates?: PlayerCandidate[];
        error?: string;
      };
      if (!response.ok) {
        setNote(body.error || "The search did not answer. You can type your details yourself.");
        return;
      }
      const found = body.candidates ?? [];
      setCandidates(found);
      if (found.length === 0)
        setNote(
          "We could not find you in the public results. You can type your name and area yourself.",
        );
    } catch {
      setNote("The search did not answer. You can type your details yourself.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void find();
            }
          }}
          placeholder="Your name, as it appears in results"
          aria-label="Your name"
          className="min-h-10 min-w-0 flex-1 rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary"
        />
        <Button size="sm" variant="secondary" onClick={find} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          Find me
        </Button>
      </div>

      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}

      {candidates && candidates.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            Which one is you?
          </p>
          {candidates.map((candidate) => (
            <button
              key={
                candidate.usattId ??
                `${candidate.name}|${candidate.state ?? ""}|${candidate.rating ?? ""}`
              }
              type="button"
              onClick={() => {
                onPick(candidate);
                setCandidates(null);
                setNote(`Using ${candidate.name}.`);
              }}
              className="flex w-full items-center gap-2 rounded-xl border border-border bg-background/50 px-3 py-2 text-left text-xs transition-colors hover:border-primary hover:bg-secondary"
            >
              <UserRound className="size-3.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{candidateLabel(candidate)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import { CheckCircle2, Loader2, Swords } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * Log one match result the owner played.
 *
 * The form posts to this app's BFF route, which calls the OpenPong server, which
 * calls the OmniPong service. The service derives the winner/loser from the
 * owner's own row and is idempotent: submitting the same result twice returns
 * the existing match instead of a duplicate.
 */

interface SavedMatch {
  status?: string;
  match_id?: number;
  created?: boolean;
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  required,
  type = "text",
  min,
  max,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
  min?: number;
  max?: number;
}) {
  const id = useId();
  return (
    <div className="block">
      <label
        htmlFor={id}
        className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground"
      >
        {label}
        {required && <span className="text-accent"> *</span>}
      </label>
      <Input
        id={id}
        className="mt-1"
        type={type}
        min={min}
        max={max}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

export default function NewMatchPage() {
  const [date, setDate] = useState(todayIso);
  const [opponent, setOpponent] = useState("");
  const [rating, setRating] = useState("");
  const [result, setResult] = useState<"Win" | "Loss">("Win");
  const [scoreSummary, setScoreSummary] = useState("");
  const [setScores, setSetScores] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedMatch | null>(null);

  const canSave = Boolean(date && opponent.trim()) && !saving;

  async function save() {
    if (!date) {
      setError("Pick the date you played.");
      return;
    }
    if (!opponent.trim()) {
      setError("The opponent's name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(null);
    const parsedRating = rating.trim() ? Number(rating.trim()) : undefined;
    if (parsedRating !== undefined && !Number.isFinite(parsedRating)) {
      setSaving(false);
      setError("Their rating must be a number.");
      return;
    }
    try {
      const response = await fetch("/api/matches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          opponent_name: opponent.trim(),
          opponent_rating: parsedRating,
          result,
          score_summary: scoreSummary.trim() || undefined,
          set_scores: setScores.trim() || undefined,
        }),
      });
      const body = (await response.json()) as SavedMatch & { error?: string };
      if (!response.ok) throw new Error(body?.error || "That result was not saved");
      setSaved(body);
      // Keep the opponent and scores so a follow-up correction is quick, but
      // clear the transient state that would make a double submit confusing.
      setScoreSummary("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That result was not saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Log a match</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Record a result you played. Your stats and the coach update from it.
          </p>
        </div>
        <Badge variant="outline">Manual result</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Swords className="size-4 text-primary" /> Result
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Only record a result that actually happened. A repeat of the same entry is treated as
            the same match, not a duplicate.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date played" required type="date" value={date} onChange={setDate} />
            <Field
              label="Opponent"
              required
              value={opponent}
              onChange={setOpponent}
              placeholder="Name they go by"
            />
            <Field
              label="Their rating"
              hint="Optional. Helps rate the result."
              type="number"
              min={0}
              max={4000}
              value={rating}
              onChange={setRating}
              placeholder="e.g. 1450"
            />
            <fieldset className="block">
              <legend className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Result <span className="text-accent">*</span>
              </legend>
              <div className="mt-1 grid grid-cols-2 gap-1 rounded-xl border border-border bg-background/40 p-1">
                {(["Win", "Loss"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setResult(value)}
                    aria-pressed={result === value}
                    className={
                      result === value
                        ? "rounded-lg bg-secondary px-3 py-2 text-xs font-bold text-foreground"
                        : "rounded-lg px-3 py-2 text-xs font-bold text-muted-foreground hover:text-foreground"
                    }
                  >
                    {value}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Match score"
              hint="Optional overall games, e.g. 3-1."
              value={scoreSummary}
              onChange={setScoreSummary}
              placeholder="3-1"
            />
            <Field
              label="Set scores"
              hint="Optional, your score first: 11-9, 9-11, 11-7, 11-8."
              value={setScores}
              onChange={setSetScores}
              placeholder="11-9, 9-11, 11-7, 11-8"
            />
          </div>

          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
              {error}
            </p>
          )}
          {saved?.match_id !== undefined && (
            <div className="space-y-1 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
              <p className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-accent" />
                {saved.created === false
                  ? `Already saved as match #${saved.match_id} — no duplicate was created.`
                  : `Saved as match #${saved.match_id}. Your stats now include it.`}
              </p>
              <p className="pl-5 text-[11px] text-muted-foreground">
                The coach can report it. Open the dashboard to see the updated ledger.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={!canSave}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {saved?.created === false ? "Save again" : "Save result"}
            </Button>
            <Link href="/" className={buttonClassName({ variant: "ghost", size: "sm" })}>
              Back to dashboard
            </Link>
            <Link href="/scoreboard" className={buttonClassName({ variant: "ghost", size: "sm" })}>
              View matches
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

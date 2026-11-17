"use client";

import { CheckCircle2, Loader2, MessageSquare, Phone } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The owner's text number. Stored by the domain service, used by the daily
 * scout and by inbound commands; the dashboard never holds a Twilio secret.
 */
export function SmsCard({ initialPhone }: { initialPhone?: string | null }) {
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy("save");
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/openpong/agent/phone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(body.error || "Could not save that number.");
        return;
      }
      setNote(
        phone.trim() ? "Saved. The scout can text you now." : "Cleared — no texts will be sent.",
      );
    } catch {
      setError("The server did not answer. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/openpong/agent/phone/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        sent?: boolean;
        detail?: string;
      };
      if (!response.ok) {
        setError(body.error || "Could not send a test text.");
        return;
      }
      setNote(
        body.sent
          ? "Sent. Check your phone."
          : body.detail || "Twilio is not configured on the server, so nothing was sent.",
      );
    } catch {
      setError("The server did not answer. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="size-4 text-primary" /> Text alerts
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          The daily scout texts you when a new tournament appears in your area.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Mobile number
          <span className="flex items-center gap-2">
            <Phone className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="tel"
              autoComplete="tel"
              placeholder="+1 512 555 0134"
              className="min-h-10 w-full rounded-xl border border-border bg-card px-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-primary"
            />
          </span>
        </label>
        {error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            {error}
          </p>
        )}
        {note && (
          <p className="flex items-center gap-1.5 text-xs text-accent">
            <CheckCircle2 className="size-3.5" /> {note}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={save} disabled={busy !== null}>
            {busy === "save" && <Loader2 className="size-3.5 animate-spin" />}
            Save number
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={test}
            disabled={busy !== null || !phone.trim()}
          >
            {busy === "test" && <Loader2 className="size-3.5 animate-spin" />}
            Send a test text
          </Button>
          <Badge variant="outline">Signature verified</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Replies are answered by rule — <code>MATCHES</code>, <code>TOURNAMENTS</code>,{" "}
          <code>RATING</code>, <code>SYNC</code>, <code>HELP</code> — never by the model, so a text
          can never spend your credits.
        </p>
      </CardContent>
    </Card>
  );
}

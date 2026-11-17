"use client";

import { Check, Copy, Link2, Loader2, MonitorSmartphone, PlugZap, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { openPong } from "@/lib/api";

interface RelayGate {
  gate_id: string;
  kind: string;
  hint: string;
  url_host: string;
}

interface CompanionStatus {
  configured: boolean;
  reachable: boolean;
  owner: string;
  paired: boolean;
  connected: boolean;
  fingerprint?: string;
  gates: RelayGate[];
  error?: string;
}

interface Pairing {
  owner: string;
  pairingToken: string;
  fingerprint?: string;
  command: string;
  relayUrl: string;
}

/**
 * "Your computer" — the relay companion that drives the person's own,
 * already-logged-in browser so no credential is ever stored. It shows whether
 * a computer is connected, hands out the pairing command to run locally, and
 * surfaces a pending human login/2FA step with a Continue action.
 */
export function CompanionCard({ className }: { className?: string }) {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await openPong<CompanionStatus>("/agent/companion");
      setStatus(data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the companion status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll while the card is open so "connected" reflects a computer that was
    // just paired in another window.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const pair = async () => {
    setBusy("pair");
    setError(null);
    try {
      const result = await openPong<Pairing>("/agent/companion/pairing", { method: "POST" });
      setPairing(result);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start pairing");
    } finally {
      setBusy(null);
    }
  };

  const unpair = async () => {
    setBusy("unpair");
    setError(null);
    try {
      await openPong("/agent/companion", { method: "DELETE" });
      setPairing(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not unpair this computer");
    } finally {
      setBusy(null);
    }
  };

  const clearGate = async (gateId: string) => {
    setBusy(gateId);
    setError(null);
    try {
      await openPong(`/agent/companion/gates/${encodeURIComponent(gateId)}/clear`, {
        method: "POST",
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue");
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy failed — select the command and copy it manually.");
    }
  };

  const connected = Boolean(status?.connected);
  const configured = Boolean(status?.configured);
  const gates = status?.gates ?? [];

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <MonitorSmartphone className="size-4 text-primary" /> Your computer
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Drives your own logged-in browser. No password is ever stored.
          </p>
        </div>
        {loading && !status ? (
          <Badge variant="outline">Checking</Badge>
        ) : connected ? (
          <Badge variant="success">Connected</Badge>
        ) : configured ? (
          <Badge variant="warning">Not connected</Badge>
        ) : (
          <Badge variant="outline">Not configured</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-[11px] text-primary">
            <ShieldAlert className="size-3.5 shrink-0" /> {error}
          </p>
        ) : null}

        {!configured ? (
          <p className="rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
            The relay is not configured on this server yet (RELAY_URL is unset). Registration and
            logged-in scraping stay off until it is.
          </p>
        ) : connected ? (
          <div className="flex items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2.5">
            <PlugZap className="size-4 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">A computer is paired and online</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {status?.fingerprint ? `Pairing ${status.fingerprint}` : "This computer is ready."}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void unpair()}
              disabled={busy === "unpair"}
            >
              {busy === "unpair" ? <Loader2 className="size-3.5 animate-spin" /> : null} Unpair
            </Button>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
            {status?.paired
              ? "A computer is paired but not connected right now. Start the companion on it to reconnect."
              : "No computer is paired yet. Generate a pairing command, then run it on the computer that stays logged in to OmniPong."}
          </p>
        )}

        {configured && !connected ? (
          <Button variant="accent" size="sm" onClick={() => void pair()} disabled={busy === "pair"}>
            {busy === "pair" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Link2 className="size-3.5" />
            )}
            {status?.paired ? "Generate a new pairing command" : "Pair this computer"}
          </Button>
        ) : null}

        {pairing ? (
          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Run this on your computer
            </p>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-background/60 px-3 py-2 text-[11px]">
                {pairing.command}
              </code>
              <Button variant="outline" size="sm" onClick={() => void copy()}>
                {copied ? (
                  <Check className="size-3.5 text-accent" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              The pairing code is shown once. Anyone with it can drive your browser, so keep it
              private; unpair to revoke it.
            </p>
          </div>
        ) : null}

        {gates.length > 0 ? (
          <div className="space-y-2">
            {gates.map((gate) => (
              <div
                key={gate.gate_id}
                className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">
                    {gate.kind === "twofa"
                      ? "Verification code needed"
                      : gate.kind === "captcha"
                        ? "Captcha needed"
                        : gate.kind === "cloudflare"
                          ? "Cloudflare check needed"
                          : "Login needed"}
                  </p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {gate.hint || "Finish it in your browser"}{" "}
                    {gate.url_host ? `· ${gate.url_host}` : ""}
                  </p>
                </div>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={() => void clearGate(gate.gate_id)}
                  disabled={busy === gate.gate_id}
                >
                  {busy === gate.gate_id ? <Loader2 className="size-3.5 animate-spin" /> : null} I
                  handled it, continue
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

"use client";

import { CheckCircle2, KeyRound, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * "Your AI key" — bring your own key, in about a minute.
 *
 * Paste a key from a provider you already pay for and the coach uses it for
 * your turns instead of the server's. Nothing else is installed or configured:
 * no Google Cloud project, no companion, no browser extension. When you have no
 * key saved, the card says plainly that the server's key is in use.
 *
 * The provider names and default models mirror the server's registry
 * (`apps/server/src/engine/model-key.ts`); the key is stored encrypted at rest
 * and is never shown again — only its last 4 characters.
 */

interface Provider {
  id: string;
  label: string;
  defaultModel: string;
}

const PROVIDERS: Provider[] = [
  { id: "openrouter", label: "OpenRouter", defaultModel: "openai/gpt-4o-mini" },
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini" },
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4-5" },
  { id: "google", label: "Google Gemini", defaultModel: "gemini-2.5-flash" },
];

interface KeyView {
  configured?: boolean;
  provider?: string;
  model?: string;
  hint?: string;
}

function providerFor(id: string | undefined): Provider {
  return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[0];
}

export function AiKeyCard({ bare }: { bare?: boolean } = {}) {
  const [view, setView] = useState<KeyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<Provider>(PROVIDERS[0]);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(PROVIDERS[0].defaultModel);
  const [busy, setBusy] = useState<"save" | "remove" | "test" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/openpong/agent/model-key", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as KeyView;
      setView(response.ok ? body : { configured: false });
      if (body.configured) {
        const found = providerFor(body.provider);
        setProvider(found);
        setModel(body.model || found.defaultModel);
      }
    } catch {
      setView({ configured: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function chooseProvider(id: string) {
    const found = providerFor(id);
    setProvider(found);
    setModel(found.defaultModel);
    setNote(null);
  }

  async function save() {
    setBusy("save");
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/openpong/agent/model-key", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id, apiKey, model }),
      });
      const body = (await response.json().catch(() => ({}))) as KeyView & { error?: string };
      if (!response.ok) {
        setError(body.error || "That key was not saved.");
        return;
      }
      setView(body);
      setApiKey("");
      setNote("Saved. The coach uses your key now — nothing else to install.");
    } catch {
      setError("The server did not answer. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setError(null);
    setNote(null);
    try {
      const response = await fetch("/api/openpong/agent/model-key", { method: "DELETE" });
      if (!response.ok) {
        setError("The key could not be removed. Try again.");
        return;
      }
      setView({ configured: false });
      setApiKey("");
      setNote("Removed. The server's key applies again.");
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
      const response = await fetch("/api/openpong/agent/model-key/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          apiKey.trim()
            ? { provider: provider.id, apiKey, model }
            : view?.configured
              ? {}
              : { provider: provider.id, model },
        ),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok) {
        setError(body.error || "The key could not be tested.");
        return;
      }
      setNote(
        body.ok ? "That key works." : `That key did not work: ${body.error ?? "unknown error"}`,
      );
    } catch {
      setError("The server did not answer. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const canTest = Boolean(apiKey.trim()) || Boolean(view?.configured);

  const body = (
    <>
      {loading ? (
        <p className="text-xs text-muted-foreground">Checking…</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {view?.configured
              ? `Using your own key — ${providerFor(view.provider).label}, ${view.model}, ending ${view.hint ?? "••••"}.`
              : "Using the server's key. Paste your own key below to use it instead."}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Provider
              </span>
              <select
                aria-label="Provider"
                value={provider.id}
                onChange={(event) => chooseProvider(event.target.value)}
                className="mt-1 flex h-10 w-full rounded-xl border border-input bg-background/60 px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                {PROVIDERS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                Model
              </span>
              <input
                aria-label="Model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={provider.defaultModel}
                className="mt-1 flex h-10 w-full rounded-xl border border-input bg-background/60 px-3.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/70"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              API key
            </span>
            <input
              aria-label="API key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={view?.configured ? "Paste a new key to replace it" : "Paste your key"}
              className="mt-1 flex h-10 w-full rounded-xl border border-input bg-background/60 px-3.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/70"
            />
          </label>

          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
              {error}
            </p>
          )}
          {note && (
            <p className="flex items-start gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-accent" /> {note}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={save} disabled={busy !== null || !apiKey.trim()}>
              {busy === "save" && <Loader2 className="size-3.5 animate-spin" />}
              Save key
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={test}
              disabled={busy !== null || !canTest}
            >
              {busy === "test" && <Loader2 className="size-3.5 animate-spin" />}
              Test
            </Button>
            {view?.configured && (
              <Button size="sm" variant="ghost" onClick={remove} disabled={busy !== null}>
                {busy === "remove" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Remove
              </Button>
            )}
          </div>

          <p className="text-[11px] leading-snug text-muted-foreground">
            Works with OpenRouter, OpenAI, Anthropic and Google Gemini. Your key is stored encrypted
            and is never shown again — only its last 4 characters. Remove it any time to go back to
            the server's key.
          </p>
        </>
      )}
    </>
  );

  if (bare) return <div className="space-y-3">{body}</div>;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-accent" /> Your AI key
          </CardTitle>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Paste a key from a provider you already use and the coach runs on your key instead of
            the server's. It takes about a minute and nothing else needs installing.
          </p>
        </div>
        <Badge variant={view?.configured ? "success" : "outline"}>
          {view?.configured ? "Your key" : "Server key"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">{body}</CardContent>
    </Card>
  );
}

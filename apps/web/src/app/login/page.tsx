"use client";

import { Loader2, Trophy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { buttonClassName } from "@/components/ui/button";

type Mode = "login" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [singleUser, setSingleUser] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { accounts?: boolean }) => setSingleUser(body.accounts === false))
      .catch(() => setSingleUser(false));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, displayName }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(body.error || "That did not work. Check the details and try again.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("The server did not answer. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 py-6 sm:py-12">
      <div className="flex flex-col items-start gap-2">
        <span className="grid size-11 place-items-center rounded-2xl border border-border bg-card">
          <Trophy className="size-5 text-primary" />
        </span>
        <h1 className="text-2xl font-black tracking-tight">
          {mode === "login" ? "Welcome back." : "Make your Pong."}
        </h1>
        <p className="text-sm text-muted-foreground">
          {mode === "login"
            ? "Your rating, matches, tournaments and coach are behind this door."
            : "One account keeps your ledger, your area and your calendar in sync on every device."}
        </p>
      </div>

      {singleUser === true && (
        <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-xs leading-relaxed">
          <p className="font-semibold">This install runs as a single owner.</p>
          <p className="mt-1 text-muted-foreground">
            There is no login on a self-hosted copy. Start the server with{" "}
            <code>MULTI_TENANT=true</code> to host accounts, or{" "}
            <Link href="/" className="font-semibold underline">
              go straight to your dashboard
            </Link>
            .
          </p>
        </div>
      )}

      {singleUser !== true && (
        <>
          <div className="flex rounded-xl border border-border bg-secondary/40 p-1 text-xs font-semibold">
            {(["login", "signup"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setMode(option);
                  setError(null);
                }}
                className={
                  mode === option
                    ? "flex-1 rounded-lg bg-card px-3 py-2 text-foreground shadow-sm"
                    : "flex-1 rounded-lg px-3 py-2 text-muted-foreground"
                }
                aria-pressed={mode === option}
              >
                {option === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === "signup" && (
              <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Your name
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  placeholder="How the coach should greet you"
                  className="min-h-11 rounded-xl border border-border bg-card px-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-primary"
                />
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                className="min-h-11 rounded-xl border border-border bg-card px-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Password
              <input
                type="password"
                required
                minLength={10}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder={mode === "signup" ? "At least 10 characters" : "Your password"}
                className="min-h-11 rounded-xl border border-border bg-card px-3 text-sm font-normal normal-case tracking-normal text-foreground outline-none focus:border-primary"
              />
            </label>

            {error && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className={buttonClassName({ variant: "accent", size: "default" })}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {mode === "login" ? "Sign in" : "Create my account"}
            </button>
          </form>
        </>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Your password is stored as a scrypt hash, never in plain text. Sessions live on the server
        and end when you sign out.{" "}
        <Link href="/settings" className="underline">
          Settings
        </Link>{" "}
        stays open on a self-hosted single-user install.
      </p>
    </div>
  );
}

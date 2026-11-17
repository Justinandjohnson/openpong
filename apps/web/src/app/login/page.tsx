"use client";

import { Loader2, Trophy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { buttonClassName } from "@/components/ui/button";

type Mode = "login" | "signup";

/** The Google "G", drawn inline so the dashboard needs no new dependency. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.26-2.09 3.55-5.17 3.55-8.87Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.28v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.28a12 12 0 0 0 0 10.74l3.99-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.43-3.43C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.63l3.99 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [singleUser, setSingleUser] = useState<boolean | null>(null);
  const [googleReady, setGoogleReady] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { accounts?: boolean; google?: boolean }) => {
        setSingleUser(body.accounts === false);
        setGoogleReady(Boolean(body.google));
      })
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

      {singleUser !== true && googleReady && (
        <>
          <a
            href="/api/auth/google/start"
            className={buttonClassName({ variant: "outline", size: "default" })}
          >
            <GoogleMark />
            Continue with Google
          </a>

          <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>

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

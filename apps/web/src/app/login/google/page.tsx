"use client";

import { Loader2, Trophy } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Landing spot for the Google callback. The server handed this page a short-lived
 * single-use code in the query string; the BFF swaps it for the bearer, which is
 * sealed into the httpOnly cookie and never returned here.
 */
function GoogleSignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = params.get("code");
    if (!code) {
      setError("This sign-in link is missing its code. Start again.");
      return;
    }
    fetch("/api/auth/google/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setError(body.error || "Could not complete Google sign-in.");
          return;
        }
        router.replace("/");
        router.refresh();
      })
      .catch(() => setError("The server did not answer. Try again in a moment."));
  }, [params, router]);

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 pt-5 text-center">
        {error ? (
          <>
            <span className="grid size-11 place-items-center rounded-2xl border border-border bg-card">
              <Trophy className="size-5 text-primary" />
            </span>
            <p className="text-sm font-semibold">We couldn&apos;t sign you in.</p>
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
              {error}
            </p>
            <Link href="/login" className="text-xs font-bold text-accent underline">
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-sm font-semibold">Signing you in…</p>
            <p className="text-[11px] text-muted-foreground">
              Finishing the hand-off with Google. This only takes a moment.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function GoogleSignInPage() {
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 py-6 sm:py-12">
      <Suspense
        fallback={
          <Card>
            <CardContent className="flex items-center gap-3 pt-5">
              <Loader2 className="size-5 animate-spin text-primary" />
              <p className="text-sm font-semibold">Signing you in…</p>
            </CardContent>
          </Card>
        }
      >
        <GoogleSignIn />
      </Suspense>
    </div>
  );
}

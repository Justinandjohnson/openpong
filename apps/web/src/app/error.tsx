"use client";

import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/button";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-10">
      <span className="grid size-11 place-items-center rounded-2xl border border-destructive/40 bg-destructive/10">
        <span className="pong-ball size-3 rounded-full bg-destructive" />
      </span>
      <h1 className="text-2xl font-black tracking-tight">That screen hit a snag</h1>
      <p className="text-sm text-muted-foreground">
        Nothing was lost — your ledger and calendar live on the server. Try the screen again, or go
        back to the dashboard.
      </p>
      {error.digest && (
        <p className="font-mono text-[10px] text-muted-foreground/70">ref {error.digest}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className={buttonClassName({ variant: "accent", size: "default" })}
        >
          <RotateCcw className="size-4" /> Try again
        </button>
        <Link href="/" className={buttonClassName({ variant: "outline", size: "default" })}>
          Dashboard
        </Link>
      </div>
    </div>
  );
}

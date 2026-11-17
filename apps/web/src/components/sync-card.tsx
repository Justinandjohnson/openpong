"use client";

import { CheckCircle2, CloudOff, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Phase = "idle" | "starting" | "running" | "done" | "error";

interface SyncTask {
  id?: string;
  status?: string;
  result?: { summary?: string; detail?: string; message?: string } | string | null;
  error?: string | null;
}

const DONE_STATES = new Set(["succeeded", "failed", "cancelled"]);
const SUMMARY = /(\d+)[^\d]{0,12}(?:match|result)/i;

function describe(task: SyncTask | null): string | null {
  if (!task) return null;
  const result = task.result;
  if (typeof result === "string") return result;
  const text = result?.summary || result?.detail || result?.message;
  if (typeof text === "string" && text.trim()) return text.trim();
  if (task.error) return task.error;
  return null;
}

/**
 * The one-tap sync. Any owner can press it: it asks the server for a durable
 * league sync, then watches that task until it settles. Nothing here knows which
 * league, which player or which site — that comes from the saved profile.
 */
export function SyncCard({ className }: { className?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [needsProfile, setNeedsProfile] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const poll = useCallback(async (id: string, attempt = 0, misses = 0) => {
    try {
      const response = await fetch(`/api/openpong/agent/tasks/${id}`, { cache: "no-store" });
      if (!response.ok) {
        if (response.status >= 500 && misses < 5) {
          timer.current = setTimeout(() => void poll(id, attempt + 1, misses + 1), 3000);
          return;
        }
        throw new Error("The server lost track of that sync");
      }
      const task = (await response.json()) as SyncTask;
      if (task.status && DONE_STATES.has(task.status)) {
        if (task.status === "succeeded") {
          const detail = describe(task);
          const count = detail?.match(SUMMARY)?.[1];
          setMessage(
            count
              ? `Synced ${count} match${count === "1" ? "" : "es"} from your league.`
              : (detail ?? "League synced."),
          );
          setLastSync(
            new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
          );
          setPhase("done");
        } else {
          setMessage(describe(task) ?? "That sync did not finish.");
          setPhase("error");
        }
        return;
      }
      if (attempt > 150) {
        setMessage("Still syncing in the background — check Activity in a minute.");
        setPhase("running");
        return;
      }
      timer.current = setTimeout(() => void poll(id, attempt + 1), 2000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sync status unavailable");
      setPhase("error");
    }
  }, []);

  const start = async () => {
    setPhase("starting");
    setMessage(null);
    setNeedsProfile(false);
    try {
      const response = await fetch("/api/sync", { method: "POST", body: "{}" });
      const data = (await response.json()) as { taskId?: string; status?: string; error?: string };
      if (!response.ok) {
        if (response.status === 400 && /league|profile/i.test(data.error ?? ""))
          setNeedsProfile(true);
        throw new Error(data.error ?? "Sync could not start");
      }
      if (!data.taskId) throw new Error("The server did not return a sync task");
      setTaskId(data.taskId);
      setPhase("running");
      void poll(data.taskId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sync could not start");
      setPhase("error");
    }
  };

  const busy = phase === "starting" || phase === "running";

  return (
    <div
      className={cn(
        "flex flex-col justify-between rounded-2xl border border-accent/25 bg-accent/[0.06] p-3.5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-accent">
            Your league
          </p>
          <p className="mt-1 text-sm font-bold leading-tight">
            {phase === "done" ? "Up to date" : busy ? "Syncing…" : "Sync results"}
          </p>
        </div>
        {phase === "done" ? (
          <CheckCircle2 className="size-5 text-accent" />
        ) : busy ? (
          <Loader2 className="size-5 animate-spin text-accent" />
        ) : (
          <RefreshCw className="size-5 text-accent/70" />
        )}
      </div>

      <p className="mt-1.5 min-h-5 text-[11px] leading-relaxed text-muted-foreground">
        {message ??
          (lastSync ? `Last synced at ${lastSync}.` : "Pull every match from your saved league.")}
      </p>

      {needsProfile ? (
        <Link
          href="/settings/profile"
          className="mt-1 text-[11px] font-bold text-accent underline underline-offset-2"
        >
          Add your league URL in Settings
        </Link>
      ) : null}

      <Button
        variant="accent"
        size="sm"
        className="mt-2 w-full"
        onClick={() => void start()}
        disabled={busy}
        aria-busy={busy}
        data-task={taskId ?? undefined}
      >
        {busy ? (
          <>
            <Loader2 className="size-3.5 animate-spin" /> Syncing…
          </>
        ) : (
          <>
            <RefreshCw className="size-3.5" /> {phase === "done" ? "Sync again" : "Sync now"}
          </>
        )}
      </Button>

      {phase === "error" ? (
        <p className="mt-2 flex items-center gap-1 text-[10px] text-primary">
          <CloudOff className="size-3" /> Kept your last known results.
        </p>
      ) : null}
    </div>
  );
}

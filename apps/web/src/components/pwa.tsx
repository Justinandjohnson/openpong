"use client";

import { Download, Share2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type InstallState, promptInstall, subscribeInstall } from "@/lib/install";

const DISMISSED = "openpong.install.dismissed";

/** Registers the offline shell. Kept in one place so it runs on every route. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    const timer = window.setTimeout(() => {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}

function useInstall(): InstallState | null {
  const [state, setState] = useState<InstallState | null>(null);
  useEffect(() => subscribeInstall(setState), []);
  return state;
}

/**
 * The one-tap install button. Renders nothing when there is nothing to offer,
 * so it can be dropped into a header, a wizard step or a banner safely.
 */
export function InstallButton({
  className,
  label = "Install app",
  size = "sm",
}: {
  className?: string;
  label?: string;
  size?: "sm" | "lg";
}) {
  const state = useInstall();
  if (!state || !state.installable) return null;

  if (state.ios && !state.canPrompt) {
    return (
      <a
        href="/setup"
        className={
          className ??
          "flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground"
        }
      >
        <Share2 className="size-3.5" /> Add to Home Screen
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void promptInstall()}
      className={
        className ??
        (size === "lg"
          ? "flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground"
          : "flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-bold text-primary-foreground")
      }
    >
      <Download className={size === "lg" ? "size-4" : "size-3.5"} /> {label}
    </button>
  );
}

/**
 * A dismissible banner for phones. It exists so the install step is visible
 * without hunting through a browser menu — the wizard carries the full steps.
 */
export function InstallPrompt() {
  const state = useInstall();
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (window.localStorage.getItem(DISMISSED)) return;
    setHidden(false);
  }, []);

  if (hidden || !state?.installable) return null;

  function dismiss() {
    window.localStorage.setItem(DISMISSED, "1");
    setHidden(true);
  }

  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-accent/30 bg-card px-3 py-2.5 md:hidden">
      <span className="grid size-8 place-items-center rounded-lg bg-accent/15">
        <span className="pong-ball size-2.5 rounded-full" />
      </span>
      <p className="min-w-0 flex-1 text-[11px] leading-tight">
        <span className="font-semibold">Install OpenPong</span> — full screen, offline shell, one
        tap from your home screen.{" "}
        <a href="/setup" className="font-bold text-accent underline">
          Set up
        </a>
      </p>
      <InstallButton label="Install" />
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

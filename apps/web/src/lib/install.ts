"use client";

/**
 * One place that knows whether OpenPong can be installed, on this device.
 *
 * Browsers only fire `beforeinstallprompt` when the app genuinely qualifies
 * (manifest + service worker + https or localhost), and iOS never fires it at
 * all, so the UI needs to distinguish "installable, one tap" from "add to home
 * screen by hand" from "already installed".
 */

interface InstallEventLike extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallState {
  /** The browser offered a native install prompt we can replay on a click. */
  canPrompt: boolean;
  /** Running as an installed app already. */
  installed: boolean;
  /** iOS/iPadOS: no prompt exists; the user must use Share → Add to Home Screen. */
  ios: boolean;
  /** Installable at all (prompt available, or iOS where it is always manual). */
  installable: boolean;
}

type Listener = (state: InstallState) => void;

let deferred: InstallEventLike | null = null;
let started = false;
const listeners = new Set<Listener>();

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
  const media = window.matchMedia?.("(display-mode: standalone)");
  return media?.matches === true || navigatorWithStandalone.standalone === true;
}

function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function snapshot(): InstallState {
  const installed = isStandalone();
  const ios = isIosDevice();
  return {
    canPrompt: Boolean(deferred) && !installed,
    installed,
    ios,
    installable: !installed && (Boolean(deferred) || ios),
  };
}

function emit(): void {
  const state = snapshot();
  for (const listener of listeners) listener(state);
}

export function startInstallTracking(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallEventLike;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    emit();
  });
}

export function subscribeInstall(listener: Listener): () => void {
  startInstallTracking();
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}

/** Replays the native prompt. Returns what the person chose, or "unavailable". */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  const event = deferred;
  await event.prompt();
  const choice = await event.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  if (choice.outcome === "accepted") deferred = null;
  emit();
  return choice.outcome;
}

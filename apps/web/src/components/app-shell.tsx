"use client";

import {
  Activity as ActivityIcon,
  BarChart3,
  Bot,
  CalendarDays,
  CircleDot,
  LayoutDashboard,
  Menu,
  PlusCircle,
  Rocket,
  Search,
  Settings,
  Sparkles,
  Swords,
  Trophy,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { InstallButton, InstallPrompt, ServiceWorkerRegistration } from "@/components/pwa";
import { buttonClassName } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { type AgentSnapshot, useOpenPong } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/setup", label: "Get set up", icon: Rocket },
  { href: "/tournaments", label: "Tournaments", icon: Trophy },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/scoreboard", label: "Matches", icon: Swords },
  { href: "/matches/new", label: "Log a match", icon: PlusCircle },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/lookup", label: "Player lookup", icon: Search },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
  { href: "/chat", label: "Coach", icon: Bot },
] as const;

const MOBILE_NAV = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/tournaments", label: "Events", icon: Trophy },
  { href: "/scoreboard", label: "Matches", icon: Swords },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
  { href: "/chat", label: "Coach", icon: Bot },
] as const;

const TITLES: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "Dashboard", subtitle: "Your table tennis, managed." },
  "/setup": { title: "Get set up", subtitle: "Five steps and it runs itself." },
  "/tournaments": { title: "Tournaments", subtitle: "Your area calendar, mapped." },
  "/scoreboard": { title: "Matches", subtitle: "Every result, one ledger." },
  "/matches/new": { title: "Log a match", subtitle: "A result you played, saved to your ledger." },
  "/analytics": { title: "Analytics", subtitle: "Rating trend and match patterns." },
  "/lookup": { title: "Player lookup", subtitle: "USATT ratings from the local corpus." },
  "/activity": { title: "Activity", subtitle: "Approvals, tasks, watches and alerts." },
  "/calendar": { title: "Calendar", subtitle: "Matches and tournaments in one Pong calendar." },
  "/chat": { title: "Coach", subtitle: "One agent for the whole workspace." },
  "/settings": { title: "Settings", subtitle: "Profile, area and connections." },
  "/settings/profile": { title: "Your profile", subtitle: "Who you are and where you play." },
  "/login": { title: "Sign in", subtitle: "Your ledger, your area, your coach." },
};

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="group flex items-center gap-2.5">
      <span className="relative grid size-9 place-items-center rounded-xl border border-border bg-card">
        <span className="pong-ball size-3.5 rounded-full" />
        <span className="absolute inset-x-1.5 bottom-1.5 h-px bg-border" />
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-lg font-black tracking-tight text-foreground">
          Open<span className="text-primary">Pong</span>
        </span>
        {!compact && (
          <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Table tennis manager
          </span>
        )}
      </span>
    </Link>
  );
}

function NavLinks({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary/12 text-foreground ring-1 ring-primary/25"
                : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
            )}
          >
            <Icon
              className={cn(
                "size-4",
                active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
              )}
            />
            {label}
            {active && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
          </Link>
        );
      })}
    </nav>
  );
}

function AgentStatus() {
  const { data } = useOpenPong<AgentSnapshot>("/agent", { refreshMs: 60_000 });
  const running = Boolean(data?.worker?.running);
  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        <span
          className={cn(
            "size-1.5 rounded-full",
            running ? "bg-accent animate-pong-pulse" : "bg-muted-foreground/50",
          )}
        />
        Agent {running ? "running" : "idle"}
      </div>
      <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
        {data?.identity?.name
          ? `${data.identity.name} is wired to the same runtime as this dashboard.`
          : "Connecting to the OpenPong runtime…"}
      </p>
    </div>
  );
}

// The dashboard is usable before onboarding (it falls back to the local corpus),
// but a brand new person should be pointed at the one form that makes the agent
// theirs. The check is silent: a failed fetch just means no banner.
function useNeedsSetup(): boolean {
  const [needs, setNeeds] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/profile", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { onboarded?: boolean } | null) => {
        if (alive && body && body.onboarded === false) setNeeds(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return needs;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);
  const needsSetup = useNeedsSetup();
  const meta = TITLES[pathname] ?? TITLES["/"];

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-border bg-sidebar/95 px-4 py-5 backdrop-blur md:flex">
        <div className="px-1">
          <Wordmark />
        </div>
        <div className="mt-7 flex-1">
          <NavLinks pathname={pathname} />
        </div>
        <div className="space-y-3">
          <AgentStatus />
          <Link
            href="/settings"
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2 text-xs font-medium transition-colors",
              pathname.startsWith("/settings")
                ? "bg-primary/12 text-foreground ring-1 ring-primary/25"
                : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
            )}
          >
            <Settings className="size-4" /> Settings
          </Link>
        </div>
      </aside>

      <Sheet open={open} onOpenChange={setOpen}>
        <div className="flex h-full flex-col p-5">
          <Wordmark />
          <div className="mt-7 flex-1">
            <NavLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            <div className="mt-5 border-t border-border pt-4">
              <Link
                href="/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Settings className="size-4" /> Settings
              </Link>
            </div>
          </div>
          <AgentStatus />
        </div>
      </Sheet>

      <div className="min-w-0 flex-1 md:pl-60">
        <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
          <div className="flex h-16 items-center gap-3 px-4 pt-[env(safe-area-inset-top)] sm:px-6 [@media(max-height:820px)]:h-14">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="grid size-10 place-items-center rounded-xl border border-border text-muted-foreground md:hidden"
              aria-label="Open menu"
            >
              <Menu className="size-5" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-bold tracking-tight">{meta.title}</h1>
              <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
                {meta.subtitle}
              </p>
            </div>
            <div className="hidden items-center gap-1.5 rounded-full border border-border bg-card/70 px-3 py-1.5 sm:flex">
              <span className={cn("size-1.5 rounded-full", "bg-accent animate-pong-pulse")} />
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                Live runtime
              </span>
            </div>
            <InstallButton
              className="hidden shrink-0 items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-[11px] font-bold text-accent sm:flex"
              label="Install app"
            />
            {pathname === "/chat" ? null : (
              <Link
                href="/chat"
                className={buttonClassName({ variant: "accent", size: "default" })}
              >
                <Sparkles className="size-4" />
                <span className="hidden sm:inline">Ask coach</span>
              </Link>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1500px] px-4 py-2 sm:px-6 lg:px-8 [@media(max-height:820px)]:py-0.5">
          {needsSetup && pathname !== "/settings/profile" && pathname !== "/setup" && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3">
              <Sparkles className="size-4 shrink-0 text-accent" />
              <p className="min-w-0 flex-1 text-xs">
                <span className="font-semibold">Finish setting up.</span> Name, area, league and
                calendar — five steps so the coach works on your data, not someone else&apos;s.
              </p>
              <Link href="/setup" className={buttonClassName({ variant: "accent", size: "sm" })}>
                Get set up
              </Link>
            </div>
          )}
          <InstallPrompt />
          {children}
        </main>
        <footer className="mx-auto hidden w-full max-w-[1500px] md:flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-1 text-[10px] [@media(max-height:820px)]:pb-0.5 [@media(max-height:820px)]:pt-0.5 uppercase tracking-[0.15em] text-muted-foreground/70 sm:px-6 md:pb-2 lg:px-8">
          <span className="flex items-center gap-1.5">
            <CircleDot className="size-3 text-primary" /> OpenPong · dashboard + agent
          </span>
          <span className="truncate">OmniPong data · OpenPong agent</span>
        </footer>
      </div>

      {/* Thumb-first navigation: the five things a player opens the app for. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
        aria-label="Primary"
      >
        <div className="mx-auto grid max-w-lg grid-cols-5">
          {MOBILE_NAV.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[10px] font-semibold transition-colors",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "grid size-8 place-items-center rounded-xl transition-colors",
                    active && "bg-primary/15",
                  )}
                >
                  <Icon className="size-4" />
                </span>
                {label}
              </Link>
            );
          })}
        </div>
      </nav>

      <ServiceWorkerRegistration />
    </div>
  );
}

"use client";

import {
  Bot,
  CheckCircle2,
  CircleDot,
  Database,
  Globe,
  KeyRound,
  Server,
  Shield,
  Sparkles,
  User,
} from "lucide-react";
import Link from "next/link";
import { AccountCard } from "@/components/account-card";
import { SmsCard } from "@/components/sms-card";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { type AgentSnapshot, type UserProfile, useOpenPong } from "@/lib/api";

interface Health {
  ok?: boolean;
  server?: { ok?: boolean; mode?: string; agentConfigured?: boolean; browserConfigured?: boolean };
  serverUrl?: string;
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 rounded-lg border border-border bg-background/50 px-3 py-2 text-sm">
        {value ?? <span className="text-muted-foreground">Not set</span>}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const user = useOpenPong<UserProfile>("/user");
  const agent = useOpenPong<AgentSnapshot>("/agent");
  const health = useOpenPong<Health>("/health");
  const agentName = agent.data?.identity?.name || "OpenPong";
  const mode = health.data?.server?.mode;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <AccountCard />
      </div>
      <SmsCard initialPhone={user.data?.phone_number ?? ""} />
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <User className="size-4 text-primary" /> Player profile
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Read from the domain service; never a hard-coded name.
            </p>
          </div>
          <Badge variant="outline">Identity</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          {user.loading && !user.data ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <Field label="Full name" value={user.data?.full_name} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="USATT number" value={user.data?.usatt_number} />
                <Field label="Current rating" value={user.data?.rating} />
              </div>
              <Link
                href="/settings/profile"
                className={buttonClassName({ variant: "secondary", size: "sm" })}
              >
                <Sparkles className="size-3.5 text-accent" /> Edit my profile
              </Link>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bot className="size-4 text-accent" /> Agent & area
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              The same runtime this dashboard and the native app share.
            </p>
          </div>
          <Badge variant="accent">{mode ? `${mode} mode` : "runtime"}</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Agent identity" value={agentName} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Open tasks" value={(agent.data?.tasks ?? []).length} />
            <Field label="Watches" value={(agent.data?.monitors ?? []).length} />
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
            <span
              className={`size-1.5 rounded-full ${agent.data?.worker?.running ? "bg-accent animate-pong-pulse" : "bg-muted-foreground/50"}`}
            />
            Worker {agent.data?.worker?.running ? "running" : "idle"}
            {agent.data?.worker?.lastTickAt && (
              <span className="ml-auto font-mono text-[10px]">
                {new Date(agent.data.worker.lastTickAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          <Link
            href="/settings/profile"
            className={buttonClassName({ variant: "secondary", size: "sm" })}
          >
            <Globe className="size-3.5 text-accent" /> Change my area
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="size-4 text-primary" /> Connections
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Server-side only; the browser holds no service secrets.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {[
            {
              icon: Server,
              label: "OpenPong agent runtime",
              value: health.data?.ok ? "Connected" : "Unreachable",
              ok: Boolean(health.data?.ok),
            },
            {
              icon: Database,
              label: "OmniPong domain data",
              value: user.data ? "Connected" : user.error ? "Unreachable" : "Checking",
              ok: Boolean(user.data),
            },
            {
              icon: Bot,
              label: "Model configured",
              value: health.data?.server?.agentConfigured ? "Yes" : "No",
              ok: Boolean(health.data?.server?.agentConfigured),
            },
            {
              icon: Shield,
              label: "Browser (built in)",
              value: health.data?.server?.browserConfigured ? "Ready" : "Unavailable",
              ok: Boolean(health.data?.server?.browserConfigured),
            },
          ].map(({ icon: Icon, label, value, ok }) => (
            <div
              key={label}
              className="flex items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2.5"
            >
              <Icon className="size-4 text-muted-foreground" />
              <span className="flex-1 text-xs font-medium">{label}</span>
              <span
                className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider ${ok ? "text-accent" : "text-muted-foreground"}`}
              >
                {ok ? <CheckCircle2 className="size-3" /> : <CircleDot className="size-3" />}{" "}
                {value}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>


      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-accent" /> Trust model
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            OpenPong never stores third-party credentials.
          </p>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-muted-foreground">
          <p>
            Your session bearer is minted by the OpenPong server and kept behind an httpOnly cookie
            plus a server-side proxy. Dashboard data and chat both use it; JavaScript in the browser
            never sees it.
          </p>
          <p>
            The browser is built into the app. The coach reads and acts on public pages in its own
            window, and you take over that same window whenever a page needs your login, 2FA or a
            captcha. Nothing is installed on your machine and no site password is ever stored.
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="success">No passwords stored</Badge>
            <Badge variant="success">Approvals in-app</Badge>
            <Badge variant="success">Per-user scoped</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

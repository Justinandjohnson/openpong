"use client";

import { Loader2, LogOut, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Account {
  email?: string;
  displayName?: string;
}

/**
 * Accounts are optional: a self-hosted single-user install never sees this
 * anything but "Single-user install", while a hosted multi-tenant deployment
 * shows the signed-in person and a way out.
 */
export function AccountCard() {
  const [account, setAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { account?: Account | null; accounts?: boolean }) => {
        setAccount(body.account ?? null);
        setAccounts(Boolean(body.accounts) || Boolean(body.account));
      })
      .catch(() => setAccounts(false));
  }, []);

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/login";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="size-4 text-primary" /> Your account
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          One identity scopes every match, task, thread and connector.
        </p>
      </CardHeader>
      <CardContent>
        {accounts === null ? (
          <p className="text-xs text-muted-foreground">Checking…</p>
        ) : account ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {account.displayName || account.email || "Signed in"}
              </p>
              {account.email && (
                <p className="truncate text-[11px] text-muted-foreground">{account.email}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="success">Signed in</Badge>
              <Button variant="ghost" size="sm" onClick={signOut} disabled={busy}>
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <LogOut className="size-3.5" />
                )}
                Sign out
              </Button>
            </div>
          </div>
        ) : accounts ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">You are not signed in on this device.</p>
            <Link href="/login" className="text-xs font-bold text-accent underline">
              Sign in
            </Link>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Single-user install — no login required. Set <code>MULTI_TENANT=true</code> to host
              accounts.
            </p>
            <Badge variant="outline">Local owner</Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

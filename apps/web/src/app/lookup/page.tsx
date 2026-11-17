"use client";

import { Loader2, Search, Sparkles, User, UserSearch } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { type PlayerHit, postOpenPong } from "@/lib/api";

type Result =
  | { status: "success"; players: PlayerHit[] }
  | { status: "not_found"; message?: string }
  | { error?: string };

export default function LookupPage() {
  const [name, setName] = useState("");
  const [players, setPlayers] = useState<PlayerHit[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    const query = name.trim();
    if (!query) return;
    setLoading(true);
    setMessage(null);
    try {
      const result = await postOpenPong<Result>("/tools/search/players", { name: query });
      if ("players" in result && result.status === "success") {
        setPlayers(result.players);
        if (result.players.length === 0) setMessage(`No player found for “${query}”.`);
      } else if ("status" in result && result.status === "not_found") {
        setPlayers([]);
        setMessage(result.message || `No player found for “${query}”.`);
      } else {
        setPlayers([]);
        setMessage(("error" in result && result.error) || "Lookup failed.");
      }
    } catch (cause) {
      setPlayers([]);
      setMessage(cause instanceof Error ? cause.message : "Lookup failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="max-w-2xl">
        <Badge variant="accent">
          <UserSearch className="size-2.5" /> Local USATT corpus
        </Badge>
        <p className="mt-2 text-sm text-muted-foreground">
          Search the players already synced by your OmniPong service — no USATT login, no stored
          credentials. For a live lookup of someone new, ask the coach.
        </p>
      </section>

      <Card className="max-w-2xl">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && search()}
              placeholder="Player name or USATT id…"
              className="pl-9"
            />
          </div>
          <Button onClick={search} disabled={loading || !name.trim()} variant="accent">
            {loading ? <Loader2 className="animate-spin" /> : <Search />} Search
          </Button>
        </CardContent>
      </Card>

      {message && (
        <div className="max-w-2xl rounded-xl border border-border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
          {message}
        </div>
      )}

      {players && players.length > 0 && (
        <Card className="max-w-3xl overflow-hidden p-0">
          <CardHeader className="border-b border-border">
            <CardTitle>
              {players.length} player{players.length === 1 ? "" : "s"} found
            </CardTitle>
          </CardHeader>
          <div className="divide-y divide-border/60">
            {players.map((player) => (
              <div
                key={`${player.usatt_id}-${player.name}`}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <span className="grid size-9 place-items-center rounded-xl border border-border bg-secondary text-muted-foreground">
                  <User className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{player.name}</p>
                  <p className="text-[10px] font-mono text-muted-foreground">
                    USATT {player.usatt_id ?? "—"} {player.state ? `· ${player.state}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-black tabular-nums">{player.rating ?? "—"}</p>
                  <p className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                    Rating
                  </p>
                </div>
                <Link
                  href={`/chat?prompt=${encodeURIComponent(`Scout ${player.name} for me and tell me how my game matches up.`)}`}
                  className={buttonClassName({ variant: "secondary", size: "sm" })}
                >
                  <Sparkles className="size-3.5 text-accent" /> Scout
                </Link>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

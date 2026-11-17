"use client";

import {
  CalendarDays,
  List,
  Loader2,
  Map,
  RefreshCw,
  Search,
  Sparkles,
  Trophy,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { TournamentCalendar } from "@/components/tournament-calendar";
import { TournamentCard } from "@/components/tournament-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { postOpenPong, type Tournament, useOpenPong } from "@/lib/api";

const TournamentMap = dynamic(() => import("@/components/tournament-map"), {
  ssr: false,
  loading: () => (
    <div className="grid h-[520px] place-items-center rounded-xl border border-border bg-card text-xs text-muted-foreground">
      Loading map…
    </div>
  ),
});

export default function TournamentsPage() {
  const [region, setRegion] = useState<"local" | "all">("local");
  const [search, setSearch] = useState("");
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { data, loading, error, refresh } = useOpenPong<Tournament[]>(
    `/tournaments?region=${region}`,
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return data ?? [];
    return (data ?? []).filter((tournament) =>
      `${tournament.title ?? ""} ${tournament.city_state ?? ""} ${tournament.location ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [data, search]);

  const checkFeed = async () => {
    setChecking(true);
    setNotice(null);
    try {
      await postOpenPong("/agent/action", { action: "check", params: { dry_run: true } });
      refresh();
      setNotice("Checked the OmniPong feed. New area tournaments appear here.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The feed check failed.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Badge variant="primary">
              <Trophy className="size-2.5" /> OmniPong feed
            </Badge>
            <Badge variant="outline">{data?.length ?? 0} events</Badge>
          </div>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            The same tournament list the coach uses. Filter to the area configured by your domain
            service, or browse every synced event.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={checkFeed} disabled={checking}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check feed
          </Button>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>
      </section>

      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-accent/25 bg-accent/8 px-3 py-2 text-xs">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-primary/30 bg-primary/8 px-3 py-2 text-xs">
          Could not load the tournament feed: {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tournaments or cities…"
            className="pl-9"
          />
        </div>
        <div className="flex rounded-xl border border-border bg-card p-1">
          <button
            type="button"
            onClick={() => setRegion("local")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${region === "local" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
          >
            My area
          </button>
          <button
            type="button"
            onClick={() => setRegion("all")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${region === "all" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
          >
            All events
          </button>
        </div>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">
            <List className="size-3.5" /> List
          </TabsTrigger>
          <TabsTrigger value="calendar">
            <CalendarDays className="size-3.5" /> Calendar
          </TabsTrigger>
          <TabsTrigger value="map">
            <Map className="size-3.5" /> Map
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list">
          {loading && !data ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Card key={index} className="h-48 animate-pulse bg-secondary/40" />
              ))}
            </div>
          ) : filtered.length ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filtered.map((tournament, index) => (
                <TournamentCard
                  key={`${tournament.title}-${tournament.date_range}-${index}`}
                  tournament={tournament}
                />
              ))}
            </div>
          ) : (
            <Card className="grid place-items-center p-10 text-center">
              <Trophy className="mb-2 size-6 text-muted-foreground/60" />
              <p className="text-sm font-semibold">No tournaments match this filter</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try “All events”, clear the search, or check the feed.
              </p>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="calendar">
          <TournamentCalendar tournaments={filtered} />
        </TabsContent>

        <TabsContent value="map">
          <TournamentMap tournaments={filtered} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

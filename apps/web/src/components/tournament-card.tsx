"use client";

import { CalendarDays, ExternalLink, MapPin, Sparkles, Trophy } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Tournament } from "@/lib/api";

export function TournamentCard({ tournament }: { tournament: Tournament }) {
  const location = tournament.city_state || tournament.location || "Location pending";
  const prompt = `Tell me about "${tournament.title ?? "this tournament"}" and whether it fits my rating. If it does, prepare a signup for my approval.`;
  return (
    <Card className="group flex h-full flex-col p-4 transition-colors hover:border-primary/40">
      <div className="mb-3 flex items-start justify-between gap-2">
        <Badge variant="success">{tournament.status || "Upcoming"}</Badge>
        <Badge variant="outline" className="border-border">
          <Trophy className="size-2.5" /> OmniPong
        </Badge>
      </div>
      <h3 className="line-clamp-2 text-sm font-bold leading-snug tracking-tight text-foreground group-hover:text-primary">
        {tournament.title || "Untitled tournament"}
      </h3>
      <div className="mt-3 space-y-1.5 text-[11px] text-muted-foreground">
        <p className="flex items-start gap-1.5">
          <CalendarDays className="mt-0.5 size-3.5 shrink-0" />{" "}
          {tournament.date_range || "Date TBA"}
        </p>
        <p className="flex items-start gap-1.5">
          <MapPin className="mt-0.5 size-3.5 shrink-0" /> {location}
        </p>
      </div>
      <div className="mt-auto flex items-center gap-2 pt-4">
        <Link
          href={`/chat?prompt=${encodeURIComponent(prompt)}`}
          className={buttonClassName({ variant: "accent", size: "sm" })}
        >
          <Sparkles className="size-3.5" /> Ask coach
        </Link>
        {tournament.omnipong_url && (
          <a
            href={tournament.omnipong_url}
            target="_blank"
            rel="noreferrer"
            className={buttonClassName({ variant: "ghost", size: "sm" })}
          >
            <ExternalLink className="size-3.5" /> OmniPong
          </a>
        )}
      </div>
    </Card>
  );
}

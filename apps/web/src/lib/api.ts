"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UserProfile {
  full_name?: string;
  rating?: number;
  usatt_number?: string;
  phone_number?: string | null;
}

export interface Match {
  id?: number;
  date?: string;
  opponent_name?: string;
  opponent_rating?: number | string | null;
  score_summary?: string | null;
  set_scores?: string | null;
  result?: string;
  source?: string;
  is_win?: boolean;
  is_comeback?: boolean;
  is_choke?: boolean;
  is_close_game?: boolean;
}

export interface MatchSummary {
  overall?: { total?: number; wins?: number; losses?: number; win_rate?: number };
  years?: {
    year: string;
    total: number;
    wins: number;
    losses: number;
    win_rate: number;
    tournaments: number;
    matches: Match[];
  }[];
}

export interface Stats {
  win_rate?: string;
  wins?: number;
  losses?: number;
  tournaments?: string;
  trend?: string;
  rating_context?: string;
  patterns?: { comebacks?: number; chokes?: number; close_game_win_rate?: number };
}

export interface RatingPoint {
  date: string;
  rating: number;
  notes?: string;
}

export interface Tournament {
  title?: string;
  location?: string;
  city_state?: string;
  date_range?: string;
  status?: string;
  flyer_url?: string | null;
  omnipong_url?: string;
  contact_email?: string;
  estimated_cost?: string | null;
  events?: string | null;
  tier?: string | null;
}

export interface AgentIdentity {
  name?: string;
  tone?: string;
  avatar?: string;
}

export interface AgentSnapshot {
  identity?: AgentIdentity;
  tasks?: { id: string; title?: string; status?: string; kind?: string; updatedAt?: string }[];
  monitors?: { id: string; title?: string; intervalMinutes?: number; region?: string }[];
  notifications?: {
    id: string;
    title?: string;
    body?: string;
    createdAt?: string;
    read?: boolean;
  }[];
  worker?: { running?: boolean; lastTickAt?: string };
}

export interface PlayerHit {
  name: string;
  usatt_id?: string | number | null;
  rating?: number | string | null;
  state?: string | null;
}

export async function openPong<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/openpong${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      (data as { error?: string; detail?: string } | null)?.error ||
      (data as { detail?: string } | null)?.detail ||
      `OpenPong request failed (${response.status})`;
    throw new Error(
      typeof message === "string" ? message : `OpenPong request failed (${response.status})`,
    );
  }
  return data as T;
}

export function postOpenPong<T>(path: string, body: unknown): Promise<T> {
  return openPong<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

/** Tiny request hook: enough for the dashboard, no extra dependency. */
export function useOpenPong<T>(path: string | null, options: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const alive = useRef(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const next = await openPong<T>(path);
      if (alive.current) {
        setData(next);
        setError(null);
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    if (!options.refreshMs) return;
    const timer = setInterval(() => setTick((value) => value + 1), options.refreshMs);
    return () => clearInterval(timer);
  }, [options.refreshMs]);

  return { data, error, loading, refresh: () => setTick((value) => value + 1) };
}

export const when = (date?: string | null): string => {
  if (!date) return "Unknown date";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

export const isWin = (match: Match): boolean => {
  if (typeof match.is_win === "boolean") return match.is_win;
  if (match.result === "Win" || match.result === "W") return true;
  if (match.result === "Loss" || match.result === "L") return false;
  if (match.result?.includes("-")) {
    const [a, b] = match.result.split("-").map((part) => Number.parseInt(part, 10));
    return Number.isFinite(a) && Number.isFinite(b) ? a > b : false;
  }
  return false;
};

export const sourceLabel = (source?: string): string => {
  switch (source) {
    case "omnipong":
      return "USATT";
    case "stadium":
      return "Club";
    case "stadium_league":
      return "League";
    case "arcade":
      return "Arcade";
    default:
      return source || "Match";
  }
};

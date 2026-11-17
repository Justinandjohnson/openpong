"use client";

import { useId, useMemo } from "react";
import { cn } from "@/lib/utils";

interface Point {
  date?: string;
  rating: number;
}

/**
 * A compact rating sparkline. Deliberately dependency-free SVG so it renders on
 * the server, in a static export, and on a phone with the same pixels.
 *
 * The chart keeps a visible baseline and labels the low/high so a flat stretch
 * reads as "steady" instead of "broken chart".
 */
export function RatingSpark({
  points,
  className,
  height = 96,
  showRange = true,
}: {
  points: Point[];
  className?: string;
  height?: number;
  showRange?: boolean;
}) {
  const gradientId = useId().replace(/:/g, "");

  const shaped = useMemo(() => {
    const usable = points.filter((point) => Number.isFinite(point.rating));
    if (usable.length < 2) return null;
    const ratings = usable.map((point) => point.rating);
    const min = Math.min(...ratings);
    const max = Math.max(...ratings);
    const spread = Math.max(max - min, 30);
    const width = 320;
    const pad = 6;
    const x = (index: number) => pad + (index / (usable.length - 1)) * (width - pad * 2);
    const y = (rating: number) =>
      pad + (1 - (rating - min + spread * 0.12) / (spread * 1.24)) * (height - pad * 2);
    const line = usable
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.rating).toFixed(1)}`,
      )
      .join(" ");
    const area = `${line} L${x(usable.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
    return {
      width,
      line,
      area,
      change: ratings.at(-1)! - ratings[0],
      last: { x: x(usable.length - 1), y: y(ratings.at(-1)!) },
      min,
      max,
      first: usable[0]?.date,
      latest: usable.at(-1)?.date,
    };
  }, [height, points]);

  if (!shaped) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-xl border border-dashed border-border/80 px-3 text-center text-[11px] text-muted-foreground",
          className,
        )}
        style={{ height }}
      >
        Sync your matches to draw the trend.
      </div>
    );
  }

  const up = shaped.change > 0;
  const flat = shaped.change === 0;

  return (
    <div className={cn("relative", className)}>
      <svg
        viewBox={`0 0 ${shaped.width} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`Rating trend, ${shaped.change >= 0 ? "up" : "down"} ${Math.abs(shaped.change)} points`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.38" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {showRange && (
          <line
            x1={6}
            x2={shaped.width - 6}
            y1={height * 0.5}
            y2={height * 0.5}
            stroke="var(--border)"
            strokeDasharray="2 6"
          />
        )}
        <path d={shaped.area} fill={`url(#${gradientId})`} />
        <path
          d={shaped.line}
          fill="none"
          stroke={flat ? "var(--muted-foreground)" : "var(--accent)"}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx={shaped.last.x} cy={shaped.last.y} r="7" fill="var(--accent)" opacity="0.2" />
        <circle
          cx={shaped.last.x}
          cy={shaped.last.y}
          r="3"
          fill="var(--accent)"
          stroke="var(--background)"
          strokeWidth="1.5"
        />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
        <span className="tabular-nums">{shaped.min}</span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] font-bold tabular-nums",
            flat
              ? "border-border text-muted-foreground"
              : up
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-primary/30 bg-primary/10 text-primary",
          )}
        >
          {up ? "+" : ""}
          {shaped.change} pts
        </span>
        <span className="tabular-nums">{shaped.max}</span>
      </div>
    </div>
  );
}

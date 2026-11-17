"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function RatingChart({
  points,
  loading,
  className,
  compact = false,
}: {
  points: { date: string; rating: number }[];
  loading?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const shaped = useMemo(() => {
    if (points.length < 2) return null;
    const ratings = points.map((point) => point.rating);
    const min = Math.min(...ratings);
    const max = Math.max(...ratings);
    const spread = Math.max(max - min, 40);
    const width = 640;
    const height = compact ? 124 : 220;
    const pad = 18;
    const x = (index: number) => pad + (index / (points.length - 1)) * (width - pad * 2);
    const y = (rating: number) =>
      pad + (1 - (rating - min + spread * 0.15) / (spread * 1.3)) * (height - pad * 2);
    const line = points
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.rating).toFixed(1)}`,
      )
      .join(" ");
    const area = `${line} L${x(points.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
    const change = ratings.at(-1)! - ratings[0];
    return {
      line,
      area,
      width,
      height,
      change,
      last: { x: x(points.length - 1), y: y(ratings.at(-1)!) },
      min,
      max,
    };
  }, [points, compact]);

  if (loading)
    return (
      <Skeleton
        className={cn(compact ? "h-[clamp(96px,13vh,124px)]" : "h-[260px]", "w-full", className)}
      />
    );

  if (!shaped) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-xl border border-dashed border-border text-center",
          compact ? "h-[clamp(96px,13vh,124px)]" : "h-[260px]",
          className,
        )}
      >
        <span className="pong-ball mb-3 size-3 rounded-full" />
        <p className="text-sm font-semibold">No rating trajectory yet</p>
        <p className="mt-1 max-w-[28ch] text-xs text-muted-foreground">
          Press Sync on the dashboard and the trend appears here.
        </p>
      </div>
    );
  }

  const up = shaped.change > 0;
  const flat = shaped.change === 0;
  const TrendIcon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-background/40 pong-grid",
        className,
      )}
    >
      <div className={cn("relative", compact ? "p-3" : "p-4")}>
        {!compact && (
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                Rating trajectory
              </p>
              <p className="mt-1 text-3xl font-black tabular-nums tracking-tight">
                {points.at(-1)?.rating}
                <span className="ml-2 inline-flex items-center gap-0.5 text-xs font-bold text-muted-foreground">
                  <TrendIcon
                    className={cn("size-3.5", up ? "text-accent" : flat ? "" : "text-primary")}
                  />
                  {up ? "+" : ""}
                  {shaped.change} from first point
                </span>
              </p>
            </div>
            <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {points.length} points
            </span>
          </div>
        )}
        <svg
          viewBox={`0 0 ${shaped.width} ${shaped.height}`}
          preserveAspectRatio="none"
          className={compact ? "h-[clamp(96px,13vh,124px)] w-full" : "h-[190px] w-full"}
          role="img"
          aria-label="Rating trend"
        >
          <defs>
            <linearGradient id="ratingFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="ratingStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--chart-3)" />
              <stop offset="100%" stopColor="var(--accent)" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1="18"
              x2="622"
              y1={shaped.height * fraction}
              y2={shaped.height * fraction}
              stroke="var(--border)"
              strokeDasharray="3 7"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={shaped.area} fill="url(#ratingFill)" />
          <path
            d={shaped.line}
            fill="none"
            stroke="url(#ratingStroke)"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx={shaped.last.x} cy={shaped.last.y} r="8" fill="var(--accent)" opacity="0.18" />
          <circle
            cx={shaped.last.x}
            cy={shaped.last.y}
            r="4"
            fill="var(--accent)"
            stroke="var(--background)"
            strokeWidth="2"
          />
        </svg>
        <div className="flex justify-between text-[10px] font-mono text-muted-foreground/80">
          <span>{points[0]?.date?.slice(0, 10)}</span>
          <span>{points.at(-1)?.date?.slice(0, 10)}</span>
        </div>
      </div>
    </div>
  );
}

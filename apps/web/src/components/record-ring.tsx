"use client";

import { cn } from "@/lib/utils";

/**
 * Win/loss record as a donut. A number tells you the rate; the ring tells you
 * the shape of it, which is what people actually read.
 */
export function RecordRing({
  wins,
  losses,
  size = 108,
  label = "win rate",
  className,
}: {
  wins: number;
  losses: number;
  size?: number;
  label?: string;
  className?: string;
}) {
  const total = Math.max(wins + losses, 0);
  const rate = total ? Math.round((wins / total) * 100) : 0;
  const radius = size / 2 - 7;
  const circumference = 2 * Math.PI * radius;
  const arc = total ? (wins / total) * circumference : 0;

  return (
    <div
      className={cn("relative grid place-items-center", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${wins} wins, ${losses} losses, ${rate}% win rate`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--primary)"
          strokeOpacity="0.55"
          strokeWidth="8"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circumference - arc}`}
        />
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <span className="text-xl font-black leading-none tabular-nums">{rate}%</span>
        <span className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
      </div>
    </div>
  );
}

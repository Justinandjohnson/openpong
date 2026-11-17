import type * as React from "react";
import { cn } from "@/lib/utils";

const variants = {
  default: "border-border bg-secondary text-secondary-foreground",
  accent: "border-accent/30 bg-accent/10 text-accent",
  primary: "border-primary/30 bg-primary/12 text-primary",
  success: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  warning: "border-amber-500/25 bg-amber-500/10 text-amber-300",
  outline: "border-border text-muted-foreground",
} as const;

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof variants }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

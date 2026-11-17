import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  loading,
}: {
  label: string;
  value?: string | number | null;
  hint?: string;
  icon: LucideIcon;
  tone?: "default" | "accent" | "primary";
  loading?: boolean;
}) {
  if (loading) return <Skeleton className="h-[104px] w-full [@media(max-height:820px)]:h-24" />;
  return (
    <Card className="group relative min-w-0 overflow-hidden p-4 [@media(max-height:820px)]:p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            {label}
          </p>
          <p className="mt-1.5 truncate text-2xl font-black tabular-nums tracking-tight">
            {value ?? "—"}
          </p>
          {hint && (
            <p className="mt-1 text-[11px] leading-tight text-muted-foreground sm:truncate">
              {hint}
            </p>
          )}
        </div>
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl border",
            tone === "accent"
              ? "border-accent/25 bg-accent/10 text-accent"
              : tone === "primary"
                ? "border-primary/25 bg-primary/10 text-primary"
                : "border-border bg-secondary text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
    </Card>
  );
}

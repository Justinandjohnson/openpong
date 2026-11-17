"use client";

import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export function Sheet({
  open,
  onOpenChange,
  side = "left",
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  children: React.ReactNode;
  className?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <div
      className={cn("fixed inset-0 z-[65]", open ? "pointer-events-auto" : "pointer-events-none")}
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/65 backdrop-blur-sm transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={() => onOpenChange(false)}
      />
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          "absolute top-0 flex h-full w-[19rem] max-w-[85vw] flex-col border-border bg-sidebar shadow-2xl transition-transform duration-300",
          side === "left" ? "left-0 border-r" : "right-0 border-l",
          open ? "translate-x-0" : side === "left" ? "-translate-x-full" : "translate-x-full",
          className,
        )}
      >
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => onOpenChange(false)}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" />
        </button>
        {children}
      </aside>
    </div>
  );
}

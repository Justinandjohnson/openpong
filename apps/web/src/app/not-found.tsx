import Link from "next/link";
import { buttonClassName } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-10">
      <span className="grid size-11 place-items-center rounded-2xl border border-border bg-card">
        <span className="pong-ball size-3 rounded-full opacity-60" />
      </span>
      <h1 className="text-2xl font-black tracking-tight">Nothing on this table</h1>
      <p className="text-sm text-muted-foreground">
        That page does not exist. The dashboard, your matches, your calendar and the coach all do.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link href="/" className={buttonClassName({ variant: "accent", size: "default" })}>
          Dashboard
        </Link>
        <Link
          href="/tournaments"
          className={buttonClassName({ variant: "outline", size: "default" })}
        >
          Tournaments
        </Link>
      </div>
    </div>
  );
}

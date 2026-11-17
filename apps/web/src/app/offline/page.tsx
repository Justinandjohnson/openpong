import Link from "next/link";
import { buttonClassName } from "@/components/ui/button";

export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-10">
      <span className="grid size-11 place-items-center rounded-2xl border border-border bg-card">
        <span className="pong-ball size-3 rounded-full opacity-60" />
      </span>
      <h1 className="text-2xl font-black tracking-tight">You&apos;re offline</h1>
      <p className="text-sm text-muted-foreground">
        OpenPong keeps the last screens it saw on this device, but live data — ratings, tournaments
        and the coach — needs a connection.
      </p>
      <Link href="/" className={buttonClassName({ variant: "accent", size: "default" })}>
        Try again
      </Link>
    </div>
  );
}

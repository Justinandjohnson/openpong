import type { Context } from "hono";
import type { CalendarService } from "./service.ts";

const FEED_PATH = /^\/api\/calendar\/feed\/(.+)\.ics$/;

/**
 * The public, session-free iCal endpoint. It is deliberately a plain handler
 * rather than a mounted router: `apps/server/src/app.ts` owns the public route
 * table and mounts this *before* the `/api/*` session middleware (the token is
 * the credential). Mount with:
 *
 *   app.get("/api/calendar/feed/*", calendarFeedHandler(agent.calendar));
 *
 * A missing, tampered or rotated token is a 403; the response is always
 * `text/calendar`, regenerated from the owner's Pong cache on read.
 */
export function calendarFeedHandler(service: CalendarService) {
  return async (c: Context) => {
    const match = FEED_PATH.exec(c.req.path);
    if (!match?.[1]) return c.text("Not found", 404);
    let token: string;
    try {
      token = decodeURIComponent(match[1]);
    } catch {
      return c.text("Feed link is invalid or was rotated", 403);
    }
    const feed = await service.feedForToken(token).catch(() => null);
    if (!feed) return c.text("Feed link is invalid or was rotated", 403);
    c.header("Content-Type", "text/calendar; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(feed.ics);
  };
}

/**
 * The dashboard's view of the one-click Google Calendar connection, proxied
 * through the BFF so the browser never handles the server bearer. Shared by the
 * calendar hub, the setup wizard and the agent's MCP card so all three speak the
 * same three states: not configured, not connected, connected.
 */
export interface GoogleCalendarStatus {
  /** This server has a Google client, so a consent can actually be started. */
  configured: boolean;
  /** This owner has a Google calendar connection. */
  connected: boolean;
  /** How many calendars the coach can currently see. */
  calendars: number;
  /** The Pong calendar's id, once it exists. */
  calendarId?: string;
}

/** The operator guide, served from the repository's own docs file. */
export const GOOGLE_SETUP_DOC = "/docs/GOOGLE_SETUP.md";

export async function fetchGoogleStatus(): Promise<GoogleCalendarStatus> {
  const response = await fetch("/api/openpong/google/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not read the Google connection.");
  return (await response.json()) as GoogleCalendarStatus;
}

/**
 * Ask the server to start the consent. Already connected is a no-op; otherwise
 * the server hands back Google's URL for the browser to navigate to.
 */
export async function startGoogleConnect(): Promise<{ connected?: boolean; url?: string }> {
  const response = await fetch("/api/openpong/google/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await response.json().catch(() => ({}))) as {
    connected?: boolean;
    url?: string;
    error?: string;
  };
  if (!response.ok) throw new Error(body.error || "Could not start the Google connection.");
  return body;
}

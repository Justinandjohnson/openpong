import { z } from "zod";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "scheduled"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface Evidence {
  id: string;
  kind: "mail" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  url?: string;
}
export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  detail?: string;
}
export interface AgentTask {
  id: string;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan" | "scout" | "sync";
  status: TaskStatus;
  goalId?: string;
  milestoneId?: string;
  plan: TaskStep[];
  evidence: Evidence[];
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  leaseId?: string | null;
  leaseUntil?: string | null;
  attempts: number;
  actionId?: string | null;
  result?: string;
  error?: string | null;
  question?: string;
  artifactIds: string[];
}
export interface RunEvent {
  id: string;
  taskId: string;
  date: string;
  kind: "plan" | "step" | "observation" | "approval" | "result" | "error" | "status";
  title: string;
  detail: string;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed";
  milestones: { id: string; title: string; done: boolean }[];
  createdAt: string;
}
export interface Monitor {
  id: string;
  taskId: string;
  title: string;
  url: string;
  condition: "change" | "contains" | "price_below";
  value: string;
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  nextCheckAt: string;
  lastCheckedAt?: string;
  lastValue?: string;
  lastHash?: string;
  error?: string;
  checks: number;
  /**
   * Omitted means a public-page watch (the original kind). A `tournament`
   * watch re-runs OmniPong's new-tournament scout on an interval instead of
   * reading a page, but shares the same durable task, lease and dedup path.
   * `region`/`keywords` are per-owner settings; neither is ever a literal.
   */
  kind?: "page" | "tournament";
  region?: string;
  keywords?: string[];
}
export interface Idea {
  id: string;
  title: string;
  reason: string;
  evidence: Evidence[];
  prompt: string;
  kind: AgentTask["kind"];
  input: Record<string, unknown>;
  status: "new" | "dismissed" | "accepted";
  taskId?: string;
  createdAt: string;
}
export interface AgentMemory {
  id: string;
  text: string;
  source: string;
  createdAt: string;
}
export interface AgentArtifact {
  id: string;
  taskId: string;
  kind: "plan" | "comparison" | "finance" | "report";
  title: string;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface AgentNotification {
  id: string;
  taskId?: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}
export interface AgentIdentity {
  name: string;
  tone: "warm" | "concise" | "thoughtful";
  avatar?: "sky" | "sand" | "lilac";
  showChatUpdates?: boolean;
}
export interface AgentWorkspace {
  tasks: AgentTask[];
  goals: Goal[];
  monitors: Monitor[];
  ideas: Idea[];
  memories: AgentMemory[];
  artifacts: AgentArtifact[];
  notifications: AgentNotification[];
  identity: AgentIdentity;
  worker: { running: boolean; lastTickAt?: string };
}
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(12000),
  kind: z
    .enum(["agent", "document", "monitor", "finance", "plan", "scout", "sync"])
    .default("agent"),
  goalId: z.string().optional(),
  milestoneId: z.string().min(1).max(200).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export const monitorInputSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z.url().max(4096),
    condition: z.enum(["change", "contains", "price_below"]).default("change"),
    value: z.string().max(300).default(""),
    intervalMinutes: z.number().int().min(1).max(10080).default(15),
  })
  .superRefine((v, c) => {
    if (v.condition !== "change" && !v.value.trim())
      c.addIssue({ code: "custom", message: "Enter a condition value" });
    if (
      v.condition === "price_below" &&
      (!Number.isFinite(Number(v.value)) || Number(v.value) <= 0)
    )
      c.addIssue({ code: "custom", message: "Enter a positive price" });
  });
/**
 * The owner's own table-tennis identity and area, entered at first-run
 * onboarding and edited later in Settings. This is the single source of truth
 * for "who am I" and "where do I play": no name, USATT number, region, city or
 * club is ever a literal in the server, a prompt or a default. Stored as
 * `db.put(owner, "agent-settings", { id: "profile", ... })`.
 */
export const ownerProfileSchema = z.object({
  /** Required to onboard: the person's own name. */
  displayName: z.string().trim().min(1, "Enter your name").max(120),
  /** Optional official USATT number. */
  usattId: z.string().trim().max(64).optional(),
  /** Optional area label or number (for example the OmniPong region the person plays in). */
  homeRegion: z.string().trim().max(64).optional(),
  /** Cities that define the person's area. Together with `states`, this is "my area". */
  cities: z.array(z.string().trim().max(120)).max(20).optional(),
  /** States that define the person's area (names or abbreviations). */
  states: z.array(z.string().trim().max(120)).max(20).optional(),
  /** Clubs the person plays at. */
  clubs: z.array(z.string().trim().max(200)).max(20).optional(),
  /** StadiumTT / league tournament URLs this person follows. */
  leagueUrls: z.array(z.url().max(2048)).max(20).optional(),
});
export type OwnerProfileInput = z.infer<typeof ownerProfileSchema>;
/** The persisted record: the validated input plus its storage identity and timestamp. */
export interface OwnerProfile extends OwnerProfileInput {
  id: "profile";
  updatedAt: string;
}
/** First-run detection: a person has onboarded when their profile names them. */
export function isProfileOnboarded(profile: OwnerProfileInput | null | undefined): boolean {
  return Boolean(profile?.displayName?.trim());
}
/**
 * A recurring tournament watch. No geography is hard-coded: `region` is the
 * owner's filter (omitted means the owner's profile area, or no filter at all
 * when they have not set one) and `keywords` are optional title matches.
 * The OmniPong service keeps its own default area; this only narrows the
 * titles announced back to the owner.
 */
export const tournamentWatchSchema = z.object({
  region: z.string().trim().min(1).max(64).optional(),
  keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});
export type TournamentWatchInput = z.infer<typeof tournamentWatchSchema>;
/** Payload for a (real) tournament registration. Never carries an approval flag. */
export const tournamentSignupSchema = z.object({
  title: z.string().trim().min(1).max(200),
  events: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
});
export type TournamentSignupInput = z.infer<typeof tournamentSignupSchema>;
/**
 * The always-on daily tournament scout. One record per owner, stored as
 * `db.put(owner, "agent-settings", { id: "scout", ... })` — the same kind as the
 * identity/profile settings, so no migration is needed.
 *
 * `hour` is the owner's local hour (0-23) at which the daily run is due;
 * `nextRunAt` is the durable schedule the worker reads (computed from `hour`, so
 * a missed run is picked up on the next tick instead of being lost).
 * `seenTournamentIds` is the exact dedupe ledger: a tournament identity is
 * announced once and never again, and the list is capped at
 * `MAX_SEEN_TOURNAMENTS` newest entries so it cannot grow without bound.
 */
export const DEFAULT_SCOUT_HOUR = 8;
export const MAX_SEEN_TOURNAMENTS = 500;
export interface ScoutSettings {
  id: "scout";
  enabled: boolean;
  hour: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastResult?: { found: number; newCount: number };
  seenTournamentIds: string[];
}
/** The read view returned by `GET /api/agent/scout`. */
export interface ScoutView {
  enabled: boolean;
  hour: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastResult?: { found: number; newCount: number };
  seenCount: number;
}
export const scoutSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  hour: z.number().int().min(0).max(23).optional(),
});
export type ScoutSettingsInput = z.infer<typeof scoutSettingsSchema>;
/**
 * The next local `hour:00` strictly after `from`. Used both to schedule the
 * daily run and to prove a run reschedules roughly a day ahead. Local wall time
 * is intentional: the owner picked "8" meaning 8am where they play.
 */
export function nextScoutRun(hour: number, from: Date = new Date()): string {
  const next = new Date(from);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}
export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(""),
  category: z.string().max(80).default("Personal"),
  milestones: z.array(z.string().min(1).max(200)).max(20).default([]),
});

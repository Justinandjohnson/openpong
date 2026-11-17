import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type AgentArtifact,
  type AgentIdentity,
  type AgentMemory,
  type AgentNotification,
  type AgentTask,
  type AgentWorkspace,
  createTaskSchema,
  DEFAULT_SCOUT_HOUR,
  type Evidence,
  type Goal,
  goalInputSchema,
  type Idea,
  isProfileOnboarded,
  MAX_SEEN_TOURNAMENTS,
  type Monitor,
  monitorInputSchema,
  nextScoutRun,
  type OwnerProfile,
  ownerProfileSchema,
  type RunEvent,
  type ScoutSettings,
  type ScoutView,
  scoutSettingsSchema,
  type TournamentSignupInput,
  tournamentWatchSchema,
} from "../../../../packages/domain/src/agent.ts";
import type {
  ActionProposal,
  Artifact,
  BrowserSession,
  Mail,
  ProposalInput,
} from "../../../../packages/domain/src/index.ts";
import type { ActionService } from "../actions.ts";
import type { BrowserService } from "../browser.ts";
import { CalendarService } from "../calendar/service.ts";
import { ComputerService } from "../computer.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import type { Files } from "../files.ts";
import { backgroundFailure } from "../log.ts";
import { defaultOmniPongServiceUrl, OmniPongService } from "../omnipong/service.ts";
import {
  areaFor,
  areaLabel,
  narrowTournaments,
  resolveTournamentRegion,
} from "../onboarding/area.ts";
import { RelayClient, RelayError } from "../relay/client.ts";
import { SearchService } from "../search.ts";
import type { WorkspaceService } from "../workspace.ts";
import { analyzeSpending } from "./finance.ts";
import { executeModelTask, taskAnswers } from "./model.ts";
import {
  countPageDiff,
  describePageDiff,
  diffPage,
  pageLines,
  withoutRelativeTimes,
} from "./page-diff.ts";
import { LostLeaseError, type TaskContext, TaskWorker } from "./worker.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** A change watch's last saved page: its hash, relative-time-free fingerprint and lines. */
type MonitorPage = { id: string; hash?: string; timelessHash?: string; lines: string[] };
const date = () => new Date().toISOString();
const terminal = new Set(["succeeded", "failed", "cancelled"]);
export class AgentService {
  readonly worker: TaskWorker;
  readonly search: SearchService;
  /** The Pong calendar hub: Google secondary calendar or tokenised iCal feed. */
  readonly calendar: CalendarService;
  private maintenance?: ReturnType<typeof setInterval>;
  private refreshing = false;
  constructor(
    readonly db: Store,
    readonly config: Config,
    readonly workspace: WorkspaceService,
    readonly files: Files,
    readonly actions: ActionService,
    readonly browser: BrowserService,
    readonly computer: ComputerService = new ComputerService(db, config),
    // The OmniPong Python service fronts the table-tennis domain (Phase 1). It is
    // optional: with no service running, tools still resolve and fail cleanly.
    readonly omnipong: OmniPongService = new OmniPongService({
      baseUrl: config.omnipongServiceUrl ?? defaultOmniPongServiceUrl,
      token: config.omnipongServiceToken,
    }),
    // The relay's operator control plane: which of the owner's computers are
    // paired/connected, and any pending human gate. Optional — without a URL
    // the status reads "not configured" instead of throwing.
    readonly relay: RelayClient = new RelayClient({
      url: config.relayUrl,
      token: config.relayToken,
    }),
  ) {
    this.search = new SearchService(db);
    this.calendar = new CalendarService(db, config, {
      omnipong: this.omnipong,
      profile: (owner) => this.getProfile(owner),
      publicUrl: config.publicUrl,
    });
    this.worker = new TaskWorker(db, (owner, task, context) => this.execute(owner, task, context), {
      settled: (owner, task) => this.publishOutcome(owner, task),
      scheduleScout: (owner, settings) => this.scheduleScout(owner, settings),
    });
  }
  start() {
    this.worker.start();
    // Maintenance is independent of the HTTP response and reconciles durable records.
    void this.maintain().catch((error) => backgroundFailure("initial maintenance", error));
    this.maintenance = setInterval(() => {
      void this.maintain().catch((error) => backgroundFailure("maintenance", error));
    }, 60000);
  }
  async stop() {
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = undefined;
    await this.worker.stop();
    while (this.refreshing) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  private async maintain() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // Recover publications if the process exited after committing an outcome.
      for (const { owner, value } of await this.db.scan<AgentTask>("tasks"))
        await this.publishOutcome(owner, value);
      for (const { owner, value } of await this.db.scan<Monitor>("monitors"))
        await this.activateMonitor(owner, value);
      for (const { owner, value } of await this.db.scan<Idea>("ideas"))
        if (
          value.status === "accepted" &&
          value.taskId &&
          !(await this.db.get(owner, "tasks", value.taskId))
        )
          await this.decideIdea(owner, value.id, "accept").catch(async (error) => {
            backgroundFailure("recover accepted idea", error);
            await this.notify(
              owner,
              "Accepted idea needs attention",
              "Open the idea again after making room for another task.",
              undefined,
              `idea-recovery:${value.id}`,
            );
          });
      for (const { owner, value } of await this.db.scan<{ id: string; lastIdeasAt?: string }>(
        "agent-settings",
      )) {
        if (value.id !== "identity") continue;
        if (!value.lastIdeasAt || Date.now() - Date.parse(value.lastIdeasAt) > 15 * 60000)
          await this.refreshIdeas(owner).catch(async () => {
            await this.notify(
              owner,
              "Source refresh needs attention",
              "Reconnect the source or refresh Ideas to see the error.",
              undefined,
              `source-error:${Math.floor(Date.now() / 3600000)}`,
            );
          });
      }
    } finally {
      this.refreshing = false;
    }
  }
  async ensure(owner: string) {
    await this.db.insertIfAbsent(owner, "agent-settings", {
      id: "identity",
      name: "OpenPong",
      tone: "warm",
    });
  }
  /** The owner's own profile record, or null before first-run onboarding. */
  async getProfile(owner: string): Promise<OwnerProfile | null> {
    const profile = await this.db.get<OwnerProfile>(owner, "agent-settings", "profile");
    return profile && isProfileOnboarded(profile) ? profile : null;
  }
  /**
   * Validate and persist the owner profile. Invalid input is a 400, never a
   * stored default: blank optional values are dropped so an empty form field
   * does not become a setting.
   */
  async saveProfile(owner: string, raw: unknown): Promise<OwnerProfile> {
    const parsed = ownerProfileSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
    const input = parsed.data;
    const clean = {
      ...input,
      usattId: input.usattId?.trim() || undefined,
      homeRegion: input.homeRegion?.trim() || undefined,
      cities: input.cities?.filter(Boolean),
      states: input.states?.filter(Boolean),
      clubs: input.clubs?.filter(Boolean),
      leagueUrls: input.leagueUrls?.filter(Boolean),
    };
    const profile: OwnerProfile = { ...clean, id: "profile", updatedAt: date() };
    return this.db.put(owner, "agent-settings", profile);
  }
  /** `GET /api/agent/profile`: the record plus first-run detection. */
  async profileView(owner: string): Promise<{ profile: OwnerProfile | null; onboarded: boolean }> {
    const profile = await this.getProfile(owner);
    return { profile, onboarded: isProfileOnboarded(profile) };
  }
  /** The owner's area resolved from their profile (no literal fallback). */
  async ownerArea(owner: string) {
    return areaFor(await this.getProfile(owner));
  }
  /**
   * The owner's daily-scout setting, normalised. A missing record is the
   * documented default (disabled, 08:00) and is never written by a read.
   */
  private async readScout(owner: string): Promise<ScoutSettings> {
    const saved = await this.db.get<Partial<ScoutSettings>>(owner, "agent-settings", "scout");
    const hour =
      Number.isInteger(saved?.hour) && Number(saved?.hour) >= 0 && Number(saved?.hour) <= 23
        ? Number(saved?.hour)
        : DEFAULT_SCOUT_HOUR;
    return {
      id: "scout",
      enabled: saved?.enabled === true,
      hour,
      ...(typeof saved?.nextRunAt === "string" ? { nextRunAt: saved.nextRunAt } : {}),
      ...(typeof saved?.lastRunAt === "string" ? { lastRunAt: saved.lastRunAt } : {}),
      ...(saved?.lastResult ? { lastResult: saved.lastResult } : {}),
      seenTournamentIds: Array.isArray(saved?.seenTournamentIds)
        ? saved.seenTournamentIds.filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          )
        : [],
    };
  }
  /** `GET /api/agent/scout`: the setting plus the last run's outcome. */
  async scoutView(owner: string): Promise<ScoutView> {
    const { enabled, hour, nextRunAt, lastRunAt, lastResult, seenTournamentIds } =
      await this.readScout(owner);
    return {
      enabled,
      hour,
      ...(nextRunAt ? { nextRunAt } : {}),
      ...(lastRunAt ? { lastRunAt } : {}),
      ...(lastResult ? { lastResult } : {}),
      seenCount: seenTournamentIds.length,
    };
  }
  /**
   * `PUT /api/agent/scout`. Turning the scout on (or moving its hour) writes the
   * next local occurrence of that hour; turning it off clears the schedule so a
   * later re-enable starts fresh instead of firing a stale catch-up.
   */
  async saveScout(owner: string, raw: unknown): Promise<ScoutView> {
    const parsed = scoutSettingsSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
    const patch = parsed.data;
    const current = await this.readScout(owner);
    const next: ScoutSettings = { ...current };
    if (patch.hour !== undefined) next.hour = patch.hour;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (next.enabled) next.nextRunAt = nextScoutRun(next.hour);
    else next.nextRunAt = undefined;
    await this.db.put(owner, "agent-settings", next);
    return this.scoutView(owner);
  }
  /**
   * The worker found the owner's scout due: claim the schedule slot, then queue
   * the durable run. The compare-and-swap is what makes "once a day" exact even
   * with several workers ticking at the same instant.
   */
  async scheduleScout(owner: string, settings: ScoutSettings): Promise<void> {
    if (settings.enabled !== true) return;
    const hour =
      Number.isInteger(settings.hour) && settings.hour >= 0 && settings.hour <= 23
        ? settings.hour
        : DEFAULT_SCOUT_HOUR;
    const advanced = nextScoutRun(hour, new Date());
    const claimed = await this.db.compareAndSwap<ScoutSettings>(
      owner,
      "agent-settings",
      "scout",
      settings.nextRunAt ? { nextRunAt: settings.nextRunAt } : { enabled: true },
      { nextRunAt: advanced, hour },
    );
    if (!claimed) return;
    const label = areaLabel(await this.ownerArea(owner));
    await this.createTask(
      owner,
      {
        kind: "scout",
        title: "Daily tournament scout",
        prompt: `Check ${label} for new tournaments and announce anything not seen before.`,
      },
      `scout:${settings.nextRunAt ?? advanced}`,
    );
  }
  /**
   * `POST /api/agent/scout/run`: queue one run now, independent of the schedule
   * (and even while the daily switch is off). Like the scheduled run it is a
   * durable task, so it survives a restart and dedupes against the same ledger.
   */
  async runScoutNow(owner: string): Promise<AgentTask> {
    return this.createTask(owner, {
      kind: "scout",
      title: "Daily tournament scout",
      prompt: "Check my area for new tournaments and announce anything not seen before.",
    });
  }
  /**
   * `POST /api/agent/sync`: the dashboard's one-tap sync.
   *
   * Deterministic by design — no model turn, no guessing. The league URL and the
   * player name come from the saved profile; if either is missing the owner gets
   * an actionable 400 instead of a vague failure. Running it twice is safe: the
   * league sync is idempotent, and two clicks collapse onto one open task.
   */
  async runSyncNow(owner: string): Promise<AgentTask> {
    const profile = await this.getProfile(owner);
    const leagueUrls = (profile?.leagueUrls ?? []).filter(Boolean);
    if (leagueUrls.length === 0)
      throw new AppError(
        "Add your league URL in Settings first — then this button can pull your matches.",
        400,
      );
    const open = (await this.db.list<AgentTask>(owner, "tasks")).find(
      (task) => task.kind === "sync" && !terminal.has(task.status),
    );
    if (open) return open;
    return this.createTask(owner, {
      kind: "sync",
      title: "Sync league matches",
      prompt: "Refresh league matches from the league URL saved in my profile.",
    });
  }
  async snapshot(owner: string): Promise<AgentWorkspace> {
    await this.ensure(owner);
    const [tasks, goals, monitors, ideas, memories, artifacts, notifications, identity] =
      await Promise.all([
        this.db.list<AgentTask>(owner, "tasks"),
        this.db.list<Goal>(owner, "goals"),
        this.db.list<Monitor>(owner, "monitors"),
        this.db.list<Idea>(owner, "ideas"),
        this.db.list<AgentMemory>(owner, "memories"),
        this.db.list<AgentArtifact>(owner, "agent-artifacts"),
        this.db.list<AgentNotification>(owner, "notifications"),
        this.db.get<AgentIdentity>(owner, "agent-settings", "identity"),
      ]);
    const heartbeat = await this.db.get<{ lastTickAt: string }>("system", "worker-status", "tasks");
    return {
      tasks,
      goals,
      monitors,
      ideas,
      memories,
      artifacts,
      notifications,
      identity: identity ?? { name: "OpenPong", tone: "warm" },
      worker: {
        running:
          this.worker.running ||
          Boolean(heartbeat && Date.now() - Date.parse(heartbeat.lastTickAt) < 15000),
        lastTickAt: heartbeat?.lastTickAt ?? this.worker.lastTickAt,
      },
    };
  }
  async getTask(owner: string, id: string) {
    const task = await this.db.get<AgentTask>(owner, "tasks", id);
    if (!task) throw new AppError("Task not found", 404);
    return task;
  }
  async detail(owner: string, id: string) {
    const task = await this.getTask(owner, id);
    // Scoped by the ids the task already names, so a long-lived workspace does not read
    // every file, browser, event and artifact it has ever stored to show one task.
    const browserIds = [task.state.browserId, task.state.sessionId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const [files, browsers, events, artifacts] = await Promise.all([
      this.db.listByIds<Artifact>(owner, "files", task.artifactIds ?? []),
      this.db.listByIds<BrowserSession>(owner, "browsers", browserIds),
      this.db.listByTaskId<RunEvent>(owner, "run-events", id),
      this.db.listByTaskId<AgentArtifact>(owner, "agent-artifacts", id),
    ]);
    return {
      task,
      files: files.map((file) => this.files.signed(owner, file)),
      browsers: browsers.map((browser) => this.browser.decorate(owner, browser)),
      events: events.sort((a, b) => a.date.localeCompare(b.date)),
      artifacts,
    };
  }
  async createTask(owner: string, raw: unknown, idempotencyKey?: string, held = false) {
    const input = createTaskSchema.parse(raw);
    const id = idempotencyKey ? hash(`task:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<AgentTask>(owner, "tasks", id);
    if (existing) return existing;
    if (input.milestoneId && !input.goalId) throw new AppError("A milestone requires a goal", 422);
    const goal = input.goalId ? await this.db.get<Goal>(owner, "goals", input.goalId) : null;
    if (input.goalId && !goal) throw new AppError("Goal not found", 404);
    if (input.milestoneId && !goal?.milestones.some((m) => m.id === input.milestoneId))
      throw new AppError("Milestone not found in this goal", 404);
    if (
      (await this.db.list<AgentTask>(owner, "tasks")).filter((t) => !terminal.has(t.status))
        .length >= 100
    )
      throw new AppError("Finish or cancel some tasks before adding more", 409);
    const titles =
      input.kind === "document"
        ? [
            "Find the source document",
            "Fill a new copy",
            "Prepare a reply",
            "Wait for your decision",
            "Record the outcome",
          ]
        : input.kind === "monitor"
          ? ["Check the source", "Compare with the last observation", "Report a meaningful change"]
          : input.kind === "finance"
            ? ["Validate transactions", "Calculate the summary", "Save your tracker"]
            : input.kind === "scout"
              ? ["Read your area tournaments", "Compare with the last run", "Announce anything new"]
              : input.kind === "sync"
                ? ["Read your saved league", "Pull every match", "Save new results"]
                : [
                    "Understand the outcome",
                    "Plan the work",
                    "Use connected tools",
                    "Return a result",
                  ];
    const task: AgentTask = {
      id,
      title: input.title ?? input.prompt.slice(0, 90),
      prompt: input.prompt,
      kind: input.kind,
      goalId: input.goalId,
      milestoneId: input.milestoneId,
      status: held || goal?.status === "paused" ? "paused" : "queued",
      plan: titles.map((title, i) => ({ id: String(i), title, status: "pending" })),
      evidence: [],
      input: input.input,
      state: {
        connectionId: (await this.workspace.connection(owner))?.id ?? null,
        ...(held && input.kind === "monitor" ? { initializingMonitor: true } : {}),
      },
      createdAt: date(),
      updatedAt: date(),
      attempts: 0,
      leaseId: null,
      leaseUntil: null,
      artifactIds: [],
    };
    await this.ensure(owner);
    await this.db.insertIfAbsent(owner, "tasks", task);
    return (await this.db.get<AgentTask>(owner, "tasks", id)) ?? task;
  }
  async control(owner: string, id: string, action: "pause" | "resume" | "cancel" | "retry") {
    const task = await this.getTask(owner, id);
    if (action === "cancel" && task.status === "succeeded")
      throw new AppError("This task is already complete", 409);
    if (action === "retry" && task.status !== "failed")
      throw new AppError("Only failed tasks can be retried", 409);
    if (action === "resume" && task.status !== "paused")
      throw new AppError("Only paused tasks can be resumed", 409);
    if (action === "pause" && (terminal.has(task.status) || task.status === "paused")) return task;
    if (task.kind === "monitor" && action === "resume") {
      // Both UI entry points must activate the monitor before a worker can claim its task.
      await this.controlMonitor(owner, String(task.input.monitorId), "resume");
      const resumed = await this.getTask(owner, id);
      await this.db.put(owner, "run-events", {
        id: randomUUID(),
        taskId: id,
        kind: "status",
        date: date(),
        title: `Task ${resumed.status}`,
        detail: "Changed by you",
      });
      return resumed;
    }
    const status =
      action === "cancel"
        ? "cancelled"
        : action === "pause"
          ? "paused"
          : task.actionId
            ? "waiting_approval"
            : "queued";
    if (action === "retry" && task.actionId) {
      const a = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (a && a.status !== "succeeded")
        throw new AppError(
          "Check the reviewed action before retrying; its outcome may be uncertain. Start a new task when reconciled.",
          409,
        );
    }
    const updated = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: task.status, leaseId: task.leaseId ?? null },
      {
        status,
        leaseId: null,
        leaseUntil: null,
        error: null,
        updatedAt: date(),
        result:
          action === "cancel"
            ? "Stopped by you."
            : action === "pause"
              ? "Paused. Resume when you're ready."
              : "",
      },
    );
    if (!updated) throw new AppError("Task changed; refresh and try again", 409);
    this.worker.abort(id);
    if (task.kind === "monitor")
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        {},
        {
          status: action === "cancel" ? "stopped" : action === "pause" ? "paused" : "active",
          nextCheckAt: date(),
          // Clearing the error fences out a failure reconcile that read the task before this.
          ...(action === "resume" || action === "retry" ? { error: null } : {}),
        },
      );
    if (action === "cancel" && task.actionId) {
      const proposal = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (proposal?.status === "awaiting_review")
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
    }
    await this.db.put(owner, "run-events", {
      id: randomUUID(),
      taskId: id,
      kind: "status",
      date: date(),
      title: `Task ${status}`,
      detail: "Changed by you",
    });
    return updated;
  }
  async answer(
    owner: string,
    id: string,
    answer: string,
    fields?: Record<string, string | boolean>,
  ) {
    const task = await this.getTask(owner, id);
    if (task.status !== "waiting_input")
      throw new AppError("This task is not waiting for input", 409);
    // Each run starts fresh, so keep every reply with its question, not just the latest.
    const { answer: _latest, ...state } = task.state;
    const answers = [
      ...taskAnswers(task.state),
      { ...(task.question ? { question: task.question } : {}), answer },
    ];
    const next = await this.db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      id,
      { status: "waiting_input" },
      {
        status: "queued",
        question: null,
        input: { ...task.input, ...(fields ? { fields } : {}) },
        state: { ...state, answers },
        updatedAt: date(),
      },
    );
    if (!next) throw new AppError("Task changed; refresh and try again", 409);
    return next;
  }
  async createGoal(owner: string, raw: unknown, id?: string) {
    const input = goalInputSchema.parse(raw);
    const goal: Goal = {
      id: id ?? randomUUID(),
      title: input.title,
      description: input.description,
      category: input.category,
      status: "active",
      milestones: input.milestones.map((title) => ({ id: randomUUID(), title, done: false })),
      createdAt: date(),
    };
    await this.db.insertIfAbsent(owner, "goals", goal);
    return (await this.db.get<Goal>(owner, "goals", goal.id)) ?? goal;
  }
  async updateGoal(
    owner: string,
    id: string,
    patch: { status?: Goal["status"]; milestones?: Goal["milestones"] },
  ) {
    const saved = await this.db.compareAndSwap<Goal>(owner, "goals", id, {}, patch);
    if (!saved) throw new AppError("Goal not found", 404);
    if (patch.status === "paused")
      for (const task of await this.db.listByGoalId<AgentTask>(owner, "tasks", id))
        if (!terminal.has(task.status) && task.status !== "paused")
          await this.control(owner, task.id, "pause");
    return saved;
  }
  async setMilestoneDone(owner: string, goalId: string, milestoneId: string, done: boolean) {
    const saved = await this.db.setMilestoneDone<Goal>(owner, goalId, milestoneId, done);
    if (!saved) throw new AppError("Goal or milestone not found", 404);
    return saved;
  }
  async createMonitor(owner: string, raw: unknown, idempotencyKey?: string) {
    const input = monitorInputSchema.parse(raw);
    const url = new URL(input.url);
    if (url.protocol === "sample:" && this.config.mode !== "sample")
      throw new AppError("Sample sources are unavailable in live workspaces", 422);
    if (!["https:", "http:", "sample:"].includes(url.protocol) || url.username || url.password)
      throw new AppError("Use a public HTTP(S) page", 422);
    if (url.protocol === "sample:" && input.url !== "sample://availability")
      throw new AppError("Unknown sample source", 422);
    const id = idempotencyKey ? hash(`monitor:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<Monitor>(owner, "monitors", id);
    if (existing) {
      await this.activateMonitor(owner, existing);
      return existing;
    }
    const task = await this.createTask(
      owner,
      {
        kind: "monitor",
        title: input.title,
        prompt: `Watch ${input.url} for ${input.condition}${input.value ? `: ${input.value}` : ""}`,
        input: { monitorId: id },
      },
      `monitor:${id}`,
      true,
    );
    const monitor: Monitor = {
      id,
      taskId: task.id,
      ...input,
      status: "active",
      nextCheckAt: date(),
      checks: 0,
    };
    await this.db.insertIfAbsent(owner, "monitors", monitor);
    await this.activateMonitor(owner, monitor);
    return monitor;
  }
  private async activateMonitor(owner: string, monitor: Monitor) {
    if (monitor.status !== "active") return null;
    const task = await this.getTask(owner, monitor.taskId);
    if (task.status !== "paused") return null;
    if (task.state.resumingMonitor)
      return this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        { status: "paused", state: { resumingMonitor: true } },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, resumingMonitor: false, failures: 0, notice: null },
        },
      );
    if (!task.state.initializingMonitor) return null;
    return this.db.compareAndSwap(
      owner,
      "tasks",
      task.id,
      { status: "paused", attempts: 0, state: { initializingMonitor: true } },
      {
        status: "queued",
        state: { ...task.state, initializingMonitor: false },
      },
    );
  }
  async controlMonitor(owner: string, id: string, action: "pause" | "resume" | "stop" | "check") {
    const monitor = await this.db.get<Monitor>(owner, "monitors", id);
    if (!monitor) throw new AppError("Monitor not found", 404);
    if (monitor.status === "stopped" && action !== "stop")
      throw new AppError("Create a new watch to restart this stopped monitor", 409);
    if (action === "pause" || action === "stop") {
      const status = action === "pause" ? "paused" : "stopped";
      const saved = await this.db.compareAndSwap<Monitor>(
        owner,
        "monitors",
        id,
        {},
        { status, nextCheckAt: date() },
      );
      const task = await this.getTask(owner, monitor.taskId);
      await this.control(owner, task.id, action === "pause" ? "pause" : "cancel");
      return saved ?? monitor;
    }
    let monitorStatus = monitor.status;
    for (let attempt = 0; attempt < 2; attempt++) {
      const task = await this.getTask(owner, monitor.taskId);
      if (task.status === "cancelled") break;
      if (task.status === "paused") {
        // Mark the paused task before activating the monitor so no worker can claim it in between.
        const marked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", leaseId: task.leaseId ?? null },
          { state: { ...task.state, resumingMonitor: true } },
        );
        if (!marked) break;
        const activated = await this.db.compareAndSwap<Monitor>(
          owner,
          "monitors",
          id,
          { status: monitor.status },
          { status: "active", nextCheckAt: date(), error: null },
        );
        const saved = activated ?? (await this.db.get<Monitor>(owner, "monitors", id));
        if (saved?.status === "active" && (await this.activateMonitor(owner, saved))) return saved;
        const unmarked = await this.db.compareAndSwap(
          owner,
          "tasks",
          task.id,
          { status: "paused", state: { resumingMonitor: true } },
          { state: { ...task.state, resumingMonitor: false } },
        );
        // Another request or maintenance may have finished this resume first.
        if (!unmarked && saved?.status === "active") {
          const latest = await this.getTask(owner, task.id);
          if (["queued", "running", "scheduled"].includes(latest.status)) return saved;
        }
        if (activated)
          await this.db.compareAndSwap(
            owner,
            "monitors",
            id,
            { status: "active" },
            { status: monitor.status, error: monitor.error ?? null },
          );
        break;
      }
      // Only activate the monitor we read, so a concurrent stop is never undone.
      const saved = await this.db.compareAndSwap<Monitor>(
        owner,
        "monitors",
        id,
        { status: monitorStatus },
        { status: "active", nextCheckAt: date() },
      );
      if (!saved) break;
      monitorStatus = "active";
      this.worker.abort(task.id);
      const queued = await this.db.compareAndSwap(
        owner,
        "tasks",
        task.id,
        // updatedAt fences out a whole run finishing in between, which would move the baseline.
        { status: task.status, leaseId: task.leaseId ?? null, updatedAt: task.updatedAt },
        {
          status: "queued",
          nextRunAt: date(),
          leaseId: null,
          leaseUntil: null,
          error: null,
          state: { ...task.state, failures: 0, notice: null },
        },
      );
      if (queued) return saved;
    }
    throw new AppError("The watch changed while updating. Try again.", 409);
  }
  /**
   * Create the recurring tournament watch (`watch_tournament`). It reuses the
   * monitor task/lease/dedup machinery; the worker's observe branch runs
   * OmniPong's `check` scout each interval. The region comes from the tool
   * argument or the owner's profile — never a literal default.
   */
  async createTournamentMonitor(owner: string, raw: unknown, idempotencyKey?: string) {
    const input = tournamentWatchSchema.parse(raw);
    const id = idempotencyKey ? hash(`tournament-monitor:${idempotencyKey}`) : randomUUID();
    const existing = await this.db.get<Monitor>(owner, "monitors", id);
    if (existing) {
      await this.activateMonitor(owner, existing);
      return existing;
    }
    const profile = await this.getProfile(owner);
    const area = areaFor(profile);
    const region = resolveTournamentRegion(input.region, area);
    const label = areaLabel({ ...area, ...(region ? { region } : {}) });
    const keywords = input.keywords.map((keyword) => keyword.trim()).filter(Boolean);
    const title = keywords.length
      ? `Watch ${label} tournaments: ${keywords.join(", ")}`
      : `Watch ${label} tournaments`;
    const task = await this.createTask(
      owner,
      {
        kind: "monitor",
        title,
        prompt: `Watch ${label} tournaments${keywords.length ? ` for ${keywords.join(", ")}` : ""}`,
        input: { monitorId: id },
      },
      `tournament-monitor:${id}`,
      true,
    );
    const monitor: Monitor = {
      id,
      taskId: task.id,
      title,
      url: "omnipong://tournaments",
      condition: "change",
      value: "",
      intervalMinutes: 120,
      status: "active",
      nextCheckAt: date(),
      checks: 0,
      kind: "tournament",
      ...(region ? { region } : {}),
      keywords,
    };
    await this.db.insertIfAbsent(owner, "monitors", monitor);
    await this.activateMonitor(owner, monitor);
    return monitor;
  }
  async refreshIdeas(owner: string) {
    const w = await this.workspace.snapshot(owner);
    const sentIds = new Set(
      w.mail.filter((mail) => /^Sent\b/i.test(mail.label)).map((mail) => mail.id),
    );
    const completedSources = new Set(
      (await this.db.listByStatus<AgentTask>(owner, "tasks", "succeeded"))
        .filter((task) => typeof task.input.messageId === "string")
        .map((task) => `${task.kind}:${task.input.messageId}`),
    );
    const obsolete = (kind: AgentTask["kind"], messageId: unknown) =>
      typeof messageId === "string" &&
      (sentIds.has(messageId) || completedSources.has(`${kind}:${messageId}`));
    // Retire earlier suggestions as well as preventing new duplicates. A concurrent
    // acceptance wins its own compare-and-swap and is never overwritten here.
    for (const idea of await this.db.listByStatus<Idea>(owner, "ideas", "new"))
      if (obsolete(idea.kind, idea.input.messageId))
        await this.db.compareAndSwap(
          owner,
          "ideas",
          idea.id,
          { status: "new" },
          { status: "dismissed" },
        );
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("document", m.id) &&
          m.attachments.length &&
          /form|permission|complete|fill|sign/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      const id = hash(`document:${mail.id}:${mail.body}`);
      const idea: Idea = {
        id,
        title: `I can help with ${mail.subject}`,
        reason: `${mail.sender} sent a document that may need your attention. I can prepare it and a reply for your review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Help complete the PDF from “${mail.subject}” and prepare a reply for review.`,
        kind: "document",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      };
      await this.db.insertIfAbsent(owner, "ideas", idea);
    }
    for (const mail of w.mail
      .filter(
        (m) =>
          !obsolete("agent", m.id) &&
          /coffee|meet|available|schedule/i.test(`${m.subject} ${m.body}`),
      )
      .slice(0, 5)) {
      await this.db.insertIfAbsent(owner, "ideas", {
        id: hash(`coordination:${mail.id}`),
        title: `I can help coordinate ${mail.subject}`,
        reason: `${mail.sender} mentioned getting together. I can check your calendar and prepare a response for review.`,
        evidence: [this.mailEvidence(mail)],
        prompt: `Review the email “${mail.subject}”, check my calendar, and propose a next step. Ask me about missing preferences before preparing a reply.`,
        kind: "agent",
        input: { messageId: mail.id },
        status: "new",
        createdAt: date(),
      } satisfies Idea);
    }
    for (const goal of await this.db.listByStatus<Goal>(owner, "goals", "active"))
      if (!goal.milestones.length) {
        const id = hash(`goal:${goal.id}:${goal.description}`);
        await this.db.insertIfAbsent(owner, "ideas", {
          id,
          title: `Let's make a plan for ${goal.title}`,
          reason: "This goal has no milestones yet. A concrete plan will give it a next step.",
          evidence: [{ id: goal.id, kind: "user", title: goal.title, excerpt: goal.description }],
          prompt: `Create an actionable plan for ${goal.title}. ${goal.description}`,
          kind: "plan",
          input: { goalId: goal.id },
          status: "new",
          createdAt: date(),
        } satisfies Idea);
      }
    await this.ensure(owner);
    await this.db.compareAndSwap(owner, "agent-settings", "identity", {}, { lastIdeasAt: date() });
    return this.db.list<Idea>(owner, "ideas");
  }
  async decideIdea(owner: string, id: string, action: "accept" | "dismiss", prompt?: string) {
    let idea = await this.db.get<Idea>(owner, "ideas", id);
    if (!idea) throw new AppError("Idea not found", 404);
    if (idea.status === "dismissed" || (idea.status === "accepted" && action === "dismiss"))
      return idea;
    if (action === "dismiss")
      return this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        { status: "dismissed" },
      );
    if (idea.status === "new") {
      // A task already working on (or done with) the same email is opened instead of copied.
      const { kind, input } = idea;
      const handling =
        typeof input.messageId === "string"
          ? (await this.db.list<AgentTask>(owner, "tasks")).find(
              (task) =>
                task.kind === kind &&
                task.input.messageId === input.messageId &&
                task.status !== "failed" &&
                task.status !== "cancelled",
            )
          : undefined;
      if (handling)
        return (
          (await this.db.compareAndSwap<Idea>(
            owner,
            "ideas",
            id,
            { status: "new" },
            { status: "accepted", taskId: handling.id },
          )) ?? this.db.get<Idea>(owner, "ideas", id)
        );
      const claimed = await this.db.compareAndSwap<Idea>(
        owner,
        "ideas",
        id,
        { status: "new" },
        {
          status: "accepted",
          taskId: hash(`task:idea:${id}`),
          prompt: prompt ?? idea.prompt,
        },
      );
      idea = claimed ?? (await this.db.get<Idea>(owner, "ideas", id));
      if (idea?.status !== "accepted") return idea;
    }
    if (idea.taskId && (await this.db.get(owner, "tasks", idea.taskId))) return idea;
    const goalId =
      typeof idea.input.goalId === "string"
        ? idea.input.goalId
        : (
            await this.createGoal(
              owner,
              { title: idea.title, description: idea.reason },
              hash(`idea-goal:${id}`),
            )
          ).id;
    const task = await this.createTask(
      owner,
      {
        title: idea.title,
        prompt: idea.prompt,
        kind: idea.kind,
        input: idea.input,
        goalId,
      },
      `idea:${id}`,
    );
    await this.db.compareAndSwap(
      owner,
      "ideas",
      id,
      { status: "new" },
      { status: "accepted", taskId: task.id },
    );
    return this.db.get<Idea>(owner, "ideas", id);
  }
  async notify(owner: string, title: string, body: string, taskId?: string, key?: string) {
    const value: AgentNotification = {
      id: key ? hash(key) : randomUUID(),
      taskId,
      title,
      body,
      createdAt: date(),
      read: false,
    };
    await this.db.insertIfAbsent(owner, "notifications", value);
  }
  mailEvidence(mail: Mail): Evidence {
    return { id: mail.id, kind: "mail", title: mail.subject, excerpt: mail.body.slice(0, 400) };
  }
  async artifact(
    owner: string,
    task: AgentTask,
    kind: AgentArtifact["kind"],
    title: string,
    summary: string,
    data: Record<string, unknown>,
    key: string = kind,
  ) {
    const value: AgentArtifact = {
      id: hash(`${task.id}:${key}`),
      taskId: task.id,
      kind,
      title,
      summary,
      data,
      createdAt: date(),
    };
    await this.db.put(owner, "agent-artifacts", value);
    return value;
  }
  async prepare(
    owner: string,
    task: AgentTask,
    input: ProposalInput,
    key: string,
    context: TaskContext,
  ) {
    await context.guard();
    // Google actions are bound to the connection captured when the task
    // started; a table-tennis registration is not, so it does not gate on it.
    if (input.kind !== "omnipong.signup") {
      const connection = await this.workspace.connection(owner);
      if (connection?.id !== task.state.connectionId)
        throw new AppError(
          "Google connection changed during this task. Start a new task using the current account.",
          409,
        );
    }
    const proposal = await this.actions.propose(owner, input, `${task.id}:${key}`, task.id);
    if (proposal.status === "succeeded") return proposal;
    if (proposal.status !== "awaiting_review" && proposal.status !== "executing")
      throw new AppError(
        `Reviewed action ${proposal.status}: ${proposal.error ?? "No further action was taken"}`,
        409,
      );
    try {
      await context.checkpoint({ actionId: proposal.id });
    } catch (error) {
      const current = await this.db.get<AgentTask>(owner, "tasks", task.id);
      if (
        proposal.status === "awaiting_review" &&
        (current?.status === "paused" || current?.status === "cancelled")
      )
        await this.actions.decide(owner, proposal.id, proposal.hash, "deny");
      throw error;
    }
    if (proposal.status === "awaiting_review")
      await context.event(
        "approval",
        proposal.title,
        `Review prepared for ${proposal.account ?? "the connected account"}`,
      );
    return proposal;
  }
  /**
   * Runs the real OmniPong registration for an approved `omnipong.signup`
   * proposal and returns a receipt. This is only ever reached through the
   * reviewed-action executor after a human approval; approval is never derived
   * from chat or model input.
   */
  async executeApprovedSignup(data: TournamentSignupInput): Promise<string> {
    // Defense in depth: re-check the operator flag at execution time. A proposal
    // prepared while real signup was enabled can therefore never register after
    // the flag is turned off (for example, a direct /api/actions approval or a
    // process that restarted with the flag unset).
    if (!this.config.omnipongAllowRealSignup)
      throw new Error(
        "Real tournament signup is disabled on this server (OMNIPONG_ALLOW_REAL_SIGNUP is not true). No registration was made.",
      );
    const events = data.events ?? [];
    const result = await this.omnipong.runAction("signup", {
      title: data.title,
      ...(events.length ? { events } : {}),
    });
    const record =
      result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
    const status = typeof record?.status === "string" ? record.status : undefined;
    const message = typeof record?.message === "string" ? record.message : undefined;
    if (status === "error")
      throw new Error(message ?? `Tournament registration for “${data.title}” failed`);
    const selectedRaw = record?.events_selected;
    const selected = Array.isArray(selectedRaw) ? selectedRaw.map(String) : events;
    const chosen = selected.length ? ` Events: ${selected.join(", ")}.` : "";
    return `Registered for “${data.title}”.${message ? ` ${message}.` : ""}${chosen}`;
  }
  /**
   * Dry-run preview for `signup_tournament`: reads the owner's area tournaments
   * and returns what a registration WOULD enter. It never registers anyone and
   * is the only behavior unless real signup is explicitly enabled on the server.
   */
  async previewSignup(data: TournamentSignupInput) {
    const provided = data.events ?? [];
    let tournament: Record<string, unknown> | undefined;
    let events = provided;
    try {
      const list = await this.omnipong.getTournaments();
      tournament = list.find(
        (item) =>
          typeof item.title === "string" &&
          item.title.trim().toLowerCase() === data.title.trim().toLowerCase(),
      );
      if (!events.length && tournament && Array.isArray(tournament.events))
        events = (tournament.events as unknown[])
          .map((event) =>
            event && typeof event === "object"
              ? (event as Record<string, unknown>).name
              : undefined,
          )
          .filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
          .slice(0, 50);
    } catch {
      // The preview must still work offline; it just cannot enrich the entry.
    }
    return {
      mode: "dry_run" as const,
      realSignupEnabled: false as const,
      registered: false,
      wouldRegister: {
        title: data.title,
        events,
        // With no events named or matched, the service's own matcher would pick
        // events at registration time; this preview never invents them.
        eventsChosen: events.length > 0,
      },
      tournament: tournament
        ? {
            title: tournament.title,
            date: tournament.date_range ?? tournament.date,
            location: tournament.city_state ?? tournament.location,
            url: tournament.url,
          }
        : null,
      note: "Dry run: nobody was registered. Real signup is disabled on this server (OMNIPONG_ALLOW_REAL_SIGNUP is not true). A real registration would also require the owner's separate approval in the native app.",
    };
  }
  /**
   * `GET /api/agent/companion`: the owner's "Your computer" state. Read-only
   * and owner-scoped. Never throws for a relay that is down — an unreachable
   * relay is reported as reachable:false so the UI and coach can say so.
   */
  async companionStatus(owner: string) {
    if (!this.relay.configured)
      return {
        configured: false,
        reachable: false,
        owner,
        paired: false,
        connected: false,
        gates: [] as { gate_id: string; kind: string; hint: string; url_host: string }[],
      };
    try {
      const status = await this.relay.status(owner);
      return { configured: true, reachable: true, ...status };
    } catch (error) {
      return {
        configured: true,
        reachable: false,
        owner,
        paired: false,
        connected: false,
        gates: [] as { gate_id: string; kind: string; hint: string; url_host: string }[],
        error: error instanceof Error ? error.message : "Relay unreachable",
      };
    }
  }
  /**
   * `POST /api/agent/companion/pairing`: mint (or rotate) the owner's pairing
   * token at the relay and return the command to run on their own computer. The
   * token is a secret and is returned exactly once here.
   */
  async startCompanionPairing(owner: string) {
    if (!this.relay.configured)
      throw new AppError(
        "The relay is not configured on this server (RELAY_URL is unset), so a computer cannot be paired yet.",
        503,
      );
    try {
      return await this.relay.startPairing(owner);
    } catch (error) {
      throw new AppError(
        error instanceof Error ? error.message : "Could not start pairing",
        error instanceof RelayError && error.status === 503 ? 503 : 502,
      );
    }
  }
  /** `DELETE /api/agent/companion`: revoke the owner's pairing at the relay. */
  async unpairCompanion(owner: string) {
    if (!this.relay.configured) return { owner, revoked: false };
    try {
      return await this.relay.unpair(owner);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "Could not unpair", 502);
    }
  }
  /** `POST /api/agent/companion/gates/:id/clear`: "I handled it, continue". */
  async clearCompanionGate(owner: string, gateId: string) {
    if (!this.relay.configured)
      throw new AppError("The relay is not configured on this server", 503);
    try {
      return await this.relay.clearGate(owner, gateId);
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : "Could not clear the gate", 502);
    }
  }
  private async execute(
    owner: string,
    task: AgentTask,
    context: TaskContext,
  ): Promise<Partial<AgentTask>> {
    await context.event(
      "status",
      task.attempts === 1 ? "Started working" : "Resumed work",
      task.prompt,
    );
    if (task.actionId) {
      const action = await this.db.get<ActionProposal>(owner, "actions", task.actionId);
      if (!action) throw new Error("The linked review could not be found");
      if (action.status === "succeeded") {
        await context.event("result", "Approved action completed", action.result);
        if (task.kind === "document")
          return this.finish(task, context, action.result ?? "Reply completed");
        task = await context.checkpoint({
          state: { ...task.state, approvalResult: action.result },
          actionId: null,
        });
      } else if (action.status === "denied" || action.status === "cancelled") {
        // A human saying no is the system working, not a failure. Close the task
        // cleanly with a receipt that says exactly what did not happen.
        return {
          status: "cancelled",
          result: "You declined this action. Nothing was sent or registered.",
          error: null,
          plan: task.plan.map((step) =>
            step.status === "running" || step.status === "pending"
              ? { ...step, status: "failed" as const, detail: "Declined by you" }
              : step,
          ),
        };
      } else if (action.status !== "awaiting_review" && action.status !== "executing")
        throw new Error(
          `Reviewed action ${action.status}: ${action.error ?? "No further action was taken"}`,
        );
      else return { status: "waiting_approval" };
    }
    if (task.kind === "document") return this.document(owner, task, context);
    if (task.kind === "scout") return this.scout(owner, task, context);
    if (task.kind === "sync") return this.syncLeagueTask(owner, task, context);
    if (task.kind === "monitor") {
      try {
        return await this.observe(owner, task, context);
      } catch (error) {
        if (error instanceof LostLeaseError || context.signal.aborted) throw error;
        await context.guard();
        const failures = Number(task.state.failures ?? 0) + 1;
        // Each streak of failures (after a success or a resume) gets its own alerts.
        const failureStreak = Number(task.state.failureStreak ?? 0) + (failures === 1 ? 1 : 0);
        const detail = error instanceof Error ? error.message : "Page check failed";
        const nextCheckAt = new Date(
          Date.now() + Math.min(60, 2 ** failures) * 60000,
        ).toISOString();
        await this.db.compareAndSwap(
          owner,
          "monitors",
          String(task.input.monitorId),
          { status: "active" },
          { error: detail, nextCheckAt },
        );
        await context.event(
          "error",
          failures >= 5 ? "Watch paused after repeated failures" : "Check failed; retry scheduled",
          detail,
        );
        return {
          status: failures >= 5 ? "paused" : "scheduled",
          error: detail,
          nextRunAt: nextCheckAt,
          state: {
            ...task.state,
            failures,
            resumingMonitor: false,
            failureStreak,
            notice: {
              title: "Watch needs attention",
              body: detail,
              key: `watch-error:${task.id}:${failureStreak}:${failures >= 5 ? "paused" : "retry"}`,
            },
          },
        };
      }
    }
    if (task.kind === "finance") {
      await context.event("step", "Analyzing the imported transactions");
      const csv = z.string().parse(task.input.csv);
      const data = analyzeSpending(csv);
      const artifact = await this.artifact(
        owner,
        task,
        "finance",
        "Spending tracker",
        `${data.count} transactions · ${data.spending.toFixed(2)} spent`,
        data,
      );
      task = await context.checkpoint({
        artifactIds: [artifact.id],
        evidence: [
          {
            id: task.id,
            kind: "user",
            title: "Your transaction CSV",
            excerpt: `${data.count} rows; ${data.period.from} through ${data.period.to}`,
          },
        ],
      });
      return this.finish(task, context, artifact.summary);
    }
    return executeModelTask(this, owner, task, context);
  }
  async finish(task: AgentTask, context: TaskContext, result: string) {
    await context.guard();
    await context.event("result", "Work completed", result);
    return {
      status: "succeeded" as const,
      result,
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" as const })),
    };
  }
  private async publishOutcome(owner: string, saved: AgentTask) {
    const task = await this.getTask(owner, saved.id);
    if (task.status === "succeeded") {
      // A scout's own notifications are the new tournaments it found; a generic
      // "task done" notice every day would bury them and break the dedupe rule.
      if (task.kind !== "scout")
        await this.notify(
          owner,
          task.title,
          task.result ?? "Work completed",
          task.id,
          `task-done:${task.id}`,
        );
      if (task.goalId && !task.milestoneId) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const goal = await this.db.get<Goal>(owner, "goals", task.goalId);
          if (!goal || goal.milestones.some((m) => m.id === task.id)) break;
          if (
            await this.db.compareAndSwap(
              owner,
              "goals",
              goal.id,
              { milestones: goal.milestones },
              {
                milestones: [...goal.milestones, { id: task.id, title: task.title, done: true }],
              },
            )
          )
            break;
        }
      }
    } else if (task.status === "failed") {
      await this.notify(
        owner,
        "Task needs attention",
        task.error ?? task.title,
        task.id,
        `task-error:${task.id}:${task.attempts}`,
      );
    } else if (task.status === "waiting_input") {
      await this.notify(
        owner,
        "Your details are needed",
        task.question ?? task.title,
        task.id,
        `input:${task.id}:${hash(task.question ?? "")}`,
      );
    } else if (task.status === "waiting_approval") {
      await this.notify(
        owner,
        "Ready for your review",
        task.title,
        task.id,
        `review:${task.actionId}`,
      );
    }
    const notice = z
      .object({ title: z.string(), body: z.string(), key: z.string() })
      .safeParse(task.state.notice);
    if ((task.status === "scheduled" || (task.status === "paused" && task.error)) && notice.success)
      await this.notify(owner, notice.data.title, notice.data.body, task.id, notice.data.key);
    // A watch pauses after repeated failures only once that task outcome has committed.
    if (task.kind === "monitor" && task.status === "paused" && task.error)
      await this.db.compareAndSwap(
        owner,
        "monitors",
        String(task.input.monitorId),
        { status: "active", error: task.error },
        { status: "paused" },
      );
  }
  private async document(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    let source = task.state.source as { mail: Mail; fileId: string } | undefined;
    if (!source) {
      const w = await this.workspace.snapshot(owner);
      const mail = w.mail.find((m) => m.id === task.input.messageId);
      if (!mail) throw new Error("Choose a current email with a PDF attachment to start this task");
      const ref = mail.attachments[0];
      if (!ref) throw new Error("This email has no PDF attachment");
      await ctx.guard();
      let file: Artifact;
      try {
        file = await this.files.get(owner, ref);
      } catch (error) {
        if (!(error instanceof AppError && error.status === 404)) throw error;
        file = await this.workspace.importAttachment(owner, ref);
      }
      source = { mail, fileId: file.id };
      task = await ctx.checkpoint({
        state: { ...task.state, source },
        evidence: [this.mailEvidence(mail)],
        plan: task.plan.map((s, i) => ({ ...s, status: i === 0 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Found the document", file.name);
    }
    const fields = z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional()
      .parse(task.input.fields);
    if (!fields || !Object.keys(fields).length) {
      const file = await this.files.get(owner, source.fileId);
      const names = file.fields
        ?.filter((f) => f.type !== "unsupported")
        .map((f) => f.name)
        .join(", ");
      if (!names)
        throw new Error(
          "This PDF has no supported fillable fields. Open it in Files to review it.",
        );
      return {
        status: "waiting_input",
        question: `Enter the form values you want to use. Supported fields: ${names}. The original PDF will stay intact.`,
        state: {
          ...task.state,
          source,
          missingFields: file.fields?.filter((f) => f.type !== "unsupported"),
        },
      };
    }
    let filledId = typeof task.state.filledId === "string" ? task.state.filledId : undefined;
    if (!filledId) {
      await ctx.guard();
      const filled = await this.files.fill(owner, source.fileId, fields, `document:${task.id}`);
      filledId = filled.id;
      task = await ctx.checkpoint({
        state: { ...task.state, source, filledId },
        artifactIds: [filledId],
        plan: task.plan.map((s, i) => ({ ...s, status: i <= 1 ? "succeeded" : "pending" })),
      });
      await ctx.event("step", "Saved a filled copy", filled.name);
    }
    const input: ProposalInput = {
      kind: "email.send",
      data: {
        to: [source.mail.from],
        cc: [],
        bcc: [],
        subject: /^re:/i.test(source.mail.subject)
          ? source.mail.subject
          : `Re: ${source.mail.subject}`,
        body:
          typeof task.input.reply === "string"
            ? task.input.reply
            : "Hello,\n\nPlease find the completed form attached.\n\nThank you.",
        attachmentIds: [filledId],
        threadId: source.mail.threadId,
        replyToMessageId: source.mail.id,
      },
    };
    const proposal = await this.prepare(owner, task, input, "document-reply", ctx);
    return {
      status: "waiting_approval",
      actionId: proposal.id,
      plan: task.plan.map((s, i) => ({
        ...s,
        status: i < 3 ? "succeeded" : i === 3 ? "waiting" : "pending",
      })),
    };
  }
  private async observe(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    const monitor = await this.db.get<Monitor>(owner, "monitors", String(task.input.monitorId));
    if (!monitor) throw new Error("Monitor not found");
    if (monitor.status !== "active")
      return { status: monitor.status === "paused" ? "paused" : "cancelled" };
    if (monitor.kind === "tournament") return this.observeTournaments(owner, task, monitor, ctx);
    let observation: { url: string; title: string; text: string; sessionId?: string };
    if (monitor.url === "sample://availability") {
      if (this.config.mode !== "sample") throw new Error("Sample source unavailable");
      const page = await this.db.get<{ text: string }>(owner, "sample-pages", "availability");
      observation = {
        url: monitor.url,
        title: "Sample dinner availability",
        text: page?.text ?? "No tables available. Check again later.",
      };
    } else {
      await ctx.guard();
      observation = await this.browser.observe(
        owner,
        monitor.url,
        typeof task.state.sessionId === "string" ? task.state.sessionId : undefined,
        ctx.signal,
      );
    }
    const text = observation.text.replace(/\s+/g, " ").trim();
    const currentHash = hash(text);
    const previousHash =
      typeof task.state.lastHash === "string" ? task.state.lastHash : monitor.lastHash;
    // Collapse whitespace in the watched text the same way as in the page text, so a
    // trailing space from a phone keyboard or a line break in the value still matches.
    const wanted = monitor.value.replace(/\s+/g, " ").trim().toLowerCase();
    const matched =
      monitor.condition === "change"
        ? Boolean(previousHash && previousHash !== currentHash)
        : monitor.condition === "contains"
          ? text.toLowerCase().includes(wanted)
          : this.matchesPrice(text, Number(monitor.value));
    const previouslyMatched = Boolean(task.state.matched);
    // For change watches, keep the page lines and a relative-time-free fingerprint of the whole text.
    const change = monitor.condition === "change";
    const lines = change ? pageLines(observation.text) : [];
    const timelessHash = change ? hash(withoutRelativeTimes(text)) : undefined;
    const savedPage =
      matched && change
        ? await this.db.get<MonitorPage>(owner, "monitor-pages", monitor.id)
        : undefined;
    // Saved lines can run ahead of a lost task outcome; use them only for the committed baseline.
    const baseline = savedPage?.hash === previousHash ? savedPage : undefined;
    // Only relative times changed anywhere on the page ("3 minutes ago"): keep watching quietly.
    const quiet = Boolean(baseline?.timelessHash && baseline.timelessHash === timelessHash);
    const shouldNotify =
      matched && !quiet && (monitor.condition === "change" || !previouslyMatched);
    const diff = baseline && shouldNotify ? diffPage(baseline.lines, lines) : undefined;
    // Empty when the change is past the saved lines; the alert then quotes the page instead.
    const changes = diff ? describePageDiff(diff) : "";
    // A notification-worthy observation is a new event, even when the page text is
    // identical to an earlier one (a change back to a seen state, or a condition that
    // cleared and reappeared). Commit its sequence with the outcome so publication
    // retries still deduplicate on the same saved notice key.
    const alertSequence = Number(task.state.alertSequence ?? 0) + (shouldNotify ? 1 : 0);
    const nextCheckAt = new Date(Date.now() + monitor.intervalMinutes * 60000).toISOString();
    await ctx.guard();
    // Worker lease is checked before each publication; monitor control also invalidates that lease.
    const savedMonitor = await this.db.compareAndSwap(
      owner,
      "monitors",
      monitor.id,
      { status: "active", checks: monitor.checks },
      {
        checks: monitor.checks + 1,
        lastCheckedAt: date(),
        lastHash: currentHash,
        lastValue: text.slice(0, 1000),
        nextCheckAt,
        error: null,
      },
    );
    if (!savedMonitor) throw new LostLeaseError();
    if (change)
      await this.db.put(owner, "monitor-pages", {
        id: monitor.id,
        hash: currentHash,
        timelessHash,
        lines,
      });
    await ctx.event(
      "observation",
      previousHash ? "Checked for changes" : "Saved the first observation",
      text.slice(0, 1000),
    );
    if (shouldNotify) {
      await ctx.guard();
      await ctx.event("result", "A meaningful change was found", changes || text.slice(0, 500));
    }
    const count = diff ? countPageDiff(diff) : "";
    return {
      status: "scheduled",
      nextRunAt: nextCheckAt,
      result: shouldNotify
        ? count
          ? `Change found: ${count}. A notification is ready.`
          : "Change found. A notification is ready."
        : "Watching. I'll check again on schedule.",
      state: {
        ...task.state,
        sessionId: observation.sessionId,
        lastHash: currentHash,
        resumingMonitor: false,
        matched,
        alertSequence,
        failures: 0,
        notice: shouldNotify
          ? {
              title: monitor.title,
              body: changes
                ? `Changed at ${observation.url}\n${changes}`
                : `Condition met at ${observation.url}: ${text.slice(0, 240)}`,
              key: `monitor:${monitor.id}:${alertSequence}:${currentHash}`,
            }
          : null,
      },
      error: null,
      evidence: [
        {
          id: monitor.id,
          kind: "web",
          title: observation.title,
          url: observation.url,
          excerpt: text.slice(0, 600),
        },
      ],
      plan: task.plan.map((s) => ({ ...s, status: "succeeded" })),
    };
  }
  /**
   * One deterministic league sync for the dashboard button.
   *
   * No model turn: the league URL and owner name come from the saved profile, so
   * the result is the same whoever clicks and wherever they click it. The Python
   * service does the paging/completeness work and is idempotent, which makes a
   * retry (or two racing clicks) harmless.
   */
  private async syncLeagueTask(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    await ctx.guard();
    const profile = await this.getProfile(owner);
    const leagueUrls = (profile?.leagueUrls ?? []).filter(Boolean);
    if (leagueUrls.length === 0)
      throw new Error(
        "No league URL is saved for this owner yet. Add one in Settings, then press Sync again.",
      );
    await ctx.event("status", "Pulling league matches", `${leagueUrls.length} league page(s)`);
    await ctx.checkpoint({
      plan: task.plan.map((step, index) => ({
        ...step,
        status: index === 0 ? "succeeded" : index === 1 ? "running" : "pending",
      })),
    });
    const result = await this.omnipong.syncLeague({
      leagueUrls,
      owner: profile?.displayName,
      allMatches: true,
    });
    await ctx.guard();
    const seen = Number(result.owner_matches ?? 0);
    const inserted = Number(result.inserted ?? 0);
    const updated = Number(result.updated ?? 0);
    const warnings = Array.isArray(result.errors) ? result.errors.length : 0;
    const summary = `Synced ${seen} match${seen === 1 ? "" : "es"} · ${inserted} new, ${updated} updated${
      warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""
    }`;
    await this.notify(owner, "League sync finished", summary, task.id, `sync:${task.id}`);
    return {
      status: "succeeded",
      result: summary,
      error: null,
      evidence: [
        ...task.evidence,
        {
          id: randomUUID(),
          kind: "web",
          title: "League sync",
          excerpt: summary,
        },
      ],
      plan: task.plan.map((step) => ({ ...step, status: "succeeded" })),
      state: { ...task.state, lastSyncAt: date(), seen, inserted, updated },
    };
  }
  /**
   * One pass of the always-on daily scout. Reads the owner's area list, diffs it
   * against the persisted `seenTournamentIds` ledger, announces each genuinely
   * new tournament once, then records the outcome and the next daily run.
   *
   * Dedupe is exact in two independent places: the ledger check here, and the
   * per-identity notification key (`notify` inserts by id, so even two racing
   * runs can never announce the same tournament twice).
   */
  private async scout(
    owner: string,
    task: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    await ctx.guard();
    const area = await this.ownerArea(owner);
    const label = areaLabel(area);
    let rows: Record<string, unknown>[];
    try {
      // No region argument of our own: the profile's area (or the service's
      // configured area when the profile has none) decides what "my area" is.
      rows = await this.omnipong.getTournaments(resolveTournamentRegion(undefined, area));
    } catch (error) {
      // Advance the schedule first: a service outage must not wedge the daily
      // loop, so the next occurrence still runs.
      await this.advanceScout(owner);
      throw new Error(
        `The tournament scout could not read ${label} tournaments: ${
          error instanceof Error ? error.message : "the service is unavailable"
        }`,
      );
    }
    await ctx.guard();
    const candidates = this.tournamentCandidates(narrowTournaments(rows, area));
    const { seenTournamentIds } = await this.readScout(owner);
    const seen = new Set(seenTournamentIds);
    const fresh = candidates.filter((tournament) => !seen.has(tournament.id));
    await ctx.event(
      "observation",
      fresh.length ? "Found new tournaments" : "Checked for new tournaments",
      fresh.length
        ? fresh.map((tournament) => tournament.title).join(", ")
        : `${candidates.length} listing(s), none new`,
    );
    for (const tournament of fresh) {
      await ctx.guard();
      await this.notify(
        owner,
        "New tournament found",
        `New tournament in ${label}: ${tournament.title}`,
        task.id,
        `scout:${tournament.id}`,
      );
    }
    // A new-tournament alert is also worth a text, but only when the owner has
    // a number on file and the install allows it. Best-effort by design: the
    // domain service answers `sent:false` with a reason and never throws, and an
    // SMS outage must not fail the scout run that triggered it.
    let smsNote: string | undefined;
    if (fresh.length > 0 && this.config.smsAlertsEnabled) {
      try {
        const sent = await this.omnipong.sendSms(
          `OpenPong: ${fresh.length} new tournament${fresh.length === 1 ? "" : "s"} in ${label} — ${fresh
            .slice(0, 2)
            .map((tournament) => tournament.title)
            .join("; ")}${fresh.length > 2 ? ` +${fresh.length - 2} more` : ""}`,
        );
        if (sent.sent !== true) {
          smsNote = typeof sent.detail === "string" ? sent.detail : "Text alert was not sent.";
        }
      } catch (error) {
        smsNote = error instanceof Error ? error.message : "Text alert failed.";
      }
    }
    // Re-read so a setting change made while the fetch ran (for example the
    // owner turning the scout off) is preserved rather than overwritten.
    const latest = await this.readScout(owner);
    const ledger = [...new Set([...latest.seenTournamentIds, ...fresh.map((t) => t.id)])].slice(
      -MAX_SEEN_TOURNAMENTS,
    );
    const result = {
      found: candidates.length,
      newCount: fresh.length,
    };
    await this.db.put<ScoutSettings>(owner, "agent-settings", {
      ...latest,
      nextRunAt: nextScoutRun(latest.hour),
      lastRunAt: date(),
      lastResult: result,
      seenTournamentIds: ledger,
    });
    if (smsNote) await ctx.event("observation", "Text alert skipped", smsNote);
    await ctx.event(
      "result",
      fresh.length ? "New tournaments are ready to review" : "Nothing new today",
      fresh.length
        ? fresh.map((tournament) => tournament.title).join(", ")
        : `${candidates.length} listing(s) already seen`,
    );
    return {
      status: "succeeded",
      result: fresh.length
        ? `New tournaments found: ${fresh.map((t) => t.title).join(", ")}. A notification is ready.`
        : "No new tournaments today. I'll check again tomorrow.",
      state: { ...task.state, ...result },
      plan: task.plan.map((step) => ({ ...step, status: "succeeded" })),
      error: null,
    };
  }
  /** Move the next daily run forward without claiming a successful run. */
  private async advanceScout(owner: string) {
    const latest = await this.readScout(owner);
    await this.db.put<ScoutSettings>(owner, "agent-settings", {
      ...latest,
      nextRunAt: nextScoutRun(latest.hour),
    });
  }
  /**
   * Stable identities for tournament rows. OmniPong's `source_id` is the real
   * row key, so it wins; stored URLs, then title+date+location, are fallbacks.
   * A row with no stable identity is skipped rather than announced repeatedly.
   */
  private tournamentCandidates(list: unknown): { id: string; title: string }[] {
    if (!Array.isArray(list)) return [];
    const rows = new Map<string, string>();
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const text = (value: unknown) => (value == null ? "" : String(value).trim());
      const title = text(row.title);
      const identity =
        [row.source_id, row.id, row.tournament_id, row.slug, row.url, row.omnipong_url]
          .map(text)
          .find(Boolean) ||
        [title, text(row.date_range) || text(row.date), text(row.city_state) || text(row.location)]
          .filter(Boolean)
          .join("|");
      if (!identity) continue;
      if (!rows.has(identity)) rows.set(identity, title || identity);
    }
    return [...rows].map(([id, title]) => ({ id, title }));
  }
  /**
   * One pass of a recurring tournament watch. Runs OmniPong's `check` scout and
   * raises one notification per newly-appearing matching tournament. A title is
   * announced once: the per-title notification key plus the task's `seen` ledger
   * keep re-runs idempotent even when a lease is lost mid-pass.
   */
  private async observeTournaments(
    owner: string,
    task: AgentTask,
    monitor: Monitor,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    await ctx.guard();
    // Prefer the read-only tournament list: it works from the service's database
    // with no browser or stored credentials. Only fall back to OmniPong's live
    // `check` scout (which needs a signed-in browser) when that read fails.
    let candidates: string[];
    try {
      // The monitor's region is whatever the owner set (or their profile's
      // region); with neither, the query is omitted so the service applies
      // its own configuration instead of a default from this server.
      const area = await this.ownerArea(owner);
      const tournaments = await this.omnipong.getTournaments(
        resolveTournamentRegion(monitor.region, area),
      );
      candidates = this.tournamentNames(narrowTournaments(tournaments, area));
    } catch {
      await ctx.guard();
      const result = await this.omnipong.runAction("check", { dry_run: false, deep: false });
      candidates = this.tournamentTitles(result);
    }
    const seen = new Set<string>(
      Array.isArray(task.state.seenTournaments)
        ? (task.state.seenTournaments as unknown[]).filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    );
    const keywords = (monitor.keywords ?? []).map((keyword) => keyword.toLowerCase());
    const fresh = candidates.filter(
      (title) =>
        !seen.has(title) &&
        (keywords.length === 0 ||
          keywords.some((keyword) => title.toLowerCase().includes(keyword))),
    );
    await ctx.guard();
    const label = monitor.region ? `${monitor.region} area` : "your area";
    for (const title of fresh) {
      seen.add(title);
      await this.notify(
        owner,
        monitor.title,
        `New ${label} tournament: ${title}`,
        task.id,
        `tournament:${monitor.id}:${hash(title)}`,
      );
    }
    const nextCheckAt = new Date(Date.now() + monitor.intervalMinutes * 60000).toISOString();
    const savedMonitor = await this.db.compareAndSwap(
      owner,
      "monitors",
      monitor.id,
      { status: "active", checks: monitor.checks },
      {
        checks: monitor.checks + 1,
        lastCheckedAt: date(),
        lastValue: fresh.join(" | ").slice(0, 1000),
        nextCheckAt,
        error: null,
      },
    );
    if (!savedMonitor) throw new LostLeaseError();
    await ctx.event(
      "observation",
      fresh.length ? "Found new tournaments" : "Checked for new tournaments",
      fresh.length ? fresh.join(", ") : `${candidates.length} listing(s), none new`,
    );
    return {
      status: "scheduled",
      nextRunAt: nextCheckAt,
      result: fresh.length
        ? `New tournaments found: ${fresh.join(", ")}. A notification is ready.`
        : "Watching. I'll check again on schedule.",
      state: {
        ...task.state,
        // Keep a bounded ledger so a long-lived watch cannot grow without end.
        seenTournaments: [...seen].slice(-1000),
        resumingMonitor: false,
        failures: 0,
        notice: null,
      },
      error: null,
    };
  }
  /** Titles OmniPong's `check` scout newly announced, deduped and in order. */
  private tournamentTitles(result: unknown): string[] {
    if (!result || typeof result !== "object") return [];
    const notified = (result as Record<string, unknown>).notified;
    if (!Array.isArray(notified)) return [];
    const titles = new Set<string>();
    for (const entry of notified) {
      if (!entry || typeof entry !== "object") continue;
      const title = (entry as Record<string, unknown>).title;
      if (typeof title === "string" && title.trim()) titles.add(title.trim());
    }
    return [...titles];
  }
  /** Titles from the read-only tournament list (array of records with `title`). */
  private tournamentNames(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    const titles = new Set<string>();
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const title = (entry as Record<string, unknown>).title;
      if (typeof title === "string" && title.trim()) titles.add(title.trim());
    }
    return [...titles];
  }
  private matchesPrice(text: string, threshold: number) {
    const matches = [...text.matchAll(/(?:\$|USD)\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)];
    return matches.some((m) => Number(m[1].replace(/,/g, "")) < threshold);
  }
}

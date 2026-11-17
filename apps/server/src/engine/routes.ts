import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type {
  AgentIdentity,
  AgentMemory,
  AgentNotification,
} from "../../../../packages/domain/src/agent.ts";
import { createTaskSchema } from "../../../../packages/domain/src/agent.ts";
import { AppError } from "../errors.ts";
import type { AgentService } from "./service.ts";

const text = z.string().trim().min(1).max(4000);
const memorySchema = z.object({ text, source: z.string().trim().min(1).max(200).optional() });
const goalPatchSchema = z.object({
  status: z.enum(["active", "paused", "completed"]).optional(),
  milestones: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(200),
        done: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
});
/** A manual result the owner reported from the dashboard; the service is idempotent. */
const recordMatchSchema = z.object({
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date like 2026-11-16"),
  opponent_name: z.string().trim().min(1).max(200),
  opponent_rating: z.number().int().min(0).max(4000).optional(),
  result: z.enum(["Win", "Loss"]),
  score_summary: z.string().trim().min(1).max(40).optional(),
  set_scores: z
    .union([
      z.array(z.number().int().min(0).max(99)).min(2).max(60),
      z.string().trim().min(1).max(300),
    ])
    .optional(),
});

export function agentRoutes(service: AgentService): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json(await service.snapshot(c.get("owner"))));
  /**
   * The owner's profile and first-run detection. `onboarded:false` with a null
   * profile is the only signal the app needs to show guided setup; there is no
   * default identity behind it.
   */
  app.get("/profile", async (c) => c.json(await service.profileView(c.get("owner"))));
  /** Validate and store the owner's profile. Invalid input is a 400, never a stored default. */
  app.put("/profile", async (c) =>
    c.json(await service.saveProfile(c.get("owner"), await c.req.json())),
  );
  app.post("/tasks", async (c) => {
    const { requestId, ...input } = createTaskSchema
      .extend({ requestId: z.string().min(1).max(200).optional() })
      .parse(await c.req.json());
    return c.json(await service.createTask(c.get("owner"), input, requestId), 201);
  });
  app.get("/tasks/:id", async (c) =>
    c.json(await service.detail(c.get("owner"), c.req.param("id"))),
  );
  /** Pending and historical action proposals, so any client can show approvals. */
  app.get("/actions", async (c) => c.json(await service.actions.list(c.get("owner"))));
  app.post("/tasks/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
      .parse(await c.req.json());
    return c.json(await service.control(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/tasks/:id/input", async (c) => {
    const body = z
      .object({
        answer: z.string().trim().min(1).max(12000),
        fields: z
          .record(z.string().min(1).max(300), z.union([z.string().max(12000), z.boolean()]))
          .optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.answer(c.get("owner"), c.req.param("id"), body.answer, body.fields),
    );
  });
  app.post("/goals", async (c) =>
    c.json(await service.createGoal(c.get("owner"), await c.req.json()), 201),
  );
  /**
   * Record one match result the owner reported in the dashboard. The Python
   * service derives the winner/loser from its own owner row and dedupes a
   * repeated result, so this is a safe retry: 201 on a new row, 200 when the
   * same row already existed (`created:false`).
   */
  app.post("/matches", async (c) => {
    const body = recordMatchSchema.parse(await c.req.json());
    const saved = await service.omnipong.recordMatch({
      date: body.date,
      opponentName: body.opponent_name,
      opponentRating: body.opponent_rating,
      result: body.result,
      scoreSummary: body.score_summary,
      setScores: body.set_scores,
    });
    return c.json(saved, saved.created === true ? 201 : 200);
  });
  app.post("/goals/:id", async (c) => {
    const body = goalPatchSchema.parse(await c.req.json());
    return c.json(await service.updateGoal(c.get("owner"), c.req.param("id"), body));
  });
  app.post("/goals/:id/milestones/:milestoneId", async (c) => {
    const { done } = z.object({ done: z.boolean() }).parse(await c.req.json());
    return c.json(
      await service.setMilestoneDone(
        c.get("owner"),
        c.req.param("id"),
        c.req.param("milestoneId"),
        done,
      ),
    );
  });
  app.post("/monitors", async (c) =>
    c.json(await service.createMonitor(c.get("owner"), await c.req.json()), 201),
  );
  app.post("/monitors/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "stop", "check"]) })
      .parse(await c.req.json());
    return c.json(await service.controlMonitor(c.get("owner"), c.req.param("id"), action));
  });
  app.post("/ideas/refresh", async (c) => c.json(await service.refreshIdeas(c.get("owner"))));
  /**
   * The always-on daily tournament scout: read the setting, change it (hour is
   * validated 0-23), or queue one run immediately. Every read and write is
   * owner-scoped through the session's owner.
   */
  app.get("/scout", async (c) => c.json(await service.scoutView(c.get("owner"))));
  app.put("/scout", async (c) =>
    c.json(await service.saveScout(c.get("owner"), await c.req.json())),
  );
  app.post("/scout/run", async (c) =>
    c.json({ task: await service.runScoutNow(c.get("owner")) }, 201),
  );
  /**
   * The owner's SMS number for outbound alerts. Stored by the domain service
   * next to the rest of the ledger, so the scout can text without the dashboard
   * ever holding a Twilio secret.
   */
  app.post("/phone", async (c) => {
    const body = z.object({ phoneNumber: z.string().trim().max(40) }).parse(await c.req.json());
    return c.json(await service.omnipong.updatePhone(body.phoneNumber));
  });
  /**
   * Send one text to the owner, used by Settings to prove the wiring works.
   */
  app.post("/phone/test", async (c) => {
    const body = z
      .object({ body: z.string().trim().min(1).max(600).optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await service.omnipong.sendSms(body.body ?? "OpenPong: text alerts are on."));
  });
  /**
   * The dashboard's one-tap sync. Reads the owner's saved league URL, queues a
   * durable task and returns its id so the button can watch it settle.
   */
  app.post("/sync", async (c) =>
    c.json({ taskId: (await service.runSyncNow(c.get("owner"))).id }, 201),
  );
  /**
   * The owner's computer: the relay companion that drives their own browser.
   * Status is a read; pairing mints a one-time code; DELETE revokes it; the
   * gate routes list and clear a pending human login/2FA step. Every route is
   * owner-scoped through the session's owner, so a call can never name another
   * person's computer.
   */
  app.get("/companion", async (c) => c.json(await service.companionStatus(c.get("owner"))));
  app.post("/companion/pairing", async (c) =>
    c.json(await service.startCompanionPairing(c.get("owner")), 201),
  );
  app.delete("/companion", async (c) => c.json(await service.unpairCompanion(c.get("owner"))));
  app.get("/companion/gates", async (c) => {
    const status = await service.companionStatus(c.get("owner"));
    return c.json({ gates: status.gates });
  });
  app.post("/companion/gates/:gateId/clear", async (c) =>
    c.json(await service.clearCompanionGate(c.get("owner"), c.req.param("gateId"))),
  );
  app.post("/ideas/:id", async (c) => {
    const body = z
      .object({
        action: z.enum(["accept", "dismiss"]),
        prompt: z.string().trim().min(1).max(12000).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.decideIdea(c.get("owner"), c.req.param("id"), body.action, body.prompt),
    );
  });
  app.post("/memories", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory: AgentMemory = {
      id: randomUUID(),
      text: body.text,
      source: body.source ?? "You",
      createdAt: new Date().toISOString(),
    };
    return c.json(await service.db.put(c.get("owner"), "memories", memory), 201);
  });
  app.post("/memories/:id", async (c) => {
    const body = memorySchema.parse(await c.req.json());
    const memory = await service.db.compareAndSwap<AgentMemory>(
      c.get("owner"),
      "memories",
      c.req.param("id"),
      {},
      body,
    );
    if (!memory) throw new AppError("Memory not found", 404);
    return c.json(memory);
  });
  app.post("/memories/:id/forget", async (c) => {
    if (!(await service.db.take(c.get("owner"), "memories", c.req.param("id"))))
      throw new AppError("Memory not found", 404);
    return c.json({ ok: true });
  });
  app.post("/identity", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        tone: z.enum(["warm", "concise", "thoughtful"]),
        avatar: z.enum(["sky", "sand", "lilac"]).optional(),
        showChatUpdates: z.boolean().optional(),
      })
      .parse(await c.req.json());
    const owner = c.get("owner");
    await service.ensure(owner);
    const identity = await service.db.compareAndSwap<AgentIdentity>(
      owner,
      "agent-settings",
      "identity",
      {},
      body,
    );
    if (!identity) throw new AppError("Agent identity changed; refresh and try again", 409);
    return c.json(identity);
  });
  app.get("/notifications", async (c) =>
    c.json(await service.db.list<AgentNotification>(c.get("owner"), "notifications")),
  );
  app.post("/notifications/:id/read", async (c) => {
    const notification = await service.db.compareAndSwap<AgentNotification>(
      c.get("owner"),
      "notifications",
      c.req.param("id"),
      {},
      { read: true },
    );
    if (!notification) throw new AppError("Notification not found", 404);
    return c.json(notification);
  });
  app.post("/sample-page", async (c) => {
    if (service.config.mode !== "sample") throw new AppError("Not found", 404);
    const body = z.object({ text: z.string().max(100000) }).parse(await c.req.json());
    await service.db.put(c.get("owner"), "sample-pages", { id: "availability", text: body.text });
    return c.json({ ok: true });
  });
  /**
   * The Pong calendar hub. `GET /status` is safe to poll, `connect` returns the
   * Google OAuth URL or the read-only iCal subscription link, `sync` is
   * best-effort and never throws for one upstream source, and `DELETE` revokes
   * the Google connection and the current feed link.
   */
  app.get("/calendar", async (c) => c.json(await service.calendar.status(c.get("owner"))));
  app.post("/calendar/connect", async (c) =>
    c.json(await service.calendar.connectUrl(c.get("owner"))),
  );
  app.post("/calendar/sync", async (c) => c.json(await service.calendar.syncAll(c.get("owner"))));
  app.delete("/calendar", async (c) => c.json(await service.calendar.disconnect(c.get("owner"))));
  app.post("/calendar/feed/rotate", async (c) =>
    c.json(await service.calendar.rotateFeed(c.get("owner"))),
  );
  return app;
}

import "./config.ts";
import { randomUUID } from "node:crypto";
import { MessageSchema } from "@ag-ui/core";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { getConnInfo } from "@hono/node-server/conninfo";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  calendarRangeSchema,
  emailDraftSchema,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import {
  type Account,
  AccountService,
  LoginRateLimitError,
  type RequestContext,
} from "./accounts.ts";
import { ActionService } from "./actions.ts";
import { agentConfigured, makeRuntime } from "./agent.ts";
import { createAuth, multiTenantEnabled } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { calendarFeedHandler } from "./calendar/routes.ts";
import { ComputerService, type DockerRunner, resolveComputerDeployment } from "./computer.ts";
import { computerRoutes } from "./computer-routes.ts";
import {
  type Config,
  intelligenceConfigured,
  intelligenceThreadsDisabledMessage,
} from "./config.ts";
import type { Store } from "./db.ts";
import { agentRoutes } from "./engine/routes.ts";
import { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { Files } from "./files.ts";
import { GoogleAuth } from "./google-auth.ts";
import { dashboardOrigin, GoogleIdentity } from "./google-identity.ts";
import { rateLimit } from "./rate-limit.ts";
import { WorkspaceService } from "./workspace.ts";

/**
 * Where the browser lands after a Google calendar consent. The dashboard is a
 * web origin on the allowlist, never the API's own origin; when no allowed
 * origin is known the caller keeps the server's own response.
 */
/**
 * Where to send the browser after a consent. An explicit PUBLIC_APP_URL wins: the
 * API usually runs on its own host, and the first allowed origin is often a native
 * app or a stale dev port rather than the dashboard someone is actually using.
 */
function calendarDashboardBase(
  allowedOrigins: readonly string[],
  publicAppUrl?: string,
): string | null {
  const explicit = publicAppUrl ? dashboardOrigin(publicAppUrl) : null;
  if (explicit) return explicit;
  for (const value of allowedOrigins) {
    const origin = dashboardOrigin(value);
    if (origin) return origin;
  }
  return null;
}

/** A short, token-free slug for the calendar callback's `reason` parameter. */
function googleCallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/expired/i.test(message)) return "expired";
  if (/disconnect|changed/i.test(message)) return "changed";
  if (/grant|permission|access|authoriz|authoris/i.test(message)) return "denied";
  return "failed";
}

export async function createApp(
  db: Store,
  config: Config,
  options: { docker?: DockerRunner } = {},
) {
  await resolveComputerDeployment(config);
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    workspace = new WorkspaceService(db, config, files, google);
  const multiTenant = multiTenantEnabled();
  const accounts = new AccountService(db, config);
  const identity = new GoogleIdentity(config, auth, accounts);
  const requestContext = (c: Context): RequestContext => {
    let address: string | undefined;
    try {
      address = getConnInfo(c).remote.address;
    } catch {
      // in-memory app.request() has no socket
      address = undefined;
    }
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const realIp = c.req.header("x-real-ip");
    return {
      ip: config.trustProxy ? forwarded || realIp || address : address,
      userAgent: c.req.header("user-agent"),
    };
  };
  // A real tournament registration executes through the agent service, which
  // owns the OmniPong client. `agent` is assigned just below; this closure
  // reads it at approval time, never at construction time.
  let agent!: AgentService;
  const actions = new ActionService(db, {
    execute: (owner, input, connectionId, targetVersion) =>
      input.kind === "omnipong.signup"
        ? agent.executeApprovedSignup(input.data)
        : workspace.execute(owner, input, connectionId, targetVersion),
    prepare: (owner, input, connectionId) =>
      input.kind === "omnipong.signup"
        ? Promise.resolve({ input })
        : workspace.prepare(owner, input, connectionId),
    connected: (owner) => workspace.connected(owner),
    connection: (owner) => workspace.connection(owner),
  });
  const browser = new BrowserService(db, config, auth, files);
  const computer = new ComputerService(db, config, options.docker);
  agent = new AgentService(
    db,
    config,
    workspace,
    files,
    actions,
    browser,
    computer,
    undefined,
    undefined,
    google,
  );
  // Rich Threads are opt-in. Without a key the runtime runs native AG-UI:
  // chat streams and tools run, but conversations do not sync across devices.
  const intelligenceApiKey = config.intelligenceApiKey?.trim();
  const intelligence = intelligenceApiKey
    ? new CopilotKitIntelligence({ apiKey: intelligenceApiKey })
    : undefined;
  const runtime = makeRuntime(config, agent, auth, intelligence);
  const app = new Hono<{ Variables: { owner: string } }>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Origin is not allowed" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 12 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request is too large; PDFs must be 10 MB or smaller" }, 413),
    }),
  );
  app.use("/api/*", rateLimit(Boolean(config.trustProxy)));
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[OpenMuse] ${error.name}`);
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "Request failed. Check the server setup and try again.",
      },
      502,
    );
  });
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      agentConfigured: agentConfigured(config),
      browserConfigured: Boolean(config.workerUrl && config.workerToken),
      threadsConfigured: intelligenceConfigured(config),
    }),
  );
  let loginWindow = 0,
    loginAttempts = 0;
  app.post("/api/session", async (c) => {
    // Multi-tenant servers close the shared access-key flow; signup/login mint
    // account-owned sessions instead. Never seed a "local-user" here.
    if (multiTenant)
      throw new AppError("Accounts are enabled on this server. Sign in or create an account.", 403);
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 30)
      throw new AppError("Too many sign-in attempts. Try again in a minute.", 429);
    const body = z.object({ accessKey: z.string().optional() }).parse(await c.req.json());
    const session = await auth.session(body.accessKey);
    await workspace.ensureSample("local-user", actions);
    await agent.ensure("local-user");
    if (config.mode === "sample") await agent.refreshIdeas("local-user");
    return c.json(session);
  });
  // Public, session-free iCal feed. The token in the path is the credential.
  app.get("/api/calendar/feed/*", calendarFeedHandler(agent.calendar));

  // The calendar consent lands the browser back on the dashboard with a visible
  // result rather than on a server page. With no known dashboard origin (a bare
  // API deployment) the honest server response is kept instead of a bogus
  // redirect. The one-shot state is consumed exactly once either way.
  const dashboardBase = calendarDashboardBase(config.allowedOrigins, config.publicAppUrl);
  app.get("/api/google/callback", async (c) => {
    const back = (query: string) =>
      dashboardBase ? c.redirect(`${dashboardBase}/calendar?${query}`, 302) : null;
    if (c.req.query("error")) {
      const redirect = back("google=error&reason=cancelled");
      if (redirect) return redirect;
      return c.html("<h1>Google connection cancelled</h1><p>You can return to OpenPong.</p>", 400);
    }
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) {
      const redirect = back("google=error&reason=incomplete");
      if (redirect) return redirect;
      throw new AppError("Google callback is incomplete");
    }
    try {
      await google.callback(state, code);
    } catch (error) {
      if (!dashboardBase) throw error;
      // A short reason only: never a token and never the raw Google error.
      return c.redirect(
        `${dashboardBase}/calendar?google=error&reason=${googleCallbackReason(error)}`,
        302,
      );
    }
    const redirect = back("google=connected");
    if (redirect) return redirect;
    return c.html(
      "<h1>Google is connected</h1><p>Return to OpenPong and refresh your workspace.</p>",
    );
  });
  app.use("/api/*", async (c, next) => {
    // Account routes authenticate themselves: signup/login are public, and the
    // others return their own 401 (and Retry-After) shapes. Google sign-in is
    // public even when accounts are off, so it can answer with a clear 403
    // rather than the bearer gate's 401.
    if (
      c.req.path.startsWith("/api/auth/google/") ||
      (multiTenant && c.req.path.startsWith("/api/auth/"))
    )
      return next();
    // A signed URL grants only the requests its page makes: reads, and the console's input.
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    const signedRoute =
      (method === "GET" &&
        /^\/api\/files\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$/.test(
          c.req.path,
        )) ||
      (method === "POST" && /^\/api\/browsers\/[^/]+\/console$/.test(c.req.path));
    const owner =
      signedRoute && c.req.query("signature")
        ? auth.verify(new URL(c.req.url))
        : await auth.owner(c.req.header("authorization"));
    c.set("owner", owner);
    await next();
  });
  app.delete("/api/session", async (c) => {
    await auth.revoke(c.req.header("authorization"));
    return c.json({ ok: true });
  });
  app.get("/api/workspace", async (c) => {
    const [snapshot, reachable] = await Promise.all([
      workspace.snapshot(c.get("owner"), c.req.query("q")),
      browser.reachable(),
    ]);
    snapshot.browsers = snapshot.browsers.map((s) => browser.decorate(c.get("owner"), s));
    // A configured worker that does not answer is offline, not ready.
    snapshot.connections = snapshot.connections.map((connection) =>
      connection.id === "browser" && connection.status === "connected" && !reachable
        ? { ...connection, status: "unavailable" }
        : connection,
    );
    return c.json(snapshot);
  });
  app.route("/api/agent", agentRoutes(agent));
  app.route("/api/computer", computerRoutes(computer, files));
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (query.timeMin && query.timeMax) calendarRangeSchema.parse(query);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/actions", async (c) => {
    const input = proposalSchema.parse(await c.req.json());
    // The review endpoint must not mint a real-signup proposal while the
    // operator has real signup disabled. The durable task path already
    // previews instead; this closes the direct-HTTP bypass too.
    if (input.kind === "omnipong.signup" && !config.omnipongAllowRealSignup)
      throw new AppError("Real tournament signup is disabled on this server", 409);
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    return c.json(await actions.propose(c.get("owner"), input), 201);
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema
      .extend({ id: z.string().uuid().optional() })
      .parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("Draft not found", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  app.get("/api/main-thread", async (c) => {
    // Without a key there is no server-side thread ledger; say so plainly instead
    // of attempting a platform call or leaving a half-created settings record.
    if (!intelligence) throw new AppError(intelligenceThreadsDisabledMessage, 503);
    const owner = c.get("owner");
    await db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
      existing: false,
    });
    const main = await db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("Main conversation could not be loaded", 503);
    try {
      await intelligence.getOrCreateThread({
        threadId: main.threadId,
        userId: owner,
        agentId: "default",
      });
    } catch {
      throw new AppError(
        "Main conversation is unavailable. Check the Rich Threads connection and try again.",
        502,
      );
    }
    return c.json({ threadId: main.threadId, existing: true });
  });
  app.get("/api/conversation", async (c) =>
    c.json((await db.get(c.get("owner"), "conversations", "default")) ?? { messages: [] }),
  );
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const messages = z.array(z.unknown()).max(1000).parse(body.messages);
    for (const message of messages) MessageSchema.parse(message);
    await db.put(c.get("owner"), "conversations", { id: "default", messages });
    return c.json({ ok: true });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a PDF file");
    return c.json(
      await files.import(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  /**
   * What the dashboard's "Connect Google Calendar" button needs to be honest:
   * whether this server can start a consent at all, and whether this owner has
   * already connected. It never returns the client secret or any token.
   */
  app.get("/api/google/status", async (c) => {
    const owner = c.get("owner");
    const tokens = await google.tokens(owner).catch(() => null);
    const record = await db.get<{ calendarId?: string }>(owner, "calendar", "google");
    // A stored refresh token can die — a Google app still in "Testing" expires
    // them after seven days, and a revoked grant dies at once. A "Connected"
    // badge over a dead token is the fastest way to make someone think their
    // calendar is broken, so ask for a live token. That is cached for an hour,
    // so this costs at most one Google round trip per hour.
    const live = tokens
      ? await google
          .accessToken(owner)
          .then(() => true)
          .catch(() => false)
      : false;
    const calendars = live
      ? await workspace
          .calendars(owner)
          .then((list) => list.length)
          .catch(() => 0)
      : 0;
    return c.json({
      configured: google.configured(),
      connected: live,
      ...(tokens && !live ? { needsReconnect: true } : {}),
      calendars,
      ...(record?.calendarId ? { calendarId: record.calendarId } : {}),
    });
  });
  /**
   * The one-click calendar connect. Already connected is a no-op; otherwise the
   * browser is handed Google's consent URL for exactly the three calendar
   * scopes and nothing else. A server with no Google app says so plainly: the
   * private iCal link still works and does not need Google.
   */
  app.post("/api/google/calendar/connect", async (c) => {
    const owner = c.get("owner");
    if (await google.tokens(owner).catch(() => null)) return c.json({ connected: true });
    if (!google.configured())
      throw new AppError(
        "This server has no Google app configured. The private calendar link still works, and it does not need Google.",
        503,
      );
    return c.json(await google.connectCalendar(owner));
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  app.post("/api/browsers", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.create(c.get("owner"), body.url), 201);
  });
  app.get("/api/browsers/:id", async (c) => {
    const owner = c.get("owner");
    return c.json(browser.decorate(owner, await browser.get(owner, c.req.param("id"))));
  });
  app.post("/api/browsers/:id/navigate", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.navigate(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/close", async (c) =>
    c.json(await browser.close(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/read", async (c) =>
    c.json(await browser.read(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/:id/reopen", async (c) => {
    const raw = await c.req.text();
    const body = z.object({ url: z.url().max(4096).optional() }).parse(raw ? JSON.parse(raw) : {});
    return c.json(await browser.reopen(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/import-downloads", async (c) =>
    c.json(await browser.imports(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/preview", async (c) => {
    const response = await browser.preview(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "image/png");
    return c.body(await response.arrayBuffer());
  });
  app.get("/api/browsers/:id/console", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob: data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    );
    return c.html(browser.console(c.get("owner"), c.req.param("id")));
  });
  app.post("/api/browsers/:id/console", async (c) => {
    await browser.input(c.get("owner"), c.req.param("id"), await c.req.json());
    return c.json({ ok: true });
  });
  app.all("/api/copilotkit/*", async (c) => {
    if (!agentConfigured(config))
      throw new AppError(
        "Configure a model and provider API key, or a valid AG-UI endpoint, to start chat",
        503,
      );
    const response = await runtime.fetch(c.req.raw);
    // Runtime 1.70 emits SSE strings; a WHATWG Response body requires byte chunks.
    const encoder = new TextEncoder();
    const body = response.body?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, headers: response.headers });
  });
  app.get("/", (c) =>
    c.json({ name: "OpenPong", app: "http://localhost:8081", health: "/api/health" }),
  );
  // Multi-tenant account routes. Appended last so the single-owner routes above
  // (and their order) stay untouched; they are only mounted when enabled.
  /** Seed the account's own workspace, then mint a session owned by its id. */
  const beginAccountSession = async (account: Account, context: RequestContext) => {
    await workspace.ensureSample(account.id, actions);
    await agent.ensure(account.id);
    const session = await auth.sessionFor(account.id, context);
    return session.token;
  };
  if (multiTenant) {
    app.post("/api/auth/signup", async (c) => {
      const body = z
        .object({
          email: z.string(),
          password: z.string(),
          displayName: z.string().optional(),
        })
        .parse(await c.req.json());
      const context = requestContext(c);
      const account = await accounts.signup(body.email, body.password, body.displayName, context);
      const token = await beginAccountSession(account, context);
      // Match the sample sign-in flow: the new workspace starts with suggestions.
      if (config.mode === "sample") await agent.refreshIdeas(account.id);
      return c.json({ token, account }, 201);
    });
    app.post("/api/auth/login", async (c) => {
      const body = z.object({ email: z.string(), password: z.string() }).parse(await c.req.json());
      const context = requestContext(c);
      let account: Account;
      try {
        account = await accounts.login(body.email, body.password, context);
      } catch (error) {
        // Keep the Retry-After hint machine-readable, not just in the message.
        if (error instanceof LoginRateLimitError)
          return c.json({ error: error.message }, 429, {
            "Retry-After": String(error.retryAfterSeconds),
          });
        throw error;
      }
      const token = await beginAccountSession(account, context);
      return c.json({ token, account });
    });
    app.get("/api/auth/me", async (c) => {
      const account = await accounts.get(await auth.owner(c.req.header("authorization")));
      if (!account) throw new AppError("Account not found. Sign in again.", 401);
      return c.json({ account });
    });
    app.post("/api/auth/logout", async (c) => {
      const authorization = c.req.header("authorization");
      const owner = await auth.owner(authorization);
      // Audit before revoking: a failed audit must not leave an unrecorded logout.
      await accounts.audit(owner, "logout", requestContext(c));
      await auth.revoke(authorization);
      return c.json({ ok: true });
    });
    app.post("/api/auth/password", async (c) => {
      const owner = await auth.owner(c.req.header("authorization"));
      const body = z
        .object({ oldPassword: z.string(), newPassword: z.string() })
        .parse(await c.req.json());
      await accounts.changePassword(owner, body.oldPassword, body.newPassword, requestContext(c));
      return c.json({ ok: true });
    });
  }
  // Google sign-in, identity only (`openid email profile`). It never requests a
  // calendar or Gmail scope, and the calendar connect flow above is untouched.
  // Mounted even when accounts are off so `start` can answer with a clear 403.
  app.post("/api/auth/google/start", async (c) => {
    if (!multiTenant)
      throw new AppError("Accounts are not enabled on this server. Sign-in is unavailable.", 403);
    const body = z.object({ redirectBase: z.string() }).parse(await c.req.json());
    return c.json(identity.start(body.redirectBase));
  });
  app.get("/api/auth/google/callback", async (c) => {
    const state = identity.state(c.req.query("state"));
    const base = state ? dashboardOrigin(state.redirectBase) : null;
    // A valid state tells us where the dashboard lives; without one there is no
    // safe place to send the browser, so the error stays on the server.
    const fail = (message: string) =>
      base
        ? c.redirect(`${base}/login?error=${encodeURIComponent(message)}`, 302)
        : c.json({ error: message }, 400);
    if (c.req.query("error")) return fail("Google sign-in was cancelled.");
    const code = c.req.query("code");
    if (!code || !state || !base) return fail("Google sign-in could not be verified.");
    if (state.expiresAt < Date.now()) return fail("Google sign-in expired. Try again.");
    try {
      const account = await identity.complete(code, requestContext(c));
      const oneTime = identity.issueCode(account.id);
      return c.redirect(`${base}/login/google?code=${encodeURIComponent(oneTime)}`, 302);
    } catch (error) {
      return fail(error instanceof AppError ? error.message : "Google sign-in failed. Try again.");
    }
  });
  app.post("/api/auth/google/exchange", async (c) => {
    if (!multiTenant)
      throw new AppError("Accounts are not enabled on this server. Sign-in is unavailable.", 403);
    const body = z.object({ code: z.string() }).parse(await c.req.json());
    const accountId = identity.redeemCode(body.code);
    if (!accountId) throw new AppError("This sign-in link is no longer valid. Try again.", 401);
    const account = await accounts.get(accountId);
    if (!account) throw new AppError("Account not found. Sign in again.", 401);
    const token = await beginAccountSession(account, requestContext(c));
    return c.json({ token, account });
  });
  return { app, auth, files, actions, workspace, agent, computer };
}

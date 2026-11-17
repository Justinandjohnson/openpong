import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import project from "../../../../package.json" with { type: "json" };
import { AppError } from "../errors.ts";

/**
 * Talk to a remote calendar MCP server.
 *
 * Two servers are known to work and speak the same protocol, so one client
 * serves both:
 *
 * - Google's own Calendar MCP server (`https://calendarmcp.googleapis.com/mcp/v1`).
 *   It answers `tools/list` without authentication, but every tool call needs an
 *   OAuth 2 bearer token, which we already know how to mint for the owner.
 * - Zapier MCP (`https://mcp.zapier.com/api/v1/connect`), which holds the Google
 *   app credentials itself, so the owner pastes one connection token and never
 *   touches a Google Cloud project.
 *
 * Nothing here is Google-specific: the caller names the tool and passes the
 * arguments. Credentials stay in this process and are never put in a message.
 */
export const GOOGLE_CALENDAR_MCP_URL = "https://calendarmcp.googleapis.com/mcp/v1";
export const ZAPIER_MCP_URL = "https://mcp.zapier.com/api/v1/connect";

export interface CalendarMcpOptions {
  url: string;
  /** Bearer token: a Google access token, or a Zapier connection token. */
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface CalendarMcpTool {
  name: string;
  description?: string;
}

/**
 * Extends AppError so the API's error handler returns the message we chose
 * (and its status) instead of the generic "check the server setup" fallback —
 * a calendar that needs reconnecting must say so.
 */
export class CalendarMcpError extends AppError {
  constructor(message: string, status: AppError["status"] = 502) {
    super(message, status);
    this.name = "CalendarMcpError";
  }
}

/** A tool result is JSON when the server sends JSON, and text otherwise. */
export interface CalendarMcpResult {
  text: string;
  data: unknown;
  isError: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class CalendarMcp {
  private readonly url: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: CalendarMcpOptions) {
    const url = options.url?.trim();
    if (!url) throw new CalendarMcpError("A calendar MCP server needs a URL.");
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" &&
        parsed.hostname !== "127.0.0.1" &&
        parsed.hostname !== "localhost"
      )
        throw new CalendarMcpError("A calendar MCP server must be reached over https.");
    } catch (error) {
      if (error instanceof CalendarMcpError) throw error;
      throw new CalendarMcpError("That calendar MCP address is not a valid URL.");
    }
    this.url = url;
    this.token = options.token?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl;
  }

  /** Connect, run one exchange, and disconnect — these servers are stateless. */
  private async withClient<T>(
    run: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const headers: Record<string, string> = {
      "User-Agent": `${project.name}/${project.version}`,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    const client = new Client({ name: project.name, version: project.version });
    try {
      await client.connect(transport, { signal: deadline, timeout: this.timeoutMs });
      return await run(client, deadline);
    } catch (error) {
      throw this.explain(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** Turn transport failures into something a person can act on. */
  private explain(error: unknown): CalendarMcpError {
    if (error instanceof CalendarMcpError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (
      /401|unauthor|authorization|access token|authentication credential/i.test(message) ||
      (typeof (error as { code?: unknown }).code === "number" &&
        (error as { code: number }).code === 401)
    )
      return new CalendarMcpError(
        "The calendar connection is no longer authorised. Reconnect it in Calendar settings.",
        401,
      );
    if (/403|forbidden|permission/i.test(message))
      return new CalendarMcpError(
        "The calendar connection was refused. Check that this account may use the calendar.",
        403,
      );
    if (/abort|timeout|timed out/i.test(message))
      return new CalendarMcpError("The calendar service did not answer in time.");
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(message))
      return new CalendarMcpError("The calendar service could not be reached.");
    return new CalendarMcpError(message);
  }

  /** Which tools the server offers — no credentials needed for this on Google. */
  async listTools(): Promise<CalendarMcpTool[]> {
    const listed = await this.withClient((client, signal) =>
      client.listTools(undefined, { signal, timeout: this.timeoutMs }),
    );
    return (listed.tools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
    }));
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<CalendarMcpResult> {
    const toolName = name?.trim();
    if (!toolName) throw new CalendarMcpError("A calendar tool name is required.");
    const result = (await this.withClient((client, signal) =>
      client.callTool({ name: toolName, arguments: args }, CallToolResultSchema, {
        signal,
        timeout: this.timeoutMs,
      }),
    )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    return { text, data, isError: result.isError === true };
  }

  /** Convenience wrappers for the tools Google's server documents. */
  listCalendars(): Promise<CalendarMcpResult> {
    return this.call("list_calendars");
  }

  listEvents(
    args: {
      calendarId?: string;
      startTime?: string;
      endTime?: string;
      fullText?: string;
      pageSize?: number;
    } = {},
  ): Promise<CalendarMcpResult> {
    return this.call("list_events", {
      ...args,
      ...(args.pageSize ? { pageSize: Math.min(Math.max(args.pageSize, 1), 250) } : {}),
    });
  }

  searchEvents(args: {
    query: string;
    startTime?: string;
    endTime?: string;
  }): Promise<CalendarMcpResult> {
    return this.call("search_events", args);
  }

  createEvent(args: Record<string, unknown>): Promise<CalendarMcpResult> {
    return this.call("create_event", args);
  }

  suggestTime(args: Record<string, unknown>): Promise<CalendarMcpResult> {
    return this.call("suggest_time", args);
  }
}

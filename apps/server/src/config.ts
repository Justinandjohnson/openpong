import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defaultOmniPongServiceUrl } from "./omnipong/service.ts";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
// OpenPong: OpenRouter is OpenAI-compatible. If an OpenRouter key is present and no explicit
// OpenAI key/base URL is configured, route the OpenAI adapter through OpenRouter. OpenRouter
// implements the Chat Completions wire format (not the Responses API), so opt into it.
if (process.env.OPENROUTER_API_KEY) {
  process.env.OPENAI_API_KEY ??= process.env.OPENROUTER_API_KEY;
  process.env.OPENAI_BASE_URL ??= "https://openrouter.ai/api/v1";
  process.env.OPENAI_CHAT_COMPLETIONS ??= "true";
}
// Capture the full setup/activation funnel while preserving explicit SDK opt-outs
// and any deployment-specific sampling rate. Config loads before runtime imports.
process.env.COPILOTKIT_TELEMETRY_SAMPLE_RATE ??= "1";

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  intelligenceApiKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  omnipongServiceUrl?: string;
  omnipongServiceToken?: string;
  /** The OpenPong relay base URL (services/omnipong/relay). Optional. */
  relayUrl?: string;
  /** Operator token the relay's control plane requires (RELAY_OPERATOR_TOKEN). */
  relayToken?: string;
  /**
   * Safety gate for real tournament registration. Off unless
   * `OMNIPONG_ALLOW_REAL_SIGNUP === "true"`; even then, a real registration
   * still requires a human approval in the native app.
   */
  omnipongAllowRealSignup?: boolean;
  taskWorkerEnabled?: boolean;
  webSearchEnabled?: boolean;
  /** Outbound SMS alerts (scout). Off only when OMNIPONG_SMS_ALERTS=false. */
  smsAlertsEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  computerProvider?: ComputerProvider;
  computerE2bTemplate?: string;
  e2bApiKey?: string;
  allowedOrigins: string[];
  trustProxy?: boolean;
}

export type ComputerProvider = "docker" | "e2b-desktop";

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

/**
 * Boot warning shown when Rich Threads are unavailable. The key is optional:
 * it only adds cross-device thread history, so chat keeps working without it.
 */
export const intelligenceKeyOptionalMessage =
  "[OpenPong] Threads disabled; set CPK_INTELLIGENCE_API_KEY to sync conversations across devices. " +
  "Chat and tools still work without it. Run `npx copilotkit@latest login` and " +
  "`npx copilotkit@latest project select`, then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

/** Actionable response when a client asks for Rich Threads without a key. */
export const intelligenceThreadsDisabledMessage =
  "Rich Threads are not configured. Set CPK_INTELLIGENCE_API_KEY, " +
  "or keep using chat without cross-device history.";

/**
 * Rich Threads are opt-in. Only a non-blank Intelligence key enables the
 * CopilotKit Intelligence runtime; without it the API runs native AG-UI.
 */
export function intelligenceConfigured(config: Pick<Config, "intelligenceApiKey">): boolean {
  return Boolean(config.intelligenceApiKey?.trim());
}

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

/** Accept a full worker URL, or host:port from a platform that omits the scheme. */
export function browserWorkerUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.includes("://") ? trimmed : `http://${trimmed}`;
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;
let warnedIntelligenceDisabled = false;
export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const computerProvider = process.env.COMPUTER_PROVIDER?.trim() || "docker";
  if (computerProvider !== "docker" && computerProvider !== "e2b-desktop")
    throw new Error("COMPUTER_PROVIDER must be docker or e2b-desktop");
  const e2bApiKey = process.env.E2B_API_KEY?.trim();
  if (process.env.COMPUTER_ENABLED === "true" && computerProvider === "e2b-desktop") {
    if (!e2bApiKey)
      throw new Error("COMPUTER_PROVIDER=e2b-desktop requires a nonblank E2B_API_KEY");
    // Sandboxes are matched by metadata across the whole E2B team, and every default
    // install would otherwise derive the same deployment label from localhost:8787.
    if (!process.env.COMPUTER_DEPLOYMENT_ID?.trim())
      throw new Error(
        "COMPUTER_PROVIDER=e2b-desktop requires a unique COMPUTER_DEPLOYMENT_ID, e.g. from `openssl rand -hex 12`",
      );
  }
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    intelligenceApiKey: process.env.CPK_INTELLIGENCE_API_KEY?.trim() || undefined,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: browserWorkerUrl(process.env.BROWSER_WORKER_URL),
    workerToken: process.env.WORKER_TOKEN,
    // The vendored OmniPong service is optional: with neither set the server still
    // boots and degrades to a clean tool error when a table-tennis tool is called.
    omnipongServiceUrl: process.env.OMNIPONG_SERVICE_URL?.trim() || defaultOmniPongServiceUrl,
    omnipongServiceToken: process.env.OMNIPONG_SERVICE_TOKEN?.trim() || undefined,
    // The relay carries browser control for the owner's own computer (no stored
    // credentials). Optional: without a URL the dashboard shows setup guidance.
    relayUrl: process.env.RELAY_URL?.trim() || undefined,
    relayToken:
      process.env.RELAY_TOKEN?.trim() || process.env.RELAY_OPERATOR_TOKEN?.trim() || undefined,
    // Real signup stays off unless explicitly enabled; approval is still required.
    omnipongAllowRealSignup: process.env.OMNIPONG_ALLOW_REAL_SIGNUP === "true",
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    webSearchEnabled: process.env.WEB_SEARCH_ENABLED !== "false",
    smsAlertsEnabled: process.env.OMNIPONG_SMS_ALERTS !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    // A blank line from .env is unset; otherwise every such install would share one name.
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID?.trim() || undefined,
    computerProvider,
    computerE2bTemplate: process.env.COMPUTER_E2B_TEMPLATE?.trim() || "desktop",
    e2bApiKey,
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
    // Only trust X-Forwarded-For/X-Real-IP when the deployment is known to sit
    // behind a proxy that sets them; otherwise a direct caller can spoof them.
    trustProxy: process.env.TRUST_PROXY === "true",
  };
  if (
    mode === "live" &&
    (!config.accessKey || config.accessKey.length < 24 || !config.encryptionKey)
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  // Optional keys degrade only Rich Threads; surfacing the hint once at boot keeps
  // self-hosted logs actionable without failing startup or spamming test runs.
  if (!config.intelligenceApiKey && !warnedIntelligenceDisabled) {
    warnedIntelligenceDisabled = true;
    console.warn(intelligenceKeyOptionalMessage);
  }
  return config;
}

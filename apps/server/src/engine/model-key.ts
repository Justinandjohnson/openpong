import { createHash, randomBytes } from "node:crypto";
import { chat, streamToText } from "@tanstack/ai";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { type AdapterAuth, adapter } from "./tanstack-agent.ts";

/**
 * Bring-your-own-key (BYOK) for the coach.
 *
 * A brand-new person pastes a key from a provider they already pay for; the
 * coach then uses that key for their own turns instead of the host's. Nothing
 * else is installed or configured: no Google Cloud project, no companion, no
 * extension. The key is encrypted at rest with a lazily-created server secret
 * (the same approach as the calendar feed secret), is never logged, and is
 * never returned to a client — a read returns only a last-4 hint.
 */

/** The provider ids stored on a key record. Kept short and stable. */
export type ModelProviderId = "openrouter" | "openai" | "anthropic" | "google";

export interface ModelProvider {
  id: ModelProviderId;
  /** The name a person would recognise. */
  label: string;
  /** The prefix the existing adapter() understands for this provider. */
  specProvider: "openai" | "anthropic" | "google";
  /** A sensible default model shipped with the app. */
  defaultModel: string;
  /** The provider's own endpoint; BYOK never borrows the host's base URL. */
  baseUrl: string;
  /** OpenRouter and other OpenAI-compatible gateways speak Chat Completions. */
  chatCompletions?: boolean;
  /** Optional environment override (used by self-hosted gateways and tests). */
  envBaseUrl?: string;
}

export const MODEL_PROVIDERS: Record<ModelProviderId, ModelProvider> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    specProvider: "openai",
    defaultModel: "openai/gpt-4o-mini",
    baseUrl: "https://openrouter.ai/api/v1",
    chatCompletions: true,
    envBaseUrl: "OPENROUTER_BASE_URL",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    specProvider: "openai",
    defaultModel: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    specProvider: "anthropic",
    defaultModel: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com",
  },
  google: {
    id: "google",
    label: "Google Gemini",
    specProvider: "google",
    defaultModel: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
};

export const modelProviderIds = Object.keys(MODEL_PROVIDERS) as ModelProviderId[];

/** The provider endpoint, honouring an operator's environment override. */
export function providerBaseUrl(provider: ModelProvider): string {
  const override = provider.envBaseUrl ? process.env[provider.envBaseUrl]?.trim() : undefined;
  return override || provider.baseUrl;
}

/** What a client is allowed to see: never the key, only its last 4 characters. */
export interface ModelKeyView {
  configured: boolean;
  provider?: ModelProviderId;
  model?: string;
  /** Last 4 characters of the stored key. */
  hint?: string;
}

/** The key resolved for one owner's chat run, ready for adapter(). */
export interface ResolvedModelKey {
  provider: ModelProviderId;
  label: string;
  /** A "provider/model" string the existing adapter() understands. */
  spec: string;
  /** Extra adapter auth: explicit key + endpoint, so the host env never leaks in. */
  auth: AdapterAuth;
}

interface StoredModelKey {
  id: "default";
  provider: ModelProviderId;
  model: string;
  hint: string;
  encrypted: string;
  updatedAt: string;
}

const providerSchema = z.enum(["openrouter", "openai", "anthropic", "google"]);
const apiKeySchema = z.string().trim().min(4).max(4096);
const modelSchema = z.string().trim().min(1).max(200).optional();

export const modelKeyInputSchema = z.object({
  provider: providerSchema,
  apiKey: apiKeySchema,
  model: modelSchema,
});

const modelKeyTestSchema = z.object({
  provider: providerSchema.optional(),
  apiKey: apiKeySchema.optional(),
  model: modelSchema,
});

/** A short, honest error for chat and the test endpoint. Never a stack trace. */
export function shortModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The key could not be used";
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "The key could not be used";
}

export class ModelKeyService {
  private secretPromise?: Promise<string>;

  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}

  /**
   * A deployment without TOKEN_ENCRYPTION_KEY gets a random per-deployment
   * secret stored in the database, so the stored key still works — and is still
   * encrypted at rest — with no operator setup.
   */
  private async secret(): Promise<string> {
    if (this.config.encryptionKey?.trim()) return this.config.encryptionKey;
    this.secretPromise ??= (async () => {
      const stored = await this.db.get<{ id: string; secret: string }>(
        "system",
        "system",
        "model-key-secret",
      );
      if (stored?.secret) return stored.secret;
      const secret = randomBytes(32).toString("base64url");
      await this.db.insertIfAbsent("system", "system", { id: "model-key-secret", secret });
      const saved = await this.db.get<{ id: string; secret: string }>(
        "system",
        "system",
        "model-key-secret",
      );
      return saved?.secret ?? secret;
    })();
    return this.secretPromise;
  }

  /** vault.ts wants exactly 32 base64 bytes; derive a stable one from the secret. */
  private async vaultKey(): Promise<string> {
    return Buffer.from(
      createHash("sha256")
        .update(await this.secret())
        .digest(),
    ).toString("base64");
  }

  /** `GET /api/agent/model-key`: only `{configured, provider, model, hint}`. */
  async view(owner: string): Promise<ModelKeyView> {
    const record = await this.db.get<StoredModelKey>(owner, "model-key", "default");
    if (!record) return { configured: false };
    return {
      configured: true,
      provider: record.provider,
      model: record.model,
      hint: record.hint,
    };
  }

  /** `PUT /api/agent/model-key`: validate, encrypt and store; never echo the key. */
  async save(owner: string, raw: unknown): Promise<ModelKeyView> {
    const parsed = modelKeyInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
    const provider = MODEL_PROVIDERS[parsed.data.provider];
    const apiKey = parsed.data.apiKey.trim();
    const model = parsed.data.model?.trim() || provider.defaultModel;
    const record: StoredModelKey = {
      id: "default",
      provider: provider.id,
      model,
      hint: apiKey.slice(-4),
      encrypted: encryptSecret(apiKey, await this.vaultKey()),
      updatedAt: new Date().toISOString(),
    };
    await this.db.put(owner, "model-key", record);
    return this.view(owner);
  }

  /** `DELETE /api/agent/model-key`: forget the key so the host env applies again. */
  async remove(owner: string): Promise<{ removed: boolean }> {
    const existing = await this.db.get<StoredModelKey>(owner, "model-key", "default");
    if (!existing) return { removed: false };
    await this.db.remove(owner, "model-key", "default");
    return { removed: true };
  }

  /**
   * The owner's key for one chat run, or null when they have none (so the host
   * environment applies exactly as it does today). A corrupt record resolves to
   * null instead of breaking chat.
   */
  async resolve(owner: string): Promise<ResolvedModelKey | null> {
    const record = await this.db.get<StoredModelKey>(owner, "model-key", "default");
    if (!record) return null;
    const provider = MODEL_PROVIDERS[record.provider];
    if (!provider) return null;
    let apiKey: string;
    try {
      apiKey = decryptSecret(record.encrypted, await this.vaultKey());
    } catch {
      return null;
    }
    if (!apiKey.trim()) return null;
    const model = record.model?.trim() || provider.defaultModel;
    return {
      provider: provider.id,
      label: provider.label,
      spec: `${provider.specProvider}/${model}`,
      auth: {
        apiKey,
        baseUrl: providerBaseUrl(provider),
        ...(provider.chatCompletions ? { chatCompletions: true } : {}),
      },
    };
  }

  /**
   * `POST /api/agent/model-key/test`: a tiny real completion so the person knows
   * the key works. Uses the submitted key, or the stored one when no key is
   * given. Always resolves: `{ok:true}` or `{ok:false, error}` — never throws.
   */
  async testKey(owner: string, raw: unknown): Promise<{ ok: boolean; error?: string }> {
    try {
      const parsed = modelKeyTestSchema.safeParse(raw ?? {});
      if (!parsed.success)
        return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
      let providerId = parsed.data.provider;
      let model = parsed.data.model?.trim();
      let apiKey = parsed.data.apiKey?.trim();
      if (!apiKey) {
        const record = await this.db.get<StoredModelKey>(owner, "model-key", "default");
        if (!record) return { ok: false, error: "No key is saved yet. Paste one first." };
        providerId ??= record.provider;
        model ??= record.model;
        try {
          apiKey = decryptSecret(record.encrypted, await this.vaultKey());
        } catch {
          return { ok: false, error: "The saved key could not be read. Paste it again." };
        }
      }
      const provider = MODEL_PROVIDERS[providerId ?? "openai"];
      const spec = `${provider.specProvider}/${model?.trim() || provider.defaultModel}`;
      const instance = adapter(spec, {
        apiKey,
        baseUrl: providerBaseUrl(provider),
        ...(provider.chatCompletions ? { chatCompletions: true } : {}),
      });
      const stream = chat({
        adapter: instance,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        stream: true,
      });
      await streamToText(stream as Parameters<typeof streamToText>[0]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: shortModelError(error) };
    }
  }
}

/**
 * A short, friendly chat message when a run fails while the owner's own key is
 * in use. Only auth-shaped failures are blamed on the key; anything else is
 * reported as-is so the coach never misattributes a transient outage.
 */
export function friendlyOwnerKeyError(error: unknown, label: string): string {
  const message = shortModelError(error);
  if (
    /(401|403|unauthor|forbidden|invalid[_\s-]?api[_\s-]?key|api key|authentication)/i.test(message)
  )
    return `Your ${label} key was rejected. Check it in Settings → Your AI key, or Remove it to use the server's key.`;
  return message;
}

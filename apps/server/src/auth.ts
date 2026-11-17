import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountExists } from "./accounts.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Extend a session once it drops below this much remaining life. */
const SESSION_REFRESH_MS = 6 * 60 * 60 * 1000;
/** lastSeenAt is a diagnostic, not a lock: write it at most once per five minutes. */
const LAST_SEEN_WRITE_MS = 5 * 60 * 1000;
const USER_AGENT_MAX = 512;

export interface SessionOptions {
  ip?: string;
  userAgent?: string;
}

interface SessionRecord {
  id: string;
  owner: string;
  createdAt?: number;
  lastSeenAt?: number;
  expiresAt: number;
  ip?: string;
  userAgent?: string;
}

/**
 * Accounts are opt-in. With it off, the server keeps today's one-person
 * behaviour; with it on, every session is minted for an account id and the
 * access-key flow is closed. Read at construction/boot, not module load, so a
 * process can never half-flip between the two models.
 */
export function multiTenantEnabled(): boolean {
  return process.env.MULTI_TENANT === "true";
}

export class Auth {
  private readonly multiTenant = multiTenantEnabled();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
  ) {}
  /**
   * Single-owner sign-in. Multi-tenant servers close this path: an account
   * session can only come from `sessionFor`, never from a shared access key.
   */
  async session(accessKey?: string, options: SessionOptions = {}) {
    if (this.multiTenant)
      throw new AppError("Accounts are enabled on this server. Sign in or create an account.", 403);
    if (
      this.config.mode === "live" &&
      (!accessKey ||
        !this.config.accessKey ||
        !timingSafeEqual(digest(accessKey), digest(this.config.accessKey)))
    )
      throw new AppError("Access key is incorrect", 401);
    return this.mint("local-user", options);
  }
  /** Mint a session whose owner is the account id. Used only by signup and login. */
  async sessionFor(accountId: string, options: SessionOptions = {}) {
    if (!this.multiTenant) throw new AppError("Accounts are not enabled on this server", 403);
    if (!(await accountExists(this.db, accountId)))
      throw new AppError("Account not found. Sign in again.", 401);
    return this.mint(accountId, options);
  }
  private async mint(owner: string, options: SessionOptions) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const record: SessionRecord = {
      id: digest(token).toString("hex"),
      owner,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
      ...(options.ip ? { ip: options.ip.slice(0, 64) } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent.slice(0, USER_AGENT_MAX) } : {}),
    };
    await this.db.put("system", "sessions", record);
    return { token, mode: this.config.mode };
  }
  async owner(authorization?: string) {
    if (!authorization?.startsWith("Bearer ")) throw new AppError("Sign in to OpenPong", 401);
    const id = digest(authorization.slice(7)).toString("hex");
    const session = await this.db.get<SessionRecord>("system", "sessions", id);
    if (!session || session.expiresAt < Date.now()) {
      // Expired sessions can never be valid again, so drop the row instead of keeping it forever.
      // Best-effort: a failed cleanup must not turn the rejection into a 5xx.
      if (session) await this.db.remove("system", "sessions", id).catch(() => {});
      throw new AppError("Session expired. Sign in again.", 401);
    }
    // A session for a deleted account must not outlive the account.
    if (this.multiTenant && !(await accountExists(this.db, session.owner))) {
      await this.db.remove("system", "sessions", id).catch(() => {});
      throw new AppError("Session expired. Sign in again.", 401);
    }
    await this.touch(id, session);
    return session.owner;
  }
  /** Write-behind activity: extend near-expiry sessions and refresh lastSeenAt occasionally. */
  private async touch(id: string, session: SessionRecord) {
    const now = Date.now();
    const patch: Record<string, number> = {};
    if (session.expiresAt - now < SESSION_REFRESH_MS) patch.expiresAt = now + SESSION_TTL_MS;
    if (session.lastSeenAt === undefined || now - session.lastSeenAt > LAST_SEEN_WRITE_MS)
      patch.lastSeenAt = now;
    if (!Object.keys(patch).length) return;
    // The expected expiresAt makes concurrent extensions a harmless no-op
    // instead of letting a stale request shorten another's session.
    await this.db
      .compareAndSwap("system", "sessions", id, { expiresAt: session.expiresAt }, patch)
      .catch(() => {});
  }
  async revoke(authorization?: string) {
    if (authorization?.startsWith("Bearer "))
      await this.db.remove("system", "sessions", digest(authorization.slice(7)).toString("hex"));
  }
  sign(owner: string, path: string) {
    const expires = String(Date.now() + 15 * 60 * 1000);
    const signature = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${path}\n${expires}`)
      .digest("hex");
    return `${this.config.publicUrl}${path}?owner=${encodeURIComponent(owner)}&expires=${expires}&signature=${signature}`;
  }
  verify(url: URL) {
    const owner = url.searchParams.get("owner") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    if (
      !owner ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !/^\w{64}$/.test(signature)
    )
      throw new AppError("Document link expired; refresh the workspace", 401);
    const expected = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${url.pathname}\n${expires}`)
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    return owner;
  }
}
export async function createAuth(db: Store, config: Config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const key = await readOrCreate(join(config.dataDir, "session-signing-key"), () =>
    randomBytes(32).toString("base64"),
  );
  return new Auth(db, config, key);
}
/** Reads a private file, or creates it without replacing another process's value. */
export async function readOrCreate(path: string, create: () => string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let value = create();
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
  try {
    // Publish only complete bytes, without replacing another process's value.
    await link(temporary, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    value = await readFile(path, "utf8");
  } finally {
    await unlink(temporary);
  }
  return value;
}

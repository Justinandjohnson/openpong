import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

/**
 * Accounts are a server-wide directory rather than one owner's data, so they live
 * under a reserved scope that no user id can ever equal (user ids are UUIDs).
 * `account` rows are keyed by the normalised email; `account-id` rows are the
 * UUID -> email lookup used to resolve a session owner back to its account.
 */
export const ACCOUNT_SCOPE = "system";
const ACCOUNT_KIND = "account";
const ACCOUNT_ID_KIND = "account-id";

export interface Account {
  id: string;
  email: string;
  displayName: string;
}

export interface AccountRecord extends Account {
  passwordHash: string;
  createdAt: string;
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export type AuditEvent =
  | "signup"
  | "login"
  | "login_failed"
  | "password_change"
  | "logout"
  | "google_signup"
  | "google_login";

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;
/** N=2^15,r=8 needs exactly 32 MiB plus overhead; the default cap is too small. */
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 1024;
const EMAIL_MAX = 254;
const DISPLAY_NAME_MAX = 120;
const CONTEXT_MAX = 512;
// Deliberately simple: one @, no whitespace, and a dotted domain. Full RFC 5322
// validation is the mail server's job; this rejects obvious typos without
// rejecting legitimate addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_MAX_KEYS = 10_000;

export class LoginRateLimitError extends AppError {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many sign-in attempts. Try again in ${retryAfterText(retryAfterSeconds)}.`, 429);
  }
}

function retryAfterText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function assertEmail(value: unknown): string {
  if (typeof value !== "string") throw new AppError("Enter a valid email address");
  const email = normalizeEmail(value);
  if (!email || email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email))
    throw new AppError("Enter a valid email address");
  return email;
}

function assertPassword(value: unknown, field = "Password"): string {
  if (typeof value !== "string" || value.length < PASSWORD_MIN)
    throw new AppError(`${field} must be at least ${PASSWORD_MIN} characters`);
  if (value.length > PASSWORD_MAX)
    throw new AppError(`${field} must be ${PASSWORD_MAX} characters or fewer`);
  return value;
}

function deriveKey(
  password: string,
  salt: Buffer,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_BYTES,
      { ...options, maxmem: SCRYPT_MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$salt$hash`, base64url so the delimiter is never ambiguous. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveKey(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || r < 1 || p < 1) return false;
  // A tampered record must not turn one login into an unbounded allocation.
  if (128 * N * r + 128 * r * p > SCRYPT_MAX_MEMORY) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length < 8 || expected.length !== SCRYPT_KEY_BYTES) return false;
  const actual = await deriveKey(password, salt, { N, r, p });
  return timingSafeEqual(actual, expected);
}

/** Verified for unknown accounts too, so a missing email is not faster than a wrong password. */
let placeholderHash: Promise<string> | undefined;
function unknownAccountHash() {
  if (!placeholderHash)
    placeholderHash = hashPassword("openpong-placeholder-never-a-real-password");
  return placeholderHash;
}

function publicAccount(record: AccountRecord): Account {
  return { id: record.id, email: record.email, displayName: record.displayName };
}

function clip(value: string | undefined, max = CONTEXT_MAX): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * Append one audit row under the acting owner. Passwords and session tokens are
 * never accepted by this function, so they cannot reach the trail.
 */
export async function recordAudit(
  db: Store,
  owner: string,
  event: AuditEvent,
  context: RequestContext & { email?: string } = {},
): Promise<void> {
  const id = randomUUID();
  const ip = clip(context.ip);
  const userAgent = clip(context.userAgent);
  await db.put(owner, "audit", {
    id,
    event,
    at: new Date().toISOString(),
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(context.email ? { email: context.email } : {}),
  });
}

/**
 * A fixed-window-free (sliding) attempt ledger. In-memory is acceptable because
 * losing it on restart only makes an attacker start over; it never loses user data.
 */
class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly windowMs = LOGIN_WINDOW_MS,
    private readonly maxFailures = LOGIN_MAX_FAILURES,
    private readonly maxKeys = LOGIN_MAX_KEYS,
  ) {}
  private recent(key: string, now: number): number[] {
    const window = (this.failures.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (window.length) this.failures.set(key, window);
    else this.failures.delete(key);
    return window;
  }
  /** 0 while an attempt is allowed, otherwise the Retry-After hint in seconds. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const window = this.recent(key, now);
    if (window.length < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((window[0] + this.windowMs - now) / 1000));
  }
  record(key: string, now = Date.now()): void {
    if (!this.failures.has(key) && this.failures.size >= this.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    this.failures.set(key, [...this.recent(key, now), now]);
  }
  clear(key: string): void {
    this.failures.delete(key);
  }
}

function loginKey(ip: string | undefined, email: string): string {
  return `login:${ip ?? "unknown"}:${email}`;
}

export class AccountService {
  private readonly limiter = new LoginLimiter();
  constructor(
    private readonly db: Store,
    _config: Config,
  ) {}

  /** The full row, including the hash. Never returned from a route. */
  private async find(email: string): Promise<AccountRecord | null> {
    return this.db.get<AccountRecord>(ACCOUNT_SCOPE, ACCOUNT_KIND, email);
  }

  private async index(accountId: string): Promise<{ id: string; email: string } | null> {
    return this.db.get(ACCOUNT_SCOPE, ACCOUNT_ID_KIND, accountId);
  }

  /** Rebuilds a missing UUID index after an interrupted signup. */
  private async ensureIndex(record: AccountRecord): Promise<void> {
    if (await this.index(record.id)) return;
    await this.db.put(ACCOUNT_SCOPE, ACCOUNT_ID_KIND, { id: record.id, email: record.email });
  }

  async signup(
    email: string,
    password: string,
    displayName?: string,
    context: RequestContext = {},
  ): Promise<Account> {
    const normalizedEmail = assertEmail(email);
    assertPassword(password);
    if (displayName !== undefined && typeof displayName !== "string")
      throw new AppError("Display name must be text");
    // Cheap pre-check; the insert below is still the atomic authority against races.
    if (await this.find(normalizedEmail))
      throw new AppError("An account with this email already exists", 409);
    const name = clip(displayName, DISPLAY_NAME_MAX) ?? normalizedEmail.split("@")[0];
    const record: AccountRecord = {
      id: randomUUID(),
      email: normalizedEmail,
      displayName: name,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    // Email uniqueness (including concurrent signups) is enforced atomically.
    const inserted = await this.db.insertIfAbsentAt(
      ACCOUNT_SCOPE,
      ACCOUNT_KIND,
      normalizedEmail,
      record,
    );
    if (!inserted) throw new AppError("An account with this email already exists", 409);
    await this.db.put(ACCOUNT_SCOPE, ACCOUNT_ID_KIND, {
      id: record.id,
      email: record.email,
    });
    await recordAudit(this.db, record.id, "signup", { ...context, email: record.email });
    return publicAccount(record);
  }

  /**
   * Find an account by email, creating one when this OAuth user is new. An OAuth
   * account has no password: the empty hash can never match a scrypt credential,
   * so the password login path stays closed to it. Concurrency is settled by the
   * same atomic insert `signup` uses; a lost race returns the winner's row.
   */
  async findOrCreateByEmail(
    email: string,
    displayName?: string,
  ): Promise<{ account: Account; created: boolean }> {
    const normalizedEmail = assertEmail(email);
    const existing = await this.find(normalizedEmail);
    if (existing) return { account: publicAccount(existing), created: false };
    if (displayName !== undefined && typeof displayName !== "string")
      throw new AppError("Display name must be text");
    const name = clip(displayName, DISPLAY_NAME_MAX) ?? normalizedEmail.split("@")[0];
    const record: AccountRecord = {
      id: randomUUID(),
      email: normalizedEmail,
      displayName: name,
      passwordHash: "",
      createdAt: new Date().toISOString(),
    };
    const inserted = await this.db.insertIfAbsentAt(
      ACCOUNT_SCOPE,
      ACCOUNT_KIND,
      normalizedEmail,
      record,
    );
    if (!inserted) {
      const winner = await this.find(normalizedEmail);
      if (!winner) throw new AppError("Could not create the account. Try again.", 503);
      return { account: publicAccount(winner), created: false };
    }
    await this.db.put(ACCOUNT_SCOPE, ACCOUNT_ID_KIND, { id: record.id, email: record.email });
    return { account: publicAccount(record), created: true };
  }

  async login(email: string, password: string, context: RequestContext = {}): Promise<Account> {
    const normalizedEmail = normalizeEmail(typeof email === "string" ? email : "");
    // The key includes the email, so one account's lockout cannot block another.
    // Unknown emails are still rate-limited by IP, which slows enumeration.
    const key = loginKey(context.ip, normalizedEmail);
    const retry = this.limiter.retryAfterSeconds(key);
    if (retry) throw new LoginRateLimitError(retry);

    const record =
      typeof email === "string" && typeof password === "string"
        ? await this.find(normalizedEmail)
        : null;
    const matches = await verifyPassword(
      typeof password === "string" ? password : "",
      record?.passwordHash ?? (await unknownAccountHash()),
    );
    if (!record || !matches) {
      this.limiter.record(key);
      await recordAudit(this.db, record?.id ?? ACCOUNT_SCOPE, "login_failed", {
        ...context,
        email: normalizedEmail || undefined,
      });
      throw new AppError("Email or password is incorrect", 401);
    }
    this.limiter.clear(key);
    await this.ensureIndex(record);
    await recordAudit(this.db, record.id, "login", { ...context, email: record.email });
    return publicAccount(record);
  }

  async get(id: string): Promise<Account | null> {
    const indexed = await this.index(id);
    if (!indexed) return null;
    const record = await this.find(indexed.email);
    return record && record.id === id ? publicAccount(record) : null;
  }

  async byEmail(email: string): Promise<Account | null> {
    const record = await this.find(normalizeEmail(email));
    return record ? publicAccount(record) : null;
  }

  async changePassword(
    accountId: string,
    oldPassword: string,
    newPassword: string,
    context: RequestContext = {},
  ): Promise<Account> {
    assertPassword(newPassword, "New password");
    const indexed = await this.index(accountId);
    const record = indexed ? await this.find(indexed.email) : null;
    if (!record || record.id !== accountId) throw new AppError("Account not found", 404);
    if (!(await verifyPassword(oldPassword, record.passwordHash)))
      throw new AppError("Current password is incorrect", 401);
    const passwordHash = await hashPassword(newPassword);
    const updated = await this.db.compareAndSwap<AccountRecord>(
      ACCOUNT_SCOPE,
      ACCOUNT_KIND,
      record.email,
      { passwordHash: record.passwordHash },
      { passwordHash, updatedAt: new Date().toISOString() },
    );
    if (!updated) throw new AppError("Password changed elsewhere. Try again.", 409);
    await recordAudit(this.db, accountId, "password_change", {
      ...context,
      email: record.email,
    });
    return publicAccount({ ...record, passwordHash });
  }

  async audit(accountId: string, event: AuditEvent, context: RequestContext = {}) {
    const indexed = await this.index(accountId);
    const record = indexed ? await this.find(indexed.email) : null;
    await recordAudit(this.db, accountId, event, { ...context, email: record?.email });
  }
}

/** Defensive session check: a deleted account can never keep a live session. */
export async function accountExists(db: Store, accountId: string): Promise<boolean> {
  return Boolean(await db.get(ACCOUNT_SCOPE, ACCOUNT_ID_KIND, accountId));
}

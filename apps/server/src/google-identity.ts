import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Account, AccountService, RequestContext } from "./accounts.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { AppError } from "./errors.ts";

/**
 * Sign in with Google, identity only. The calendar connect path in
 * `google-auth.ts` owns mail and calendar scopes; this path never requests them.
 * `openid email profile` are non-sensitive OpenID Connect scopes that need no
 * Google verification review.
 */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"] as const;
const STATE_TTL_MS = 10 * 60 * 1000;
/** The dashboard swaps this for a bearer immediately; keep the window tiny. */
const CODE_TTL_MS = 60 * 1000;
/** Bound the in-memory code map if many starts never complete. */
const MAX_PENDING_CODES = 10_000;

type GoogleState = {
  redirectBase: string;
  nonce: string;
  expiresAt: number;
};

interface PendingCode {
  accountId: string;
  expiresAt: number;
}

const tokenSchema = z.object({ access_token: z.string().min(1) });
// The userinfo endpoint is the authoritative source: the access token came back
// from Google's token endpoint using this server's client secret, so a 200 here
// also proves the id_token's audience and issuer belong to this client.
const profileSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});

/**
 * A usable dashboard origin, or null. Only http and https are accepted, and the
 * path/query/hash are dropped so a state can never smuggle a nested redirect.
 */
export function dashboardOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

export class GoogleIdentity {
  private readonly codes = new Map<string, PendingCode>();
  constructor(
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly accounts: AccountService,
  ) {}

  configured() {
    return Boolean(this.config.googleClientId && this.config.googleClientSecret);
  }

  /** Origins the browser may be sent back to: the allowlist plus the API's own. */
  private allowedRedirects(): Set<string> {
    const allowed = new Set<string>();
    for (const value of this.config.allowedOrigins) {
      const origin = dashboardOrigin(value);
      if (origin) allowed.add(origin);
    }
    const api = dashboardOrigin(this.config.publicUrl);
    if (api) allowed.add(api);
    return allowed;
  }

  /**
   * This path's own redirect, distinct from the calendar flow's
   * `/api/google/callback`, so each is registered independently.
   */
  redirectUri() {
    return `${this.config.publicUrl}/api/auth/google/callback`;
  }

  /** A signed, self-expiring state that carries where to return the dashboard. */
  start(redirectBase: unknown) {
    if (!this.configured())
      throw new AppError("Google sign-in is not configured on this server.", 503);
    const origin = dashboardOrigin(redirectBase);
    if (!origin) throw new AppError("A dashboard redirect URL is required", 400);
    // Without this check anyone could call `start` with their own origin, be
    // handed the one-time code in the redirect, and redeem it for the session.
    if (!this.allowedRedirects().has(origin))
      throw new AppError(
        `That dashboard address is not allowed to sign in. Add ${origin} to ALLOWED_ORIGINS on the server.`,
        403,
      );
    const state: GoogleState = {
      redirectBase: origin,
      nonce: randomBytes(16).toString("base64url"),
      expiresAt: Date.now() + STATE_TTL_MS,
    };
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId ?? "",
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: GOOGLE_IDENTITY_SCOPES.join(" "),
      state: this.auth.signPayload(state),
    }).toString();
    return { url: url.toString() };
  }

  /** Decode a state from `start`; null when the signature is missing or wrong. */
  state(value: string | undefined): GoogleState | null {
    if (!value) return null;
    const decoded = this.auth.verifyPayload<GoogleState>(value);
    if (
      !decoded ||
      typeof decoded.redirectBase !== "string" ||
      typeof decoded.nonce !== "string" ||
      typeof decoded.expiresAt !== "number"
    )
      return null;
    return decoded;
  }

  /** Exchange the code, resolve the Google email, and find-or-create the account. */
  async complete(code: string, context: RequestContext): Promise<Account> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.googleClientId ?? "",
        client_secret: this.config.googleClientSecret ?? "",
        redirect_uri: this.redirectUri(),
        grant_type: "authorization_code",
        code,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new AppError("Google could not complete sign-in. Try again.", 502);
    // Only the access token is read; the id_token is never parsed, logged or stored.
    const token = tokenSchema.parse(await response.json());
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!profileResponse.ok)
      throw new AppError("Google did not return an email address. Try again.", 502);
    const profile = profileSchema.parse(await profileResponse.json());
    if (profile.email_verified === false)
      throw new AppError("Your Google email address is not verified", 403);
    const { account, created } = await this.accounts.findOrCreateByEmail(
      profile.email,
      profile.name,
    );
    await this.accounts.audit(account.id, created ? "google_signup" : "google_login", context);
    return account;
  }

  /** Mint a single-use code the dashboard swaps for a session, server-to-server. */
  issueCode(accountId: string): string {
    this.prune();
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { accountId, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  /** Consume a code exactly once; null when unknown, expired or already used. */
  redeemCode(code: string): string | null {
    this.prune();
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    return entry.expiresAt < Date.now() ? null : entry.accountId;
  }

  private prune() {
    const now = Date.now();
    for (const [code, entry] of this.codes) if (entry.expiresAt < now) this.codes.delete(code);
    while (this.codes.size > MAX_PENDING_CODES) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
  }
}

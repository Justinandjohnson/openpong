import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { OPENPONG_ACCESS_KEY } from "./openpong";

/**
 * The account bearer lives in an httpOnly, AES-GCM sealed cookie. Sealing it
 * (rather than keeping a process-local map) means any dashboard instance can
 * serve the next request after a scale-out or restart.
 */
export const ACCOUNT_COOKIE = "openpong_account";
const MAX_AGE = 30 * 24 * 60 * 60;

function secret(): Buffer {
  const raw =
    process.env.OPENPONG_COOKIE_SECRET?.trim() ||
    OPENPONG_ACCESS_KEY ||
    "openpong-dev-cookie-secret-change-me";
  return createHash("sha256").update(raw).digest();
}

export function sealToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret(), iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

export function openToken(sealed: string): string | null {
  const [iv, tag, body] = sealed.split(".");
  if (!iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secret(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export async function readAccountToken(): Promise<string | null> {
  const sealed = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  return sealed ? openToken(sealed) : null;
}

export async function setAccountToken(token: string): Promise<void> {
  (await cookies()).set(ACCOUNT_COOKIE, sealToken(token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearAccountToken(): Promise<void> {
  (await cookies()).delete(ACCOUNT_COOKIE);
}

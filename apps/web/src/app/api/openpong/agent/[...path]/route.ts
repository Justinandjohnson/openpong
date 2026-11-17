import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent control plane for the dashboard: approvals, task control, watch control
 * and notification reads.
 *
 * The browser never talks to the OpenPong server. Every call is matched against
 * a small allowlist so this proxy cannot be turned into a general-purpose
 * passthrough, and the bearer stays in this process.
 */
const ALLOWED: RegExp[] = [
  /^actions$/,
  /^actions\/[\w-]+\/decide$/,
  /^tasks$/, // not used by the dashboard, but the server owns it
  /^tasks\/[\w-]+$/,
  /^tasks\/[\w-]+\/(control|input)$/,
  /^monitors\/[\w-]+\/control$/,
  /^notifications\/[\w-]+\/read$/,
  /^calendar$/,
  /^calendar\/(connect|sync|feed\/rotate)$/,
  /^phone$/,
  /^phone\/test$/,
  // The owner's computer (relay companion): status, pairing, pending gates.
  /^companion$/,
  /^companion\/pairing$/,
  /^companion\/gates$/,
  /^companion\/gates\/[\w-]+\/clear$/,
];

function allowed(path: string): boolean {
  return ALLOWED.some((pattern) => pattern.test(path));
}

async function forward(
  request: Request,
  method: "GET" | "POST" | "DELETE",
  segments: string[] | undefined,
) {
  const path = (segments ?? []).join("/");
  if (!path || !allowed(path)) {
    return NextResponse.json({ error: "Unknown agent route" }, { status: 404 });
  }

  let body: string | undefined;
  if (method === "POST") {
    try {
      body = JSON.stringify((await request.json()) ?? {});
    } catch {
      body = "{}";
    }
  }

  try {
    const token = await requiredOpenPongToken();
    // Approvals live on /api/actions/:id/decide; everything else on /api/agent/*.
    const upstream = path.startsWith("actions/")
      ? `${OPENPONG_SERVER_URL}/api/${path}`
      : `${OPENPONG_SERVER_URL}/api/agent/${path}`;
    const result = await fetchJson(upstream, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      const detail = (result.data as { error?: string } | null)?.error;
      return NextResponse.json(
        {
          error: typeof detail === "string" && detail ? detail : "The agent refused that request",
          detail: result.data,
        },
        { status: result.status },
      );
    }
    return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent unavailable" },
      { status: 502 },
    );
  }
}

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  return forward(request, "GET", path);
}

export async function POST(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  return forward(request, "POST", path);
}

export async function DELETE(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  return forward(request, "DELETE", path);
}

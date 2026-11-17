import { OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CopilotKit runtime proxy.
 *
 * The client points at this same-origin URL. The BFF attaches the OpenPong bearer
 * token (from the httpOnly session cookie) and streams the runtime's SSE response
 * straight back, so chat and dashboard share one agent and one set of threads.
 */
async function proxy(request: Request, segments: string[] | undefined) {
  const token = await requiredOpenPongToken();
  const incoming = new URL(request.url);
  const suffix = (segments ?? []).map(encodeURIComponent).join("/");
  const target = `${OPENPONG_SERVER_URL}/api/copilotkit${suffix ? `/${suffix}` : ""}${incoming.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    const name = key.toLowerCase();
    if (["host", "content-length", "connection", "accept-encoding", "cookie"].includes(name))
      continue;
    headers.set(key, value);
  }
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "text/event-stream");

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    duplex: "half",
    redirect: "manual",
    cache: "no-store",
    signal: request.signal,
  } as RequestInit & { duplex: "half" });

  const responseHeaders = new Headers();
  for (const [key, value] of response.headers) {
    const name = key.toLowerCase();
    if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name))
      continue;
    responseHeaders.set(key, value);
  }
  responseHeaders.set("cache-control", "no-store, no-transform");
  responseHeaders.set("x-accel-buffering", "no");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function POST(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function PUT(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function DELETE(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

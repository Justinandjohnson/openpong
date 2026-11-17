import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record one match result the owner reported.
 *
 * The browser never talks to the OpenPong server directly, so the bearer stays
 * in this process. The server route validates the body again and calls the
 * OmniPong service, which derives the winner/loser from the owner row and
 * dedupes a repeated result (a retry returns the existing row).
 */
const upstream = `${OPENPONG_SERVER_URL}/api/agent/matches`;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send the match result as JSON" }, { status: 400 });
  }

  try {
    const token = await requiredOpenPongToken();
    const result = await fetchJson(upstream, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body ?? {}),
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      const data = result.data as { error?: string; detail?: string } | null;
      const detail = typeof data?.error === "string" ? data.error : data?.detail;
      return NextResponse.json(
        {
          error:
            typeof detail === "string" && detail
              ? detail
              : "That result was not saved. Check the opponent name, date and scores.",
          detail: result.data,
        },
        { status: result.status === 200 || result.status === 201 ? 400 : result.status },
      );
    }
    return NextResponse.json(result.data, {
      status: result.status,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save the match" },
      { status: 502 },
    );
  }
}

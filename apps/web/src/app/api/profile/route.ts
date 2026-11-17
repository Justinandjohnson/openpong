import { NextResponse } from "next/server";
import { fetchJson, OPENPONG_SERVER_URL } from "@/lib/server/openpong";
import { requiredOpenPongToken } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The owner's own profile (identity + area + league URLs).
 *
 * This is the record that replaces every hard-coded name, USATT number, region,
 * city or club: first-run onboarding fills it in, Settings edits it, and the
 * agent reads it through `get_my_profile`. The browser never talks to the
 * OpenPong server directly, so the bearer stays in this process.
 */
const upstream = `${OPENPONG_SERVER_URL}/api/agent/profile`;

async function bearer(): Promise<string> {
  return requiredOpenPongToken();
}

export async function GET() {
  try {
    const token = await bearer();
    const result = await fetchJson(upstream, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: "The OpenPong server did not return a profile", detail: result.data },
        { status: result.status },
      );
    }
    return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Profile unavailable" },
      { status: 502 },
    );
  }
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Send the profile as JSON" }, { status: 400 });
  }

  try {
    const token = await bearer();
    const result = await fetchJson(upstream, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body ?? {}),
      timeoutMs: 15_000,
    });
    if (!result.ok) {
      const detail = (result.data as { error?: string; detail?: string } | null)?.error;
      return NextResponse.json(
        {
          error:
            typeof detail === "string" && detail
              ? detail
              : "Those details were not saved. Check the name, USATT number and league URLs.",
          detail: result.data,
        },
        { status: result.status === 200 ? 400 : result.status },
      );
    }
    return NextResponse.json(result.data, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save the profile" },
      { status: 502 },
    );
  }
}

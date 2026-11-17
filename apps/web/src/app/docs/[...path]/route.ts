import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve the repository's operator guides (for example docs/GOOGLE_SETUP.md) at
 * /docs/<file>, so an in-app "Set up Google" link is never dead. Only markdown
 * files directly under docs/ are readable; anything else is a 404.
 */
function docsRoots(): string[] {
  const cwd = process.cwd();
  // `next start` runs from apps/web; a repo-root cwd is the second candidate.
  return [path.resolve(cwd, "..", "..", "docs"), path.resolve(cwd, "docs")];
}

export async function GET(_request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const { path: segments } = await context.params;
  const name = (segments ?? []).join("/");
  // A single markdown filename with no path separators: no traversal.
  if (!/^[A-Za-z0-9._-]+\.md$/.test(name))
    return NextResponse.json({ error: "Unknown document" }, { status: 404 });

  for (const root of docsRoots()) {
    try {
      const body = await readFile(path.join(root, name), "utf8");
      return new NextResponse(body, {
        headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
      });
    } catch {
      // Try the next candidate root.
    }
  }
  return NextResponse.json(
    { error: "That guide is not available on this deployment." },
    { status: 404 },
  );
}

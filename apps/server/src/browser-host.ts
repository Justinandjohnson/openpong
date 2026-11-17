/**
 * The app's own browser, started inside this process.
 *
 * OpenPong ships a Playwright worker (apps/worker) that keeps a real Chromium
 * per session with a persistent profile. Running it here means the dashboard
 * has a working browser with no extra process, no extension and nothing for
 * the owner to install — they can watch it and take control for a login.
 *
 * If Playwright is not installed the import fails and the caller simply runs
 * without a browser, reporting that honestly instead of refusing to boot.
 */
import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";

export interface InProcessBrowser {
  url: string;
  token: string;
  close: () => Promise<void>;
}

export async function startInProcessBrowser(config: Config): Promise<InProcessBrowser> {
  const { createWorkerServer } = await import("../../worker/src/server.ts");
  const token = `local_${randomBytes(24).toString("hex")}`;
  const worker = await createWorkerServer({
    token,
    dataDir: `${config.dataDir}/browser-profiles`,
    maxSessions: 3,
    idleTimeoutMs: 30 * 60_000,
  });
  const port = await new Promise<number>((resolve, reject) => {
    worker.server.once("error", reject);
    worker.server.listen(0, "127.0.0.1", () => {
      const address = worker.server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("The browser worker did not report a port"));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: async () => {
      await worker.close();
      await new Promise<void>((resolve) => worker.server.close(() => resolve()));
    },
  };
}

import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
// The app's own browser: started in-process unless the host pointed at a
// separate worker. A missing Playwright install degrades to "no browser"
// instead of a failed boot.
let browserHost: { close: () => Promise<void> } | undefined;
if (!config.workerUrl) {
  try {
    const { startInProcessBrowser } = await import("./browser-host.ts");
    const host = await startInProcessBrowser(config);
    config.workerUrl = host.url;
    config.workerToken = host.token;
    browserHost = host;
  } catch (error) {
    console.warn(
      `[OpenPong] Browser disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
const { app, agent } = await createApp(db, config);
if (config.taskWorkerEnabled) agent.start();
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenPong ${config.mode} API ready at ${config.publicUrl}`),
);
const shutdown = () => {
  server.close(() => {
    void agent
      .stop()
      .then(() => browserHost?.close())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

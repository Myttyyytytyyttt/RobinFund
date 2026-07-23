import { serve } from "@hono/node-server";
import { createConfiguredGateway } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, services } = createConfiguredGateway(config);

const server = serve({ fetch: app.fetch, port: config.PORT });
console.info(JSON.stringify({
  level: "info",
  message: "Nuvem agent gateway listening",
  port: config.PORT,
  chainId: services.chain.chainId,
}));

async function shutdown(): Promise<void> {
  server.close();
  await services.store.close();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

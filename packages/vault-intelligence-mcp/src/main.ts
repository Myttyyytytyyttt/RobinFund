import { serve } from "@hono/node-server";
import { createConfiguredVaultIntelligenceApp } from "./app.js";

const port = Number(process.env.MCP_PORT ?? 8790);
if (!Number.isSafeInteger(port) || port <= 0) throw new Error("MCP_PORT must be a positive integer");
const app = createConfiguredVaultIntelligenceApp();
serve({ fetch: app.fetch, port });
console.info(JSON.stringify({ level: "info", message: "Nuvem MCP listening", port }));

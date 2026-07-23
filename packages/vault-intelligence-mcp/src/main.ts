import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAddress, type Address } from "viem";
import { createMcpHandler } from "./server.js";
import { SubgraphIntelligenceSource } from "./source.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(process.env.MCP_PORT ?? 8790);
const source = new SubgraphIntelligenceSource(
  required("GRAPH_URL"),
  required("RH_RPC_MAINNET"),
  required("GRAPH_DEPLOYMENT_ID"),
);
const handler = createMcpHandler(source, getAddress(required("USDG_ADDRESS")).toLowerCase() as Address);
const app = new Hono();
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["content-type", "mcp-session-id", "last-event-id", "mcp-protocol-version"],
  exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
}));
app.get("/healthz", (c) => c.json({ ok: true, service: "nuvem-vault-intelligence-mcp", readOnly: true }));
app.all("/mcp", (c) => handler(c.req.raw));
serve({ fetch: app.fetch, port });
console.info(JSON.stringify({ level: "info", message: "Nuvem MCP listening", port }));

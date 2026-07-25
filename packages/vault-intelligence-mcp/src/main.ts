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
const chainId = Number(required("RH_CHAIN_ID"));
if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("RH_CHAIN_ID must be a positive integer");
const source = new SubgraphIntelligenceSource({
  graphUrl: required("GRAPH_URL"),
  rpcUrl: required("RH_RPC_URL"),
  deploymentId: required("GRAPH_DEPLOYMENT_ID"),
  expectedChainId: chainId,
  maxBlockLag: BigInt(process.env.GRAPH_MAX_BLOCK_LAG ?? 50),
  maxAgeSeconds: Number(process.env.GRAPH_MAX_AGE_SECONDS ?? 300),
  requestTimeoutMs: Number(process.env.GRAPH_TIMEOUT_MS ?? 10_000),
});
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

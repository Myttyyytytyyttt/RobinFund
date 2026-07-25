import { Hono } from "hono";
import { cors } from "hono/cors";
import { getAddress, type Address } from "viem";
import { createMcpHandler } from "./server.js";
import { IntelligenceError, SubgraphIntelligenceSource } from "./source.js";
import type { IntelligenceSource, Provenance } from "./types.js";

type RuntimeEnv = Record<string, string | undefined>;

export interface VaultIntelligenceAppOptions {
  source: IntelligenceSource;
  stablecoin: Address;
}

function serializable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_, entry) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Date) return entry.toISOString();
    return entry;
  })) as unknown;
}

function required(env: RuntimeEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readinessError(error: unknown): { code: string; message: string } {
  if (error instanceof IntelligenceError) {
    return { code: error.code, message: error.message };
  }
  return { code: "GRAPH_READINESS_FAILED", message: "Graph readiness check failed" };
}

export function createVaultIntelligenceApp(options: VaultIntelligenceAppOptions): Hono {
  const handler = createMcpHandler(options.source, options.stablecoin);
  const app = new Hono();

  app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "mcp-session-id", "last-event-id", "mcp-protocol-version"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    maxAge: 600,
  }));
  app.get("/healthz", (c) => c.json({
    ok: true,
    service: "nuvem-vault-intelligence-mcp",
    readOnly: true,
  }));
  app.get("/readyz", async (c) => {
    try {
      const sample = await options.source.listVaults(1);
      return c.json(serializable({
        ok: true,
        graph: {
          indexedVaultsSampled: sample.data.length,
          provenance: sample.provenance satisfies Provenance,
        },
      }));
    } catch (error) {
      return c.json({
        ok: false,
        error: readinessError(error),
      }, 503);
    }
  });
  app.all("/mcp", (c) => handler(c.req.raw));

  return app;
}

export function createConfiguredVaultIntelligenceApp(
  env: RuntimeEnv = process.env,
): Hono {
  const chainId = positiveInteger(required(env, "RH_CHAIN_ID"), "RH_CHAIN_ID");
  const source = new SubgraphIntelligenceSource({
    graphUrl: required(env, "GRAPH_URL"),
    rpcUrl: required(env, "RH_RPC_URL"),
    deploymentId: required(env, "GRAPH_DEPLOYMENT_ID"),
    expectedChainId: chainId,
    maxBlockLag: BigInt(env.GRAPH_MAX_BLOCK_LAG ?? 50),
    maxAgeSeconds: positiveInteger(env.GRAPH_MAX_AGE_SECONDS ?? "300", "GRAPH_MAX_AGE_SECONDS"),
    requestTimeoutMs: positiveInteger(env.GRAPH_TIMEOUT_MS ?? "10000", "GRAPH_TIMEOUT_MS"),
  });
  const stablecoin = getAddress(required(env, "USDG_ADDRESS")).toLowerCase() as Address;
  return createVaultIntelligenceApp({ source, stablecoin });
}

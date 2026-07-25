import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getAddress, type Address } from "viem";
import * as z from "zod/v4";
import { simulateRebalance } from "./risk.js";
import type { IntelligenceSource, Provenance } from "./types.js";

function serializable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_, entry) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Date) return entry.toISOString();
    return entry;
  })) as unknown;
}

function result(data: unknown, provenance: Provenance) {
  const payload = serializable({ data, provenance });
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload as Record<string, unknown> };
}

function address(value: string): Address {
  return getAddress(value).toLowerCase() as Address;
}

export function createVaultIntelligenceServer(source: IntelligenceSource, stablecoin: Address): McpServer {
  const server = new McpServer({ name: "nuvem-vault-intelligence", version: "0.1.0" });

  server.registerTool("get_indexer_status", {
    title: "Verify Graph indexer",
    description: "Verify deployment identity, Robinhood chain, indexing health and freshness before using any vault data.",
    inputSchema: {},
  }, async () => {
    const value = await source.listVaults(1);
    return result({ healthy: true, sampledVaults: value.data.length }, value.provenance);
  });

  server.registerTool("list_vaults", {
    title: "List Nuvem vaults",
    description: "List Graph-indexed Nuvem vaults with a provenance cursor.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(25) },
  }, async ({ limit }) => {
    const value = await source.listVaults(limit);
    return result(value.data, value.provenance);
  });

  server.registerTool("get_vault_state", {
    title: "Get vault state",
    description: "Read NAV, lifecycle, policy counters and manager type from the Nuvem subgraph.",
    inputSchema: { vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  }, async ({ vault }) => {
    const value = await source.vault(address(vault));
    return result(value.data, value.provenance);
  });

  server.registerTool("get_vault_performance", {
    title: "Get vault performance",
    description: "Return share-price and capital-flow performance fields. The flow return is labelled approximate, not time-weighted.",
    inputSchema: { vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  }, async ({ vault }) => {
    const value = await source.vault(address(vault));
    const netFlow6 = value.data.lifetimeDeposited6 - value.data.lifetimeWithdrawn6;
    const nav6 = value.data.navWad / 1_000_000_000_000n;
    const approximateReturnBps = netFlow6 > 0n ? Number((nav6 - netFlow6) * 10_000n / netFlow6) : null;
    return result({
      lastPeWad: value.data.lastPeWad,
      navWad: value.data.navWad,
      navValid: value.data.navValid,
      navUpdatedAt: value.data.navUpdatedAt,
      totalShares: value.data.totalShares,
      lifetimeDeposited6: value.data.lifetimeDeposited6,
      lifetimeWithdrawn6: value.data.lifetimeWithdrawn6,
      approximateFlowReturnBps: approximateReturnBps,
      caveat: "Flow return is not time-weighted and must not be presented as audited performance.",
    }, value.provenance);
  });

  server.registerTool("get_holdings", {
    title: "Get vault holdings",
    description: "Return per-token balances and oracle-valued WAD holdings.",
    inputSchema: { vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/) },
  }, async ({ vault }) => {
    const value = await source.vault(address(vault));
    return result(value.data.holdings, value.provenance);
  });

  server.registerTool("get_recent_trades", {
    title: "Get recent trades",
    description: "Return recent controller/Fund trade deltas and transaction hashes.",
    inputSchema: { vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/), limit: z.number().int().min(1).max(50).default(20) },
  }, async ({ vault, limit }) => {
    const value = await source.vault(address(vault));
    return result(value.data.recentTrades.slice(0, limit), value.provenance);
  });

  const rebalanceSchema = {
    vault: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    tokenOut: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    spentValueWad: z.string().regex(/^[1-9][0-9]*$/),
    receivedValueWad: z.string().regex(/^[0-9]+$/),
    maxSlippageBps: z.number().int().min(1).max(10_000),
  };
  server.registerTool("simulate_rebalance", {
    title: "Simulate rebalance",
    description: "Pure read-only projection of trade size, slippage, concentration, turnover and count against indexed policy.",
    inputSchema: rebalanceSchema,
  }, async (input) => {
    const value = await source.vault(address(input.vault));
    const simulation = simulateRebalance(value.data, {
      tokenOut: address(input.tokenOut),
      spentValueWad: BigInt(input.spentValueWad),
      receivedValueWad: BigInt(input.receivedValueWad),
      stablecoin,
      maxSlippageBps: input.maxSlippageBps,
    });
    return result(simulation, value.provenance);
  });

  server.registerTool("assess_trade_risk", {
    title: "Assess trade risk",
    description: "Explain each active policy check for a proposed trade. It never signs or relays.",
    inputSchema: rebalanceSchema,
  }, async (input) => {
    const value = await source.vault(address(input.vault));
    const simulation = simulateRebalance(value.data, {
      tokenOut: address(input.tokenOut),
      spentValueWad: BigInt(input.spentValueWad),
      receivedValueWad: BigInt(input.receivedValueWad),
      stablecoin,
      maxSlippageBps: input.maxSlippageBps,
    });
    return result({ approved: simulation.approved, checks: simulation.checks }, value.provenance);
  });
  return server;
}

export function createMcpHandler(source: IntelligenceSource, stablecoin: Address) {
  return async (request: Request): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createVaultIntelligenceServer(source, stablecoin);
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  };
}

import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { IntelligenceError, SubgraphIntelligenceSource } from "../src/source.js";

const vault = "0x1111111111111111111111111111111111111111" as Address;
const now = () => Math.floor(Date.now() / 1_000).toString();

function envelope(meta: Record<string, unknown> = {}) {
  const indexedVault = {
    id: vault,
    controller: "0x2222222222222222222222222222222222222222",
    agentId: `0x${"33".repeat(32)}`,
    managerType: "agent",
    state: 0,
    navWad: "1000",
    navValid: true,
    navUpdatedAt: now(),
    navObservedAt: now(),
    totalShares: "1000",
    lastPeWad: "1000000000000000000",
    lifetimeDeposited6: "1",
    lifetimeWithdrawn6: "0",
    turnoverTodayWad: "0",
    tradesToday: 0,
    lastTradeAt: null,
    controllerRecord: { id: "controller", enabled: true, paused: false, policyHash: `0x${"44".repeat(32)}` },
    agent: { id: "agent", status: 1, backedUntil: "4102444800" },
    policy: {
      policyHash: `0x${"44".repeat(32)}`,
      maxTradeBps: 1000,
      maxConcentrationBps: 3500,
      dailyTurnoverBps: 5000,
      maxSlippageBps: 75,
      maxTradesPerDay: 24,
      minTradeInterval: 300,
      maxIntentLifetime: 600,
    },
    holdings: [],
    trades: [],
  };
  return {
    data: {
      _meta: {
        deployment: "QmExpected",
        hasIndexingErrors: false,
        block: { number: "100", hash: `0x${"ab".repeat(32)}`, timestamp: now() },
        ...meta,
      },
      vault: indexedVault,
      vaults: [indexedVault],
    },
  };
}

function source(meta: Record<string, unknown> = {}, chainId = 46630) {
  const fetchImpl = async () => new Response(JSON.stringify(envelope(meta)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  return new SubgraphIntelligenceSource({
    graphUrl: "https://graph.example/graphql",
    rpcUrl: "https://rpc.example",
    deploymentId: "QmExpected",
    expectedChainId: 46630,
    maxBlockLag: 5n,
    maxAgeSeconds: 30,
  }, fetchImpl as typeof fetch, {
    getBlockNumber: async () => 102n,
    getChainId: async () => chainId,
  });
}

describe("subgraph provenance", () => {
  it("returns a chain-bound deployment cursor", async () => {
    const result = await source().listVaults(1);
    expect(result.data[0]?.navValid).toBe(true);
    expect(result.provenance).toMatchObject({
      deploymentId: "QmExpected",
      chainId: 46630,
      blockNumber: 100n,
      chainHeadBlock: 102n,
      blockLag: 2n,
      indexingErrors: false,
    });
  });

  it("rejects a different deployment", async () => {
    await expect(source({ deployment: "QmOther" }).listVaults(1))
      .rejects.toMatchObject<IntelligenceError>({ code: "GRAPH_DEPLOYMENT_MISMATCH" });
  });

  it("rejects indexing errors", async () => {
    await expect(source({ hasIndexingErrors: true }).listVaults(1))
      .rejects.toMatchObject<IntelligenceError>({ code: "GRAPH_INDEXING_ERRORS" });
  });

  it("rejects an RPC connected to another chain", async () => {
    await expect(source({}, 4663).listVaults(1))
      .rejects.toMatchObject<IntelligenceError>({ code: "RPC_CHAIN_MISMATCH" });
  });

  it("rejects a stale per-vault NAV observation even with a fresh Graph cursor", async () => {
    const fetchImpl = async () => {
      const payload = envelope();
      payload.data.vault.navObservedAt = String(Math.floor(Date.now() / 1_000) - 31);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const stale = new SubgraphIntelligenceSource({
      graphUrl: "https://graph.example/graphql",
      rpcUrl: "https://rpc.example",
      deploymentId: "QmExpected",
      expectedChainId: 46630,
      maxBlockLag: 5n,
      maxAgeSeconds: 30,
    }, fetchImpl as typeof fetch, {
      getBlockNumber: async () => 102n,
      getChainId: async () => 46630,
    });
    await expect(stale.vault(vault))
      .rejects.toMatchObject<IntelligenceError>({ code: "VAULT_SNAPSHOT_STALE" });
  });
});

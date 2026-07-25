import { zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  createConfiguredVaultIntelligenceApp,
  createVaultIntelligenceApp,
} from "../src/app.js";
import { IntelligenceError } from "../src/source.js";
import type { IntelligenceSource, Provenance, VaultState } from "../src/types.js";

const provenance: Provenance = {
  deploymentId: "QmExpected",
  chainId: 46630,
  blockNumber: 100n,
  blockHash: `0x${"ab".repeat(32)}`,
  blockTimestamp: new Date("2026-07-25T12:00:00.000Z"),
  chainHeadBlock: 102n,
  blockLag: 2n,
  indexingErrors: false,
  observedAt: new Date("2026-07-25T12:00:01.000Z"),
  ageSeconds: 1,
};

function source(
  listVaults: IntelligenceSource["listVaults"] = async () => ({
    data: [] as VaultState[],
    provenance,
  }),
): IntelligenceSource {
  return {
    listVaults,
    vault: async () => {
      throw new Error("not used");
    },
  };
}

describe("vault intelligence HTTP app", () => {
  it("exposes a public read-only health response", async () => {
    const app = createVaultIntelligenceApp({ source: source(), stablecoin: zeroAddress });
    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "nuvem-vault-intelligence-mcp",
      readOnly: true,
    });
  });

  it("serializes Graph provenance in readiness responses", async () => {
    const app = createVaultIntelligenceApp({ source: source(), stablecoin: zeroAddress });
    const response = await app.request("/readyz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      graph: {
        indexedVaultsSampled: 0,
        provenance: {
          deploymentId: "QmExpected",
          blockNumber: "100",
          blockTimestamp: "2026-07-25T12:00:00.000Z",
        },
      },
    });
  });

  it("fails readiness closed without exposing runtime internals", async () => {
    const failing = source(async () => {
      throw new IntelligenceError("GRAPH_UNAVAILABLE", "Subgraph endpoint is unavailable");
    });
    const app = createVaultIntelligenceApp({ source: failing, stablecoin: zeroAddress });
    const response = await app.request("/readyz");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "GRAPH_UNAVAILABLE",
        message: "Subgraph endpoint is unavailable",
      },
    });
  });

  it("validates serverless runtime configuration eagerly", () => {
    expect(() => createConfiguredVaultIntelligenceApp({})).toThrow("RH_CHAIN_ID is required");
    expect(() => createConfiguredVaultIntelligenceApp({
      RH_CHAIN_ID: "not-a-number",
      GRAPH_URL: "https://graph.example/graphql",
      RH_RPC_URL: "https://rpc.example",
      GRAPH_DEPLOYMENT_ID: "QmExpected",
      USDG_ADDRESS: zeroAddress,
    })).toThrow("RH_CHAIN_ID must be a positive integer");
  });
});

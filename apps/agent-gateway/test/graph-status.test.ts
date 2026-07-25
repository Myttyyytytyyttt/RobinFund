import { describe, expect, it } from "vitest";
import { createGatewayApp, type GatewayAppDependencies } from "../src/app.js";
import { GraphDataError, type VaultIntelligence } from "../src/graph.js";

function graph(): VaultIntelligence {
  const now = new Date();
  return {
    listVaults: async () => ({
      vaults: [],
      provenance: {
        deploymentId: "QmPinned",
        chainId: 46630,
        blockNumber: 100n,
        blockHash: null,
        blockTimestamp: now,
        chainHeadBlock: 101n,
        blockLag: 1n,
        indexingErrors: false,
        observedAt: now,
        ageSeconds: 0,
      },
    }),
    getVaultContext: async () => {
      throw new Error("not used");
    },
  };
}

function app(source: VaultIntelligence, graphEnabled = true) {
  return createGatewayApp({
    graph: source,
    graphEnabled,
    tradingEnabled: false,
    allowedOrigins: [],
  } as unknown as GatewayAppDependencies);
}

describe("Graph health surfaces", () => {
  it("publishes the pinned deployment provenance and OpenAPI routes", async () => {
    const gateway = app(graph());
    const ready = await gateway.request("/readyz");
    const status = await gateway.request("/v1/graph/status");
    const openapi = await gateway.request("/openapi.json");

    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      graph: { enabled: true, provenance: { deploymentId: "QmPinned", chainId: 46630 } },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      healthy: true,
      provenance: { deploymentId: "QmPinned", blockLag: "1" },
    });
    const document = await openapi.json() as { paths: Record<string, unknown> };
    expect(document.paths).toHaveProperty("/readyz");
    expect(document.paths).toHaveProperty("/v1/graph/status");
    expect(document.paths).toHaveProperty("/mcp");
  });

  it("returns readiness 503 when Graph is stale", async () => {
    const source = graph();
    source.listVaults = async () => {
      throw new GraphDataError("GRAPH_STALE", "Subgraph cursor is stale", 409);
    };
    const gateway = app(source);

    const ready = await gateway.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      ok: false,
      graph: { enabled: true },
      error: { code: "GRAPH_STALE" },
    });
  });

  it("keeps readiness green but marks Graph status unavailable when disabled", async () => {
    const gateway = app(graph(), false);
    expect((await gateway.request("/readyz")).status).toBe(200);
    expect((await gateway.request("/v1/graph/status")).status).toBe(503);
  });
});

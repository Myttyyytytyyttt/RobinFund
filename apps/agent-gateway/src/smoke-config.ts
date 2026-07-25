import { createConfiguredGateway } from "./bootstrap.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, services } = createConfiguredGateway(config);
  try {
    const agentId = `0x${"00".repeat(32)}`;
    const [health, ready, graphStatus, openapi, mcp, context] = await Promise.all([
      app.request("/healthz"),
      app.request("/readyz"),
      app.request("/v1/graph/status"),
      app.request("/openapi.json"),
      app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      app.request(`/v1/agents/${agentId}/context`),
    ]);
    if (!health.ok || !openapi.ok) throw new Error("health/OpenAPI smoke failed");
    if (!config.GRAPH_ENABLED && (
      !ready.ok
      || graphStatus.status !== 503
      || mcp.status !== 503
      || context.status !== 503
    )) {
      throw new Error("disabled Graph surface did not fail closed");
    }
    if (config.GRAPH_ENABLED && (!ready.ok || !graphStatus.ok)) {
      throw new Error("enabled Graph data plane is not ready");
    }
    console.log(JSON.stringify({
      ok: true,
      chainId: services.chain.chainId,
      registry: services.chain.registryAddress,
      graphEnabled: config.GRAPH_ENABLED,
      tradingEnabled: config.TRADING_ENABLED,
      healthStatus: health.status,
      readinessStatus: ready.status,
      graphStatus: graphStatus.status,
      openapiStatus: openapi.status,
      mcpStatus: mcp.status,
      contextStatus: context.status,
    }, null, 2));
  } finally {
    await services.store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

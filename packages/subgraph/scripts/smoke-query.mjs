const url = process.env.GRAPH_URL ?? "http://127.0.0.1:8000/subgraphs/name/nuvem/robinhood-testnet";
const expectedDeployment = process.env.GRAPH_DEPLOYMENT_ID?.trim();
const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    query: `{
      _meta { deployment hasIndexingErrors block { number hash timestamp } }
      vaults(first: 5, orderBy: createdAt, orderDirection: desc) {
        id managerType state navWad navValid navUpdatedAt navObservedAt
        controllerRecord { id enabled paused policyHash }
        agent { id status backedUntil }
      }
    }`,
  }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`GraphQL smoke failed with HTTP ${response.status}`);
const envelope = await response.json();
if (envelope.errors?.length) throw new Error(`GraphQL smoke query failed: ${envelope.errors[0].message}`);
const meta = envelope.data?._meta;
if (!meta?.deployment || !meta.block?.number) throw new Error("GraphQL smoke response has no deployment cursor");
if (meta.hasIndexingErrors) throw new Error("Subgraph reports indexing errors");
if (expectedDeployment && meta.deployment !== expectedDeployment) {
  throw new Error(`Deployment mismatch: expected ${expectedDeployment}, received ${meta.deployment}`);
}
console.log(JSON.stringify({
  ok: true,
  deploymentId: meta.deployment,
  blockNumber: meta.block.number,
  blockHash: meta.block.hash,
  indexedVaults: envelope.data.vaults.length,
}, null, 2));

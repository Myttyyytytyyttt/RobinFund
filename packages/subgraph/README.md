# Nuvem Agents subgraph

The Graph read model used by autonomous agents on Robinhood Chain. It indexes the shared
`AgentRegistry`, every registered `Fund`, and each controller discovered from the registry.

Indexed data:

- agent sponsor, signer, World-backing status and metadata;
- controller policy, pause state and signer/controller lifecycle;
- dynamic Funds, holdings, trades, settlements, entry/performance fees and winding state;
- provenance fields consumed by the read-only Vault Intelligence MCP.

The checked-in `subgraph.yaml` intentionally contains impossible placeholder addresses. A deployment
must first generate `networks.json` from actual contract outputs; the configure command fails closed
for missing or placeholder addresses.

```powershell
$env:AGENT_REGISTRY_ADDRESS = "0x..."
$env:FUND_REGISTRY_ADDRESS = "0x..."
$env:SUBGRAPH_START_BLOCK = "123456"
pnpm build:robinhood
```

Separate start blocks can be supplied through `AGENT_REGISTRY_START_BLOCK` and
`FUND_REGISTRY_START_BLOCK`. Deploy only the generated Robinhood build to the chosen Graph Studio or
Subgraph Studio slug, then set `GRAPH_URL` and `GRAPH_DEPLOYMENT_ID` on the gateway/MCP backend.

```powershell
graph auth --studio <deploy-key>
graph deploy --studio <slug> --network robinhood
```

No deploy key, endpoint or service secret belongs in this package. Keep those in the root gitignored
`.env` or the production secret manager. Until a real deployment ID is configured, the gateway must
not advertise Graph-backed trading as live.

The controller template is started when `ControllerSet(agentId, controller, true)` is observed. Since
the controller emits its constructor events before discovery, that handler snapshots the initial
sponsor and policy directly from chain and is idempotent across disable/re-enable events.

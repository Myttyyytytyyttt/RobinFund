# The Graph × Robinhood testnet live proof

Date: 2026-07-25 (Europe/Lisbon)

## Scope

This evidence is for the local, live Robinhood testnet data plane. It does not claim a hosted
production endpoint or a public AI-managed Fund.

| Item | Verified value |
|---|---|
| Network | Robinhood testnet |
| Chain ID | `46630` |
| Graph Node | `graphprotocol/graph-node:v0.44.0` |
| Deployment ID | `QmaPySahm79dFwjM7uujcHfqEErLTuujJxMRPxxGvZoymU` |
| Local GraphQL | `http://127.0.0.1:8000/subgraphs/name/nuvem/robinhood-testnet` |
| AgentRegistry | `0xa27e31af49cea5113fe84f69c2b91b999b48491b` |
| FundRegistry | `0x696553ad390428abf3d95c90a3452917cbaa453c` |
| Snapshot canary | `0xec3a6902b3fdba7deef8139f16967da6429ce282` |

Graph Node indexing status reached `synced: true`, `health: healthy`, with no fatal error. A pinned
GraphQL smoke returned:

```json
{
  "ok": true,
  "deploymentId": "QmaPySahm79dFwjM7uujcHfqEErLTuujJxMRPxxGvZoymU",
  "blockNumber": 93481927,
  "blockHash": "0xcf77cffca0e51420b4bf703ab805a4431fbfadb5cb35ae32d56275dc128b1c03",
  "indexedVaults": 3
}
```

The deployment indexed three Funds and eight AgentRegistry entries. No public
`AgentVaultController` is registered yet, so none is represented as an executable AI vault.

## Live MCP proof

The standalone MCP was connected to the GraphQL endpoint above and the independent official
Robinhood testnet RPC. `smoke:live` discovered all eight read-only tools:

```text
assess_trade_risk
get_holdings
get_indexer_status
get_recent_trades
get_vault_performance
get_vault_state
list_vaults
simulate_rebalance
```

The MCP verified deployment `QmaPy...ZoymU`, chain `46630`, indexed block `93482056`, observed chain
head `93482060` and lag `4`. It then read the canary Fund and returned:

```json
{
  "managerType": "human",
  "state": 0,
  "navValid": false,
  "holdings": 1,
  "riskApproved": false,
  "failedChecks": [
    "agent_manager",
    "nav_valid",
    "controller_active",
    "world_backing",
    "policy"
  ]
}
```

This rejection is expected and is positive safety evidence: the current canary's oracle NAV is
invalid and it is human-managed. The integration does not invent an AI controller, valid NAV or
World backing to make the demo pass.

## Gateway integration proof

The built RobinFund gateway was started with Graph enabled and trading disabled, using temporary
non-secret configuration. Both public integration checks reached the same pinned data source:

```json
{
  "readyOk": true,
  "graphEnabled": true,
  "readyDeployment": "QmaPySahm79dFwjM7uujcHfqEErLTuujJxMRPxxGvZoymU",
  "readyChainId": 46630,
  "readyBlock": 93483245,
  "statusHealthy": true,
  "statusLag": 3
}
```

This verifies the live path through `/readyz` and `/v1/graph/status`, not only the standalone
GraphQL and MCP packages.

## Repository verification

- `pnpm build`: passed for subgraph, SDK, signer, MCP, runtime, gateway and website.
- `pnpm test`: passed with `345` deterministic checks.
- Breakdown: contracts/invariants `136`, gateway `140`, website `39`, MCP `13`, SDK `10`,
  reference runtime `7`.
- Two credentialed integration tests remain intentionally skipped without Supabase E2E
  configuration.

## Reproduce

```powershell
cd packages/subgraph
$env:RH_RPC_URL = "https://rpc.testnet.chain.robinhood.com"
pnpm graph-node:up
pnpm build:testnet
pnpm create:local # first run only
pnpm deploy:local

$env:GRAPH_URL = "http://127.0.0.1:8000/subgraphs/name/nuvem/robinhood-testnet"
$env:GRAPH_DEPLOYMENT_ID = "QmaPySahm79dFwjM7uujcHfqEErLTuujJxMRPxxGvZoymU"
pnpm smoke:local
```

Start the MCP with the same deployment ID, chain `46630`, the official RPC and the testnet USDG
address, then:

```powershell
cd packages/vault-intelligence-mcp
$env:MCP_URL = "http://127.0.0.1:8790/mcp"
$env:GRAPH_DEPLOYMENT_ID = "QmaPySahm79dFwjM7uujcHfqEErLTuujJxMRPxxGvZoymU"
$env:MCP_VAULT_ADDRESS = "0xec3a6902b3fdba7deef8139f16967da6429ce282"
$env:USDG_ADDRESS = "0x336c508083e2afe17c594a8ef5b8542efcf672d5"
pnpm smoke:live
```

## Honest remaining boundary

The first public AI controller/Fund still requires a real World Identity Check + AgentBook
registration and sponsor activation. A durable public Graph/MCP URL also remains to be hosted.
Until both exist, this is a live local integration and not a public production data plane.

# Nuvem Vault Intelligence MCP

Remote, read-only MCP server backed by the Nuvem subgraph on Robinhood Chain.

Tools:

- `get_indexer_status`
- `list_vaults`
- `get_vault_state`
- `get_vault_performance`
- `get_holdings`
- `get_recent_trades`
- `simulate_rebalance`
- `assess_trade_risk`

Every response carries the immutable deployment ID, RPC chain ID, indexed block/hash/timestamp,
observed chain head, block lag, indexing-error state and observation age. Calls fail closed when:

- the Graph endpoint or RPC is unavailable;
- the deployment ID or chain ID differs from the pinned runtime configuration;
- Graph reports indexing errors;
- the cursor exceeds `GRAPH_MAX_BLOCK_LAG` or `GRAPH_MAX_AGE_SECONDS`;
- a requested vault is not indexed.

Risk assessment also rejects an invalid/stale NAV, invalid holdings, non-active Fund lifecycle,
disabled/paused controller, missing policy, inactive agent or expired World backing. It is advisory
and never signs, quotes, relays, mutates policy or accepts arbitrary calldata.

```powershell
$env:GRAPH_URL = "http://127.0.0.1:8000/subgraphs/name/nuvem/robinhood-testnet"
$env:GRAPH_DEPLOYMENT_ID = "Qm..."
$env:RH_RPC_URL = "<private Robinhood RPC>"
$env:RH_CHAIN_ID = "46630"
$env:USDG_ADDRESS = "0x..."
$env:MCP_PORT = "8790"
pnpm dev
# Streamable HTTP: POST http://127.0.0.1:8790/mcp
```

From another terminal, verify tool discovery, provenance and an optional fail-closed canary:

```powershell
$env:MCP_URL = "http://127.0.0.1:8790/mcp"
$env:GRAPH_DEPLOYMENT_ID = "Qm..."
$env:MCP_VAULT_ADDRESS = "0x..." # optional
$env:USDG_ADDRESS = "0x..."      # optional risk check
pnpm smoke:live
```

Defaults are 50 blocks, 300 seconds and a 10-second request timeout. The same source implementation
is embedded by the agent gateway, preventing its REST context and `/mcp` interface from applying
different provenance rules.

# Nuvem Vault Intelligence MCP

Remote, read-only MCP server backed by the Nuvem subgraph on Robinhood Chain.

Tools:

- `list_vaults`
- `get_vault_state`
- `get_vault_performance`
- `get_holdings`
- `get_recent_trades`
- `get_market_liquidity`
- `simulate_rebalance`
- `assess_trade_risk`

Every response includes `deploymentId`, indexed block, block timestamp, observed chain head and observation time. Calls fail closed when the subgraph is more than 20 blocks or two minutes behind.

The package is implemented and locally tested. A production Graph endpoint/deployment ID has not yet
been published; until both are configured, it must not be presented as a live Graph integration.

The MCP has no signing, quote, relay, policy mutation or arbitrary calldata tool. Trades must go through the separate AgentKit + EIP-712 gateway flow.

```bash
GRAPH_URL=... GRAPH_DEPLOYMENT_ID=... RH_RPC_MAINNET=... USDG_ADDRESS=... pnpm dev
# POST http://localhost:8790/mcp
```

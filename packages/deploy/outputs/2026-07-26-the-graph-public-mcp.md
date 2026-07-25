# The Graph public MCP proof

Date: 2026-07-26 (Europe/Lisbon)

## Public endpoints

| Item | Verified value |
|---|---|
| Service page | `https://nuvem-vault-intelligence-mcp.vercel.app/` |
| Process health | `https://nuvem-vault-intelligence-mcp.vercel.app/healthz` |
| Graph readiness | `https://nuvem-vault-intelligence-mcp.vercel.app/readyz` |
| Streamable HTTP MCP | `https://nuvem-vault-intelligence-mcp.vercel.app/mcp` |
| Vercel deployment | `dpl_9cT6WqtGdTso1pip92QrLWr7m398` |
| Graph deployment | `QmaPySahm79dFwjM7uujcHfqEErLTuujJxMRPxxGvZoymU` |
| Robinhood chain ID | `46630` |

The Vercel service is standalone and read-only. Its production environment contains only the
GraphQL URL, immutable deployment ID, public Robinhood RPC, chain ID and USDG address. It has no
signer, trading, World, database or gateway credentials.

## External verification

The production readiness check returned:

```json
{
  "ok": true,
  "indexedVaultsSampled": 1,
  "deploymentId": "QmaPySahm79dFwjM7uujcHfqEErLTuujJxMRPxxGvZoymU",
  "chainId": 46630,
  "blockNumber": "93488986",
  "blockHash": "0xf1f3ccca79d0bd5baec4f7e84259b2db47b185da64aa865ed92e312f9f644ab6",
  "chainHeadBlock": "93488995",
  "blockLag": "9",
  "indexingErrors": false,
  "ageSeconds": 3.048
}
```

The MCP smoke discovered and called all eight tools:

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

It verified the same deployment, chain `46630`, block `93488986`, chain head `93488998` and lag
`12`. The canary remained human-managed with invalid NAV, so the risk tool correctly returned
`approved: false` for `agent_manager`, `nav_valid`, `controller_active`, `world_backing` and
`policy`.

## Repository verification

- Root `pnpm build`: passed.
- Root `pnpm test`: `349` deterministic checks passed.
- Breakdown: contracts/invariants `136`, gateway `140`, website `39`, MCP `17`, SDK `10`,
  reference runtime `7`.
- Two credentialed integration tests remained intentionally skipped without their external E2E
  configuration.
- `vercel build --prod`: passed before the production deployment.
- The public page, health, readiness and complete MCP smoke all returned successfully after deploy.

## Honest hosting boundary

The stable Vercel MCP currently reads GraphQL through the temporary quick tunnel:

```text
https://represent-jail-and-results.trycloudflare.com/subgraphs/name/nuvem/robinhood-testnet
```

That tunnel depends on the local Docker stack and this PC. It has no uptime guarantee and is not a
durable production Graph endpoint. Robinhood testnet `46630` is not listed as a hosted network by
The Graph, so the correct path is a self-hosted Graph Node. The repository now includes a
Cloudflare named-tunnel Docker overlay; activating it still requires a Cloudflare tunnel
token/domain or an equivalent persistent container host.

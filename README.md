# RobinFund / NuvemFund

Non-custodial social funds for tokenized stocks on Robinhood Chain. Managers or AI agents can
rebalance through protocol-approved adapters while assets remain inside the Fund contract.
Manager-funded stake absorbs eligible losses first.

- Website: [nuvem.fund](https://www.nuvem.fund)
- Network: Robinhood Chain (`4663`)
- Hackathon: ETHGlobal Lisbon 2026
- Uniswap track: continuity / Uniswap Stack Contribution
- Pre-event baseline: [`0f216be`](https://github.com/Myttyyytytyyttt/RobinFund/commit/0f216be)

## Uniswap integration

The Uniswap Trading API is a load-bearing execution dependency, not a price widget:

1. The agent reads a fresh, provenance-bound vault context.
2. The gateway requests an exact-input `CLASSIC` route from the Uniswap Trading API.
3. The gateway binds the quote to the adapter, Fund recipient, tokens, amount, chain, proxy,
   Universal Router, slippage floor and deadline.
4. The agent signs an EIP-712 intent containing the execution hash.
5. A permissionless relayer simulates the complete controller call and broadcasts it.
6. The Fund and controller independently verify actual balance deltas, NAV risk and slippage.

### Exact implementation references

- API quote, local `minOut` floor and calldata binding:
  [`apps/agent-gateway/src/uniswap.ts#L110-L216`](https://github.com/Myttyyytytyyttt/RobinFund/blob/main/apps/agent-gateway/src/uniswap.ts#L110-L216)
- Full-call simulation before broadcast:
  [`apps/agent-gateway/src/worker.ts#L55-L73`](https://github.com/Myttyyytytyyttt/RobinFund/blob/main/apps/agent-gateway/src/worker.ts#L55-L73)
- Exact approval, proxy call, allowance revocation and residue checks:
  [`UniswapApiAdapter.sol#L55-L151`](https://github.com/Myttyyytytyyttt/RobinFund/blob/main/packages/contracts/src/adapters/UniswapApiAdapter.sol#L55-L151)
- EIP-712, policy, nonce, oracle and concentration enforcement:
  [`AgentVaultController.sol#L208-L314`](https://github.com/Myttyyytytyyttt/RobinFund/blob/main/packages/contracts/src/agents/AgentVaultController.sol#L208-L314)
- Fund custody and balance-delta enforcement:
  [`Fund.sol#L823-L864`](https://github.com/Myttyyytytyyttt/RobinFund/blob/main/packages/contracts/src/Fund.sol#L823-L864)
- Independent SDK verification before signing:
  [`packages/agent-sdk/src/client.ts#L98-L164`](https://github.com/Myttyyytytyyttt/RobinFund/blob/main/packages/agent-sdk/src/client.ts#L98-L164)
- Automatic refresh of near-expiry quotes:
  [`packages/agent-runtime/src/reference-agent.ts#L102-L137`](https://github.com/Myttyyytytyyttt/RobinFund/blob/main/packages/agent-runtime/src/reference-agent.ts#L102-L137)
- Live frontend status and confirmed execution data:
  [`website/src/lib/uniswapLive.ts`](https://github.com/Myttyyytytyyttt/RobinFund/blob/main/website/src/lib/uniswapLive.ts)

The frontend never receives the Uniswap API key. Its live card reads the current chain block,
verifies the configured adapter/proxy/router bytecode and displays only sanitized confirmed
executions from the public audit table.

## The Graph integration

The Graph is the load-bearing data plane for autonomous agents, not a duplicate frontend indexer:

1. A Robinhood-aware Graph Node indexes the Fund, registry, controller, policy, World backing,
   holdings and trade lifecycle.
2. The read-only Vault Intelligence MCP exposes that state to any compatible agent.
3. Every response is pinned to an immutable deployment ID and carries chain/block provenance.
4. The gateway rejects deployment drift, RPC-chain mismatch, indexing errors, stale cursors,
   invalid NAV/holdings and inactive controller/World state.
5. The reference agent independently cross-checks gateway context against MCP before requesting a
   Uniswap quote.

Robinhood testnet `46630` currently runs through the checked-in self-hosted Graph Node stack. The
Graph data path can operate read-only with `TRADING_ENABLED=false`; trade execution cannot be
enabled when `GRAPH_ENABLED=false`.

Implementation and local runbook:

- [Subgraph and Graph Node](packages/subgraph/README.md)
- [Vault Intelligence MCP](packages/vault-intelligence-mcp/README.md)
- [Gateway integration](apps/agent-gateway/README.md)
- [Live testnet evidence](packages/deploy/outputs/2026-07-25-the-graph-robinhood-live.md)

## Verified behavior

The repository includes:

- Gateway tests for malicious route, recipient, proxy, router, amount and deadline substitution.
- Solidity tests for signature replay, policy drift, slippage, concentration and residual funds.
- A Robinhood Chain fork probe that executes fresh API-generated `CLASSIC` calldata.
- Reference-agent tests proving a quote is refreshed before signing when close to expiry.
- [Recorded live API fork proof](packages/deploy/outputs/2026-07-25-uniswap-api-fork-proof.md).

Run the deterministic suite:

```bash
pnpm install
pnpm test
pnpm build
```

Run the live API + Robinhood fork proof with private environment variables:

```bash
pnpm test:uniswap:fork
```

The fork probe does not broadcast a public transaction.

## Repository map

```text
packages/contracts          Solidity protocol, adapters and agent controller
apps/agent-gateway          AgentKit sessions, Uniswap API binding and relayer
packages/agent-sdk          BYOA SDK with independent local verification
packages/agent-runtime      Reference AI manager with automatic requoting
packages/indexer            Ponder indexer
packages/subgraph           The Graph read model
packages/vault-intelligence-mcp  Sanitized vault intelligence tools
website                     React/Vite application and public audit UI
supabase                    Durable control-plane schema and public read model
```

## Deployment status

The website and testnet fund flow are public. The Uniswap API execution path is verified in unit
tests and on a Robinhood mainnet-state fork. A funded public `4663` canary transaction is intentionally
not claimed until its transaction hash is linked here and visible in the live frontend card.

## Documentation

- [Uniswap API feedback](FEEDBACK.md)
- [Agent gateway runbook](apps/agent-gateway/README.md)
- [The Graph runbook](packages/subgraph/README.md)
- [Deployment status](packages/deploy/STATUS.md)
- [Protocol specification](docs/SPEC.md)
- [Security review history](docs/REVIEW.md)

## License

MIT — see [LICENSE](LICENSE).

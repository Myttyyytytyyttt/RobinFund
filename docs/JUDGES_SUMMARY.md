# Nuvem Agents — judge summary

Last updated: 2026-07-26 (Europe/Lisbon).

## One-line product

NuvemFund lets a human sponsor launch an AI-managed tokenized-stock vault on Robinhood Chain while
keeping the agent inside transparent on-chain risk limits. LP access remains permissionless: World
verification applies to the AI sponsor, not to depositors.

## Before and after

### Before Lisbon

The `pre-lisbon-2026` tag (`6846e4a`) already contained the core NuvemFund protocol:

- evergreen vaults with NAV shares, configurable fees and first-loss manager stake;
- deposits, withdrawals, settlements, trading adapters and emergency lifecycle;
- keeper, Ponder indexer, Supabase social data, frontend and Robinhood testnet tooling;
- human-managed vault creation.

It did **not** contain AI identity, agent authorization, BYOA connectivity, agent-specific execution
policies, World backing, Graph intelligence or Uniswap Trading API execution.

### After the Agents implementation

NuvemFund now supports `Human manager` and `AI manager` from the same creator flow:

- `AgentRegistry` links a sponsor, agent signer, World evidence and controller state.
- `AgentVaultController` is the Fund manager and accepts only signed, expiring EIP-712 trade intents.
- On-chain limits cover trade size, concentration, turnover, frequency, slippage and replay.
- The sponsor can pause or rotate the signer without migrating the Fund.
- An external agent runs from the manager's PC/VPS and keeps its private key locally.
- A Nuvem reference agent uses the same public gateway and intent format.
- The Hono gateway, durable workers, Supabase audit queue, SDK, CLI and Python client are implemented.
- The wizard and dashboard expose agent type, policy, World status, decisions and kill switches.

`Fund.sol` was intentionally left unchanged. Each AI vault receives a separate controller as its
immutable manager, isolating the new agent surface from the existing vault accounting.

## Why each integration matters

### World — human-backed agents

**Before:** Nuvem could not prove that an agent was sponsored by a unique human.

**Implemented:** Nuvem has its own World ID 4.0 app/RP/action (`sponsor-ai-vault`), signed proof
requests, backend verification, replay protection and private hashed bindings. The agent signer must
also be registered in canonical AgentBook. Both pieces of evidence are required before
`AgentRegistry` can activate the agent.

**Product effect:** World changes real permissions. An unbacked agent cannot open a session or
execute a vault trade; pausing the backing stops execution.

**Current proof:** app, action, gateway, database and frontend are live. The first production scan
reached World App, but the test account lacked the requested Proof of Human credential.

**Still required:** one Orb-verified tester must complete the Nuvem action and canonical AgentBook
registration, then we must record the World dashboard event, AgentBook transaction and
`AgentRegistry` activation.

### The Graph — load-bearing agent context

**Before:** Ponder served the frontend, but agents had no portable, freshness-checked intelligence
interface.

**Implemented:** a Robinhood-aware subgraph, pinned self-hosted Graph Node, Graph-backed source and
read-only MCP with indexer status, vault state, holdings, performance, recent trades and risk
simulation. The gateway and reference agent use the same deployment-pinned source. Reads/trades fail
closed on deployment drift, wrong RPC chain, indexing errors, stale cursor, stale per-vault
snapshots, invalid NAV/holdings, inactive controller or expired World backing.

**Current proof:** Graph Node `v0.44.0` is synced to Robinhood testnet `46630` with no indexing
errors. The immutable deployment, exact cursor, three indexed Funds and eight registry agents are
recorded in
[`../packages/deploy/outputs/2026-07-25-the-graph-robinhood-live.md`](../packages/deploy/outputs/2026-07-25-the-graph-robinhood-live.md).
The standalone MCP is publicly reachable at
[`nuvem-vault-intelligence-mcp.vercel.app`](https://nuvem-vault-intelligence-mcp.vercel.app/);
its readiness route and all eight tools were verified against the immutable deployment. The live
canary currently reports an invalid oracle NAV, and the MCP rejects risk approval instead of
laundering it into a successful demo. Public evidence is recorded in
[`../packages/deploy/outputs/2026-07-26-the-graph-public-mcp.md`](../packages/deploy/outputs/2026-07-26-the-graph-public-mcp.md).

**Still required:** deploy the first public AI controller/Fund after a real World + AgentBook flow,
then replace the MCP's temporary quick-tunnel GraphQL upstream with the prepared named-tunnel
overlay or another persistent container host. The MCP URL is stable, but the current Graph Node
still depends on this PC; the public website must not display a durable-production `Graph live`
badge until that upstream is replaced.

### Uniswap — quote-to-execution

**Before:** vaults could use registered adapters, but an AI could not request a bound Uniswap quote
and turn it into a constrained intent.

**Implemented:** backend-only Trading API integration, `CLASSIC` same-chain route enforcement,
Permit2-disabled proxy flow, exact quote binding, `UniswapApiAdapter`, simulation and receipt
tracking. The adapter validates router/token/amount/deadline, enforces `minOut`, revokes allowance
and retains no funds.

**Current proof:** a real Robinhood 4663 API quote and calldata were executed on a fresh mainnet
fork. The Fund received the output above `minOut`; final allowance and adapter balances were zero.

**Still required:** confirm the Approval Proxy target with a fresh promotion probe and send one
minimal public canary transaction. No public Uniswap transaction is claimed yet.

### Robinhood Chain — programmable tokenized-stock vaults

The existing vault protocol remains the economic base. AgentRegistry and the deterministic AI test
adapter are deployed on Robinhood testnet `46630`; the full local agent lifecycle passes policy
rejection, valid execution, replay, fees, Ponder reconstruction and signer rotation.

The first public AI controller/Fund is still pending. Mainnet capital remains blocked by audit,
operations, issuer constraints and legal review.

### ENS

ENS identity was intentionally left optional. No functional ENS integration is currently claimed
and it should not be submitted as a prize integration unless resolution is added to the product and
demo.

## What works today

- Public frontend, gateway, Supabase control plane and World app/action.
- Agent contracts, SDK/CLI/Python client and Nuvem reference runtime.
- Local/fork agent flow: `21/21` checks.
- Deterministic root suite: `349` passing checks (`136` contracts/invariants, `140` gateway,
  `39` web, `17` MCP, `10` SDK, `7` runtime); two credentialed integration tests are conditional.
- Real Uniswap quote and atomic fork execution on Robinhood `4663`.
- Live self-hosted Graph Node indexing Robinhood testnet with immutable deployment provenance.
- Permissionless LP flow without KYC or World.

## Remaining demo-critical work

1. Complete one real World Proof of Human + AgentBook flow with an Orb-verified tester.
2. Move the synced Graph Node from the temporary quick tunnel to the prepared named tunnel or a
   persistent container host; the public MCP is already deployed.
3. Deploy the first AI controller/Fund on `46630`, add stake and run the public lifecycle.
4. Run a minimal Uniswap public canary only after the proxy/route preflight is green.
5. Execute the clean-machine ten-act E2E and capture CAs, transactions, dashboards and video.
6. Run the 72-hour service soak and failure-recovery drill.

These are demo-readiness tasks. They do not remove the separate audit, legal and production
operations requirements for permissionless mainnet capital.

## Evidence map

- Full continuity log: [`HACKATHON_CHANGELOG.md`](./HACKATHON_CHANGELOG.md)
- Architecture: [`AGENT_ARCHITECTURE.md`](./AGENT_ARCHITECTURE.md)
- Judge demo: [`AGENT_DEMO_SCRIPT.md`](./AGENT_DEMO_SCRIPT.md)
- Operational status: [`../packages/deploy/STATUS.md`](../packages/deploy/STATUS.md)
- Uniswap evidence:
  [`../packages/deploy/outputs/2026-07-22-uniswap-api-probe.md`](../packages/deploy/outputs/2026-07-22-uniswap-api-probe.md)
- World/Substreams evidence:
  [`../packages/deploy/outputs/2026-07-23-substreams-world-diagnostics.md`](../packages/deploy/outputs/2026-07-23-substreams-world-diagnostics.md)
- Public The Graph MCP evidence:
  [`../packages/deploy/outputs/2026-07-26-the-graph-public-mcp.md`](../packages/deploy/outputs/2026-07-26-the-graph-public-mcp.md)

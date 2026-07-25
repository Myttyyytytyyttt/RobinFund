# Nuvem Agents — judge summary

Last updated: 2026-07-23 (Europe/Lisbon).

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

**Implemented:** vault/agent Graph schema, Graph-backed source abstraction and a read-only MCP with
vault state, holdings, performance, recent trades and risk simulation. New trades fail closed when
the configured Graph source is stale or unavailable.

**Network discovery:** Robinhood Chain currently exposes Firehose/Substreams rather than normal
Subgraph Studio deployment. Authentication and the Robinhood endpoint were proven by processing
mainnet block `16,863,868`.

**Still required:** build the Nuvem-specific Substreams package, persist it with a cursor/reorg-safe
SQL sink, expose the query endpoint and connect that live endpoint to the gateway/MCP. Until then,
the public product must not display a `Graph live` badge.

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
- Contract matrix: `148` tests; gateway `55`; SDK `9`; runtime `4`; MCP `5`.
- Real Uniswap quote and atomic fork execution on Robinhood `4663`.
- Real authenticated Robinhood Substreams block delivery.
- Permissionless LP flow without KYC or World.

## Remaining demo-critical work

1. Complete one real World Proof of Human + AgentBook flow with an Orb-verified tester.
2. Ship the Robinhood Substreams package, SQL sink and live MCP query path.
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

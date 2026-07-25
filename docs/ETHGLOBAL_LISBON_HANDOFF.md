# ETHGlobal Lisbon 2026 — Nuvem Agents handoff

Use this document as the initial context for a new development terminal/agent.

## Mission

Build a hackathon MVP called **Nuvem Agents**:

> Human-backed AI agents managing transparent tokenized-stock vaults.

Nuvem allows a user to deposit into a vault managed either by a human trader or an AI agent. For the Lisbon demo, focus on one AI-managed vault. The agent must use live onchain data, operate under explicit risk limits, and execute a real tokenized-stock trade. A unique human must stand behind the public agent and have capital/reputation at risk.

This is an extension of the existing Nuvem.Fund project. Do not rewrite or weaken the production-oriented fund contracts solely for the hackathon. Prefer isolated adapters and a simplified demo vault where necessary.

## Core user flow

1. A human sponsor verifies that they are a unique person through World.
2. The sponsor registers an AI agent and creates its vault.
3. The agent receives a discoverable ENS identity such as `atlas.nuvem.eth`.
4. A user deposits USDC into the vault and receives demo vault shares.
5. The agent queries live vault, holdings, policy and execution data through The Graph.
6. The agent produces a structured trade intent with a short explanation.
7. An onchain/offchain policy engine checks asset allowlist, trade size, concentration and slippage.
8. The vault executes a supported tokenized-stock swap through the Uniswap API.
9. The UI shows the holdings, NAV/PnL, agent identity, human-backed status, input data, decision and transaction result.

## The four target sponsors

### 1. Uniswap Foundation — Best Uniswap API Integration

Official page: https://ethglobal.com/events/lisbon2026/prizes/uniswap-foundation

Use the Uniswap API as a load-bearing execution component:

- Request a quote for USDC to a tokenized stock supported by the API.
- Display expected output, route, price impact/slippage and network.
- Convert the agent decision into an executable trade.
- Enforce Nuvem risk limits before execution.
- Execute and display the resulting transaction and updated vault position.

Do not assume the Uniswap API supports Robinhood Chain. Confirm supported networks and tokenized-stock contracts with the sponsor. Deploy the hackathon adapter on a supported network if needed.

Required submission details:

- Valid Uniswap Developer Platform API key.
- Public GitHub repository.
- `FEEDBACK.md` describing the integration experience.
- Submit the Uniswap Developer Feedback Form and link `FEEDBACK.md`.
- README must point reviewers to the exact integration files and relevant lines.

### 2. The Graph — Best AI Use Case + Best AI Tooling

Official page: https://ethglobal.com/events/lisbon2026/prizes/the-graph

Build a reusable package called **Nuvem Vault Intelligence MCP**. It must use live Graph data and also power the Nuvem agent in the demo.

Implemented tools:

```text
get_indexer_status()
list_vaults()
get_vault_state(vault)
get_vault_performance(vault)
get_holdings(vault)
get_recent_trades(vault)
simulate_rebalance(vault, proposedTrade)
assess_trade_risk(vault, proposedTrade)
```

The agent must reason over the data rather than merely display query results. Example:

> Trade rejected: estimated price impact is 1.4%, above the vault's 0.75% policy limit.

To qualify for both Graph tracks:

- Keep the MCP/tooling as an independent, documented and reusable package.
- Use The Graph as a load-bearing source of live blockchain data.
- Use the same tooling inside the Nuvem end-user application.
- No purely mocked/static datasets.
- Public repository with a clear README or `SKILL.md`.
- Explain which Subgraphs/endpoints/products are used.
- Produce a 2–4 minute demo video.

Do not target the standardized/composable-data track unless the core demo is complete.

### 3. World — AgentKit New Use Cases

Official page: https://ethglobal.com/events/lisbon2026/prizes/world

Use World AgentKit to make human backing a meaningful authorization rule:

- An unverified agent may analyze data privately but cannot open a public investable vault.
- A World-verified unique human can sponsor an agent.
- Sponsorship unlocks vault creation and execution rights.
- Store the agent-to-sponsor proof/status without exposing personal identity.
- Show the full flow from verification to changed authorization.

The human sponsor concept should connect to Nuvem's skin-in-the-game model: the sponsor is the accountable party behind the agent and can provide the vault's first-loss stake. A hackathon demo may simplify the financial insurance calculation, but it must show that human backing changes real execution permissions or economic limits.

Avoid generic reputation, generic login or API discounts; those are explicitly weak/non-qualifying examples. The key use case is authorization to manage third-party capital.

Optional only after the main flow works: use Identity Check as a per-vault module for age/jurisdiction eligibility in RWA vaults. It must minimize collected attributes and include developer/user testing notes.

### 4. ENS — Best ENS Integration for AI Agents

Official page: https://ethglobal.com/events/lisbon2026/prizes/ens

Give each public agent a persistent, discoverable ENS identity:

```text
atlas.nuvem.eth
quant-01.nuvem.eth
```

Useful records/metadata:

- Agent execution address.
- Vault contract address.
- Strategy type.
- Risk-policy hash or URI.
- Agent/model version.
- World human-backed status/proof reference.
- Performance/data endpoint.

ENS must improve identity and discovery, not be a cosmetic label. The demo should resolve the ENS name into the agent/vault profile without hard-coded values. Review ENSIP-25 and ENSIP-26 for agent identity and text records.

If accepted into the Continuity Track, also assess eligibility for the ENS Continuity Integration prize.

## Architecture

```text
World unique-human verification
              |
              v
Human sponsor -> Agent Registry <- ENS agent identity
                      |
User USDC -> Demo Vault / Shares
                      |
             Nuvem Vault MCP
                      |
          Live data from The Graph
                      |
              AI trade decision
                      |
               Risk policy engine
                      |
                Uniswap API
                      |
              Tokenized-stock swap
                      |
              NAV/PnL demo dashboard
```

## Structured trade intent

Use a deterministic schema between the agent and executor. The AI must never receive unrestricted wallet access.

```ts
type TradeIntent = {
  vault: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: string;
  maxSlippageBps: number;
  marketDataRefs: string[];
  rationale: string;
  expiresAt: number;
  nonce: string;
};
```

The policy engine validates the intent and only then passes it to the Uniswap execution adapter.

Minimum policies:

- Token allowlist.
- Maximum trade size as a percentage of vault NAV.
- Maximum resulting asset concentration.
- Maximum slippage/price impact.
- Deadline and nonce replay protection.
- Agent execution role bound to the registered vault.

## Suggested repository layout

Adapt this to the current monorepo rather than duplicating existing packages:

```text
apps/
  lisbon-demo/              # focused frontend/demo flow
packages/
  agent-runtime/            # decision loop + TradeIntent
  vault-intelligence-mcp/   # reusable Graph-backed MCP
  uniswap-adapter/          # quote + execution integration
  world-agent-gate/         # human-backed authorization
  ens-agent-registry/       # agent naming/metadata resolution
  contracts/                # isolated demo contracts or existing adapters
docs/
  HACKATHON_CHANGELOG.md
  ARCHITECTURE.md
  DEMO_SCRIPT.md
  FEEDBACK.md
```

## Scope priorities

### P0 — must work

- Create/register one AI agent.
- World human-backed authorization changes real permissions.
- Deposit USDC into one demo vault.
- Read live data through The Graph.
- Generate a structured trade intent.
- Reject an intent that violates policy.
- Execute one compliant tokenized-stock trade through Uniswap API.
- Display the updated vault state and transaction.

### P1 — strongly recommended

- ENS agent identity and metadata resolution.
- Reusable Vault Intelligence MCP package.
- Human trader and AI agent shown behind one common manager interface.
- Clear explanation of the sponsor's first-loss responsibility.

### P2 — only after the demo is reliable

- Optional World Identity Check module for RWA eligibility.
- Community preview or token-gated research feed.
- Additional agents/strategies.

Do not add 0G, Sui, Hedera, 1inch, chat, mobile apps, full production settlement, complete first-loss accounting or multi-chain orchestration during the hackathon unless P0 and P1 are finished and stable.

## Hackathon/Continuity hygiene

Because Nuvem already exists before the event:

1. Create a public baseline commit/tag before hacking begins, e.g. `pre-lisbon-2026`.
2. Add `HACKATHON_CHANGELOG.md` listing only work produced during the event.
3. Keep regular, meaningful Git commits; do not submit a single final commit.
4. Clearly separate existing Nuvem code from Lisbon additions in the README.
5. Record all deployed addresses and networks.
6. Provide setup instructions that a judge can actually run.
7. Prepare a concise architecture diagram.
8. Record one polished 2–3 minute demo that satisfies the shortest sponsor limit.

## Demo script

1. Open the Nuvem agent directory and select `atlas.nuvem.eth`.
2. Resolve its ENS metadata: strategy, vault, model and risk policy.
3. Show that the agent cannot create/operate a public vault before human backing.
4. Complete World verification and sponsor the agent.
5. Deposit demo USDC into the new vault.
6. Ask the agent for a tokenized-stock allocation.
7. Show live Graph data used in the decision.
8. First demonstrate a rejected trade exceeding the risk limit.
9. Generate a compliant intent.
10. Obtain a Uniswap quote and execute it.
11. Show the transaction, updated holdings, NAV/PnL and audit trail.

## Success definition

The project is successful when a judge can see, end to end, that:

- The agent has a real onchain identity.
- A unique human stands behind it and changes its authorization.
- Its decision uses live verifiable data.
- It cannot bypass the vault's risk policy.
- It executes a real tokenized-stock transaction.
- A user can transparently inspect what happened and why.

## One-line pitch

> Nuvem lets users invest in tokenized-stock vaults managed by human traders or AI agents, with every public agent backed by a verified human, grounded in live onchain data and restricted by transparent risk rules.

## Judge hook

> AI agents will manage money. Nuvem makes them investable, accountable and safe enough to back.


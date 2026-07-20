# NuvemFund — Step-by-step build roadmap

> Complements [SPEC.md](SPEC.md) (mechanism v0.3) and [REVIEW.md](REVIEW.md) (adversarial review).
> Real execution order: each phase depends on the previous one except where noted. Durations estimated for 1–2 full-time people.

---

## Phase 0 — Foundations and verifications (≈ 1 week, in parallel with Phase 1)

- **0.1 Monorepo**: pnpm workspaces + structure `packages/contracts` (Foundry), `packages/sdk` (TS/viem), `packages/keeper`, `apps/web` (Next.js), `apps/indexer` (Ponder), `docs/`. CI with GitHub Actions (forge test + lint + typecheck).
- **0.2 Local toolchain**: Foundry (forge/cast/anvil), Node 22 + pnpm, Slither/Aderyn for static analysis.
- **0.3 Chain access**: RPC testnet `rpc.testnet.chain.robinhood.com` (chain 46630) and mainnet 4663 via Alchemy/QuickNode; testnet ETH for gas; locate the testnet Stock Tokens (docs.robinhood.com/chain/contracts) and their feeds; Blockscout explorer.
- **0.4 Pending spec verifications (§15)** — ✅ **COMPLETED 2026-07-19** (fork tests 6/6 PASS, see SPEC.md changelog v0.8):
  - 0.4.1 ✅ USDG = 6 dec confirmed on-chain; USDG/USD feed **exists** (`0x61B7...9aD2`).
  - 0.4.2 ✅ `isBlocked(address)` verified live; real pointer = `ACCESS_CONTROLLED_REGISTRY()`; `oraclePaused()`/`tokenPaused()` live in the token.
  - 0.4.3 ✅ Real heartbeat = 86400s, deviation 0.5%, 24/5 (weekend staleness ~34h observed live) ⇒ `maxStaleness = 86400s + margin`.
  - 0.4.4 ✅ **NO** sequencer uptime feed exists on the chain — guard replaced by forward pricing (SPEC §5.2.3).
  - 0.4.5 ✅ Done on mainnet fork (better than testnet): real TSLA custody by our own contract + real swap executed against **Uniswap v4** (liquidity lives in v4; the v3 pool is empty ⇒ the Phase 1 adapter operates the PoolManager directly — embryo already written in `test/fork/SmokeOracleSwap.t.sol`). 0x remains for testnet/mainnet (RFQ needs live makers).
  - ⚠ Extra finding: impostor tokens on the chain (fake NVDA/USDG) — addresses only from the `AddressBook`.
- **0.5 Accounts and services to set up**: GitHub org · Alchemy or QuickNode (RPC) · Privy (embedded wallets) · WalletConnect Cloud (project ID) · domain + Vercel · project X account · Telegram/Discord.

**Deliverable**: repo compiling, testnet wallet with test Stock Tokens moved by our own contract, calibrated feeds table.

---

## Phase 1 — Core contracts on testnet (≈ 3–4 weeks)

Internal order by dependencies:

- **1.1 `NAVLib` + `TokenRegistry`**: WAD valuation (§5.1), full validity (§5.2: blocked/pause/sequencer+grace/staleness/dust), listing with heartbeat calibration.
- **1.2 Custody peripherals**: `FundShare` (non-transferable ERC-20), `QueueEscrow` (separate), `StakeEscrow` (timelocks, Frozen suspension), `CompensationReserve` (pull claims per period).
- **1.3 `Fund` — the core** (60% of the work):
  - 1.3.1 Deposit/withdrawal queues: strict forward pricing, minimum latency, pre-settlement blackout, pagination, minimums and caps (§5.3).
  - 1.3.2 Canonical batch sequence: settlement → FIFO deposits (running fee, partial fill at cap, skip+refund by attestation) → FIFO withdrawals with netting (§5.4).
  - 1.3.3 Cash withdrawal settlement: fixed price, real proceeds to the one leaving, sharePrice invariant (§5.6); in-kind withdrawal without NAV.
  - 1.3.4 First-loss: basis per LP with lazy roll-forward, aggregate `B`, settlement with `grossClaims`/λ/funding, claims (§6).
  - 1.3.5 Fees: entry fee on curve with running AUM, HWM adjusted for contributions, crystallization with §7.2 variables.
  - 1.3.6 States: Winding (ad-hoc settlement at the transition), Closed (fixed claims, stake release), Frozen (§10.3).
- **1.4 Trading**: `AdapterRegistry` + `UniswapV3Adapter` + `ZeroExAdapter` with delta measurement, per-trade guardrail, double slippage budget, pre-settlement freeze, beacon watch (§8).
- **1.5 Governance and compliance**: `EligibilityGate` (EIP-712, revocation, forced redemption), `FeeSplitter`, `Guardian` (pauses without withdrawals, depeg breaker), `FundFactory` (clones, immutable params).
- **1.6 Serious testing**:
  - 1.6.1 Unit tests per contract.
  - 1.6.2 **One test for each of the 21 attacks in §14** — the mechanism regression suite.
  - 1.6.3 Invariant/fuzz testing (Foundry): sharePrice of those remaining never drops due to exits, Σ claims ≤ funding, WAD units, USDG conservation.
  - 1.6.4 Fork tests against real testnet: real Stock Tokens, real feeds, real Uniswap.
- **1.7 Deploy to testnet 46630 + manual E2E**: create fund → deposit → trade → settlement with loss (verify claims) → settlement with gain (verify perf fee) → winding → close.

**Deliverable**: complete protocol working on testnet with a green test suite.

---

## Phase 2 — Indexer, keeper and services (≈ 2 weeks, starts with 1.7)

- **2.1 Indexer** (Ponder over 46630/4663): events from all contracts → historical sharePrice, track records per manager, slashes, degraded settlements, forced redemptions. GraphQL/REST API for the frontend.
- **2.2 Keeper bots** (TS + viem, the protocol's own — everything is permissionless anyway):
  - 2.2.1 Batch and settlement executor (with off-chain computation of `grossClaims` from events + publication).
  - 2.2.2 Withdrawal liquidator (Uniswap/0x routing with guards).
  - 2.2.3 Monitors: beacon implementations, `isBlocked` per fund, `UIMultiplierUpdated`, feed pauses → alerts + auto-suspensions.
  - 2.2.4 Expired compliance forced redemptions.
- **2.3 Compliance signer service**: geo verification + user attestation → EIP-712 signature with TTL; RHJ jurisdictions list; revocation. (Evaluate an external zk-KYC-type provider as an upgrade.)

**Deliverable**: testnet operating on its own end-to-end without manual intervention.

---

## Phase 3 — Frontend and social layer (≈ 3–4 weeks, starts in parallel with Phase 2)

- **3.1 Base**: Next.js + wagmi/viem + Privy (email/social/X login, no seed phrase) + installable PWA + WalletConnect (reaches Robinhood Wallet via its dapp browser by direct URL).
- **3.2 LP flows**: explore funds (filters by stake/AUM coverage, track record, slashes), deposit with visible effective fee and forward pricing explanation ("your order executes in the next valid window ~Monday 13:30 UTC"), cash/in-kind withdrawal, first-loss claims.
- **3.3 Manager side**: fund creation (wizard with params + stake), trading terminal (Uniswap/0x quotes, visible slippage budget), stake and cap management.
- **3.4 Social layer**: per-fund token-gated chat (SIWE + `minAccessShares`), manager feed, real-time positions for LPs / public 24h delay, leaderboards, X-linked profiles.
- **3.5 Compliance UX**: geo-block, attestation flow, per-fund issuer risk disclosures (§10.3).

**Deliverable**: complete product usable on testnet — the demo that gets shown.

---

## Phase 4 — Audit, legal and mainnet (≈ 4–8 weeks, much of it external waiting)

- **4.1 Pre-audit**: scope freeze, clean Slither/Aderyn, invariants documentation, reproducible deploy scripts.
- **4.2 External audit** (budget $30–80k depending on firm; alternative/complement: competition on Code4rena/Sherlock/Cantina). Apply fixes + re-review.
- **4.3 Legal opinion** (in parallel with 4.2): entity structure (where to incorporate), sub-threshold AIFMD / MiFID II analysis of the vehicle and the copy-trading, the fee dial, T&Cs and disclosures. Budget $10–30k.
- **4.4 Grants and ecosystem** (in parallel, from now): write to chain-developers-group@robinhood.com, apply to the Arbitrum Open House 2026 ($1M committed) and Buildathons/Founder Houses, request listing on robinhood.com/chain/ecosystem.
- **4.5 Mainnet**: deploy to 4663 with real multisig + timelock, bug bounty (Immunefi), conservative launch caps (low global `aumCap` for the first weeks), 24/7 monitoring.

**Deliverable**: audited protocol live on mainnet with a defined legal structure.

---

## Phase 5 — Launch and growth (ongoing)

- **5.1 Founding cohort of managers**: 5–10 traders with an audience on X, white-glove onboarding, subsidized stakes if needed.
- **5.2 Incentives**: points system for deposits/retention/manager PnL (without an explicit token promise), campaigns with the chain community.
- **5.3 Technical v2**: trust-minimization of `grossClaims` (challenge window or proof), collateral on Morpho, baskets/indices, transferable shares with gating, decentralized keeper.
- **5.4 Product v2**: evaluate keys with fee-share (if legal allows), secondary markets, agents (the chain's agentic trading MCP).

---

## What we need — cross-cutting checklist

| Category | Item | By when |
|---|---|---|
| Infra | Dedicated RPC (Alchemy/QuickNode), 2 keys (testnet/mainnet) | Phase 0 |
| Infra | Hosting: Vercel (web) + VPS/Railway (keeper, indexer, signer) | Phase 2 |
| Services | Privy, WalletConnect Cloud, domain, geo-IP service | Phases 0–3 |
| Funds | testnet ETH (free) · mainnet ETH for deploys (~$200–500) · USDG for seed funds and testing | Phases 0/4/5 |
| Funds | Audit $30–80k · legal $10–30k · bug bounty (escrow) | Phase 4 |
| Security | 2/3 minimum multisig (Guardian), hardware wallets, incident response plan | Phase 4 |
| Legal | Entity jurisdiction, T&Cs, AIFMD/MiFID II opinion | Phase 4 |
| Distribution | Active X account from now, Robinhood dev-relations contact, grant applications | from Phase 0 |
| People | Minimum viable: 1 Solidity dev + 1 full-stack dev (can be the same person with more calendar); occasional UI design | — |

**Critical path**: 1.3 (Fund) → 1.6 (tests) → 4.2 (audit) → 4.5 (mainnet). Everything else parallelizes around it. Honest total estimate to mainnet: **3–4.5 months** with full dedication, dominated by the audit and legal, not by the code.

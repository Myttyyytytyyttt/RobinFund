# World + AgentKit Integration

## Outcome

World is an authorization boundary for public AI-managed vaults, not a generic login badge.
A human sponsor must pass Nuvem's World policy before the agent can become active in
`AgentRegistry`. Normal LP deposits remain permissionless and never require World.

## Identity Check policy

The frontend uses `@worldcoin/idkit-core` `4.2.2` and requests the World ID 4.0
`identityCheck` preset with:

- `document_type = passport`;
- `minimum_age = 18`;
- `allow_legacy_proofs = false`;
- `require_user_presence = false`.

The policy is identified as `ai-vault-eligibility-v1`. The gateway, not the browser, fixes the
app, RP, action, environment, policy, sponsor, agent and signer. Nuvem uses:

- app `app_5fe197d24d83c55573c5d9d0356f3d6e`;
- RP `rp_db7d77ff9edef255`;
- action `sponsor-ai-vault`.

The RP signing key remains backend-only. IDKit receives the signed `rp_context`, opens the World
connector URI used by the local QR, polls for completion and accepts only a World ID 4.0 result
with `identity_attested: true` in the expected environment.

## End-to-end authorization flow

1. The sponsor opens a SIWE session.
2. Nuvem provisions an isolated signer or accepts a BYOA public signer address.
3. The sponsor registers the agent and signer in `AgentRegistry`.
4. `POST /v1/agents/:id/world-id/request` returns a signed, short-lived Identity Check request.
5. IDKit displays the QR/deep link. World App or the staging Simulator completes the check.
6. `POST /v1/agents/:id/world-id/verify` verifies the proof and atomically binds the anonymous
   World subject to the sponsor and agent.
7. Production additionally registers the signer in canonical AgentBook on World Chain.
8. The gateway signs an environment-labelled EIP-712 backing bound to chain, registry, sponsor,
   signer, agent, nonce and expiry.
9. `AgentRegistry.activate` changes the agent from `PendingBacking` to `Active`.
10. The durable worker deploys the controller and Fund. The sponsor authorizes the controller,
    binds the Fund and locks first-loss stake.
11. AgentKit sessions are short-lived and every trade still requires a policy-bound EIP-712
    `TradeIntent`.

## Production and staging are intentionally different

| Robinhood network | World environment | Test surface | AgentBook | Backing label |
|---|---|---|---|---|
| Testnet `46630` | `staging` | `https://simulator.orb.engineer/` | Skipped | `world-staging-identity`, `canonical: false` |
| Mainnet `4663` | `production` | Production World App | Required on canonical World Chain | `world-agentbook`, `canonical: true` |

The frontend and gateway derive this mapping from the Robinhood chain ID and reject a mismatched
configuration. Staging proves that the Identity Check integration and authorization transition
work, but it is not presented as canonical AgentBook or production Proof of Human evidence.

## Privacy and replay protection

- Raw proofs, RP nonces and document values are processed transiently and are not stored.
- Postgres stores hashes for request/proof state and keyed HMACs for the World subject/nullifier.
- Requests are short-lived and single-use.
- Cross-wallet subject reuse, proof replay and environment/policy substitution fail closed.
- Only non-secret recovery coordinates are stored in `sessionStorage`; an approved proof remains
  in memory.
- Refreshing and pressing **Resume pending AI vault** continues the same agent and deployment job.

## Verified staging evidence — 2026-07-26

A real staging run produced:

- agent ID `0x6b67cb06968ddbaed08ec9fe3cca72d2456391938a7943c15304440f0229079c`;
- gateway request `201` at `00:19:42 UTC`;
- gateway verification `200` at `00:20:09 UTC`;
- active agent in `AgentRegistry`
  [`0xA27E31af49cEA5113Fe84F69C2B91B999b48491B`](https://explorer.testnet.chain.robinhood.com/address/0xA27E31af49cEA5113Fe84F69C2B91B999b48491B);
- authorized controller
  [`0x821800c893ab97a5C01368E2373e6fE5ba9fd423`](https://explorer.testnet.chain.robinhood.com/address/0x821800c893ab97a5C01368E2373e6fE5ba9fd423);
- deployed Fund
  [`0x74D799D16C44155E0dDed0bDDC984a980325c859`](https://explorer.testnet.chain.robinhood.com/address/0x74D799D16C44155E0dDed0bDDC984a980325c859).

The later transaction
[`0xd13cca7039f790424d391c5d4b26450befb234adcff8657513edd23e9d86106a`](https://explorer.testnet.chain.robinhood.com/tx/0xd13cca7039f790424d391c5d4b26450befb234adcff8657513edd23e9d86106a)
failed in `StakeEscrow.addStake(2_000e6)`. Its trace is
`tUSDG.transferFrom -> InsufficientBalance()`: the sponsor had `0 tUSDG`, while the `2,000 tUSDG`
allowance had succeeded. This happened after World verification, activation, deployment and
controller authorization; it was not a QR, Identity Check or AgentKit failure.

On Robinhood testnet, retrying the saved launch now claims the public tUSDG faucet when needed,
reuses an existing allowance and stakes into the already deployed vault. It does not create another
agent, World request, controller or Fund.

## Current boundary

The staging Identity Check path is live and demonstrated. Canonical production completion still
requires an eligible production World account, canonical AgentBook registration and captured
production evidence. Identity Check remains a preview feature and should not yet be described as a
regulatory or adversarial KYC control.

## References

- [World Identity Check preview](https://docs.world.org/world-id/idkit/credentials#identity-check-preview)
- [World AgentKit integration](https://docs.world.org/agents/agent-kit/integrate)
- [World AgentKit SDK reference](https://docs.world.org/agents/agent-kit/sdk-reference)
- [Working staging Simulator](https://simulator.orb.engineer/)

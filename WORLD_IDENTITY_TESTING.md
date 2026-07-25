# Nuvem — World Identity Check and AgentKit testing

## Prize fit

Nuvem targets **AgentKit New Use Cases** and **Identity Check Beta Test**. A
human sponsors an autonomous DeFi agent, proves the eligibility policy once,
registers that agent in AgentBook, and then grants it limited onchain execution
rights. World backing is therefore an authorization boundary, not a generic
login or cosmetic badge.

## Why these attributes are necessary

The AI vault can manage pooled assets under a constrained controller policy.
Nuvem requires the sponsor to:

- hold a document-backed **passport** credential; and
- be at least **18 years old**.

This is the smallest policy used for the demo's adult financial-product
eligibility decision. Nuvem does not request name, document number, nationality,
issuing country, date of birth, or document images. `require_user_presence` is
disabled because this track demonstrates Identity Check, not Selfie Check.

## Data minimization and abuse prevention

- The backend publishes the canonical policy and fixes the action, environment,
  app, RP, sponsor, agent, and signer. The official UI refuses any policy
  substitution.
- A server-computed signal binds those values before World App approval; the
  short-lived RP nonce/request is single-use.
- World Portal verifies the World ID 4.0 proof and Nuvem requires
  `identity_attested: true`; legacy proofs are rejected.
- Raw proofs, RP nonces, and user document values are processed in memory and
  are never persisted. The requested policy attributes are persisted as public
  policy metadata.
- Postgres stores SHA-256 fingerprints for the nonce, signal, and proof, plus
  keyed HMACs for the subject and nullifier.
- One World subject cannot silently back another sponsor wallet. A sponsor may
  operate several agents, but managed Nuvem agents are capped by the
  server-configured quota.
- The Identity binding and AgentBook binding are both included in the onchain
  World-backing hash.

## End-to-end flow

1. The sponsor registers an isolated agent signer onchain.
2. The gateway issues a signed, short-lived Identity Check request.
3. IDKit opens World App for passport + minimum-age-18 attestation.
4. The gateway validates the response and verifies it with World Portal.
5. An atomic database transaction binds the World subject to the sponsor and
   agent, enforcing ownership and quota before consuming the request.
6. AgentBook proves that the human backs that exact agent signer.
7. The sponsor submits the resulting backing hash to `AgentRegistry`.
8. A durable worker deploys the vault contracts; the browser resumes the exact
   job after refresh and completes binding/staking without creating duplicates.
9. The agent opens short-lived AgentKit sessions. Every bearer request rechecks
   its signer, sponsor, active state, and backing expiry against
   `AgentRegistry`.

## Environments

Production uses `app_*` credentials and the production World App. Simulator
testing must use `https://simulator.orb.engineer/` together with a coherent
`app_staging_*` app, matching RP signer key, and `staging` on both frontend and
gateway. Staging identity proofs are rejected when the deployment is configured
for Robinhood Chain mainnet (`4663`).

## Developer feedback

| Area | Observation | Mitigation in Nuvem |
| --- | --- | --- |
| AgentKit freshness | `validateAgentkitMessage.maxAge` is milliseconds, while challenge expiry is configured in seconds; using `300` made valid headers fail after 300 ms. | Convert seconds to milliseconds and test a delayed header. |
| RP configuration | A mismatched RP ID/signing key reaches a generic World error page and is difficult to diagnose. | Validate all World settings at startup and keep app/environment checks server-side. |
| IDKit naming | The installed preview types expose `legacy_signal` for the Identity Check preset while the conceptual docs call this binding a signal. | Isolate IDKit construction in one adapter and test the exact request shape. |
| Preview policy binding | The public result exposes `identity_attested`, but not a signed application policy hash. | Pin and persist the server-issued policy for the official flow, never trust browser-supplied policy metadata, and disclose the remaining modified-client limitation below. |
| Simulator discovery | Two similarly named simulators caused repeated false debugging paths. | Document and display only `simulator.orb.engineer` for this preview. |
| Recovery | World App approval, wallet approval, and asynchronous deployment cross several failure boundaries. | Persist only non-secret workflow coordinates in `sessionStorage`; keep the proof only in memory and make every subsequent step idempotent. |

## Community feedback observed in the supplied hackathon Discord

This is contextual developer feedback, not claimed as Nuvem usability testing:

- builders confused the old Worldcoin simulator with the working Orb simulator;
- participants asked whether TestFlight was required, although the World team
  said the production app could test the weekend features;
- “Secure document” was identified as the simulator option relevant to Identity
  Check;
- several builders hit generic IDKit error screens caused by Vite builds or an
  RP ID that did not match the signing key;
- users reported repeated attempts in face/selfie flows.

These reports motivated explicit environment labels, actionable error states,
and an idempotent “Finish launch” path.

### Preview security limitation

In the current preview, the RP signature covers the nonce, timestamps, and
action, while the Portal response exposes `identity_attested` but does not echo
a signed hash of the requested attribute policy. Nuvem includes its policy hash
in the signal, pins the policy in its official UI, and records the matching
server request, but a modified client could keep that signal while constructing
a different attribute preset. World should confirm or add cryptographic policy
binding before this gate is treated as a regulatory or adversarial production
control. The hackathon demo must therefore be tested with the official IDKit
flow and simulator/World App, and this limitation must be disclosed.

## Automated verification

Run:

```bash
pnpm --dir apps/agent-gateway test
pnpm --dir packages/agent-sdk test
python3 -m unittest packages/agent-sdk/python/test_nuvem_client.py
pnpm --dir packages/agent-runtime test
pnpm --dir website test
pnpm build
```

Coverage includes policy tampering, wrong environment/action/signal, malformed
and rejected Portal proofs, proof replay, cross-wallet subject reuse, managed
agent quota, atomic rollback, AgentKit delay/chain/revocation, session renewal,
malicious gateway context, recovery, and polling cancellation/timeouts.

## Required human test log before submission

Do not replace this section with invented results. Record at least two real
end-to-end sessions and attach screen/video evidence.

| Date/device | Environment | User understood passport + 18 consent? | Completed/abandoned step | Time | Friction or quote | Change made |
| --- | --- | --- | --- | --- | --- | --- |
| TODO | staging | TODO | TODO | TODO | TODO | TODO |
| TODO | production | TODO | TODO | TODO | TODO | TODO |

Ask each tester:

1. Before scanning, what did you think Nuvem would learn about you?
2. Was the passport + age-18 reason clear and acceptable?
3. At which step did you hesitate or retry?
4. Did “Identity Check”, “AgentBook”, and “World-backed agent” feel distinct?
5. Would you trust the resulting agent with a small, policy-limited vault?

## References

- [ETHGlobal Lisbon 2026 World prizes](https://ethglobal.com/events/lisbon2026/prizes)
- [World Identity Check preview](https://docs.world.org/world-id/idkit/credentials#identity-check-preview)
- [World AgentKit integration](https://docs.world.org/agents/agent-kit/integrate)
- [World AgentKit SDK reference](https://docs.world.org/agents/agent-kit/sdk-reference)
- [World Identity Check example](https://test-this-new-feature-world-just.vercel.app/)
- [Working World simulator](https://simulator.orb.engineer/)

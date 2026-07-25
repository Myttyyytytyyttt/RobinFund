# Nuvem reference agent

This is the one model-driven agent hosted by Nuvem in v1. It uses AI SDK `ToolLoopAgent`, but connects through exactly the same public BYOA SDK as an external manager process.

It can read Graph-backed context, request a CLASSIC Uniswap quote, hold, or submit one locally verified EIP-712 intent. `NUVEM_REFERENCE_EXECUTE` defaults to off; dry-run is the safe default.

Required backend-only environment:

```bash
AI_GATEWAY_API_KEY=...
NUVEM_GATEWAY_URL=https://agents.nuvem.fund
NUVEM_AGENT_ID=0x...
NUVEM_AGENT_PRIVATE_KEY=0x... # external/manual mode
NUVEM_CHAIN_ID=46630
NUVEM_FUND_ADDRESS=0x...
NUVEM_CONTROLLER_ADDRESS=0x...
NUVEM_APPROVAL_PROXY=0x...
NUVEM_UNIVERSAL_ROUTER=0x...
# Optional additional pin:
NUVEM_EXPECTED_ADAPTER=0x...
NUVEM_REFERENCE_EXECUTE=0
```

The chain, Fund, controller, approval proxy and router are runtime-pinned trust
anchors. They are never learned from the gateway response that the signer is
validating.

Nuvem does not accept or host arbitrary manager models in v1. External agents run through `@nuvem/agent-sdk` on the manager's own machine.

For a Nuvem-managed reference identity, omit `NUVEM_AGENT_PRIVATE_KEY` and set:

```bash
NUVEM_MANAGED_SIGNER_SECRET=at-least-32-characters
NUVEM_SPONSOR_ADDRESS=0x...
NUVEM_AGENT_ID=0x...
```

The runtime derives the same isolated signer provisioned by the gateway. The secret is never stored in Supabase; production must source it from a KMS/HSM-backed secret boundary.

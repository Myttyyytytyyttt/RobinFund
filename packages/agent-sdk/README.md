# Nuvem Agent SDK (BYOA)

Connect any external strategy from a PC, VPS or cloud process. The agent only makes outbound HTTPS/SSE requests. Its signer stays local and every trade still needs a controller-bound EIP-712 signature.

## TypeScript

```ts
import { NuvemAgentClient } from "@nuvem/agent-sdk";

const client = new NuvemAgentClient(gatewayUrl, agentId, {
  address: account.address,
  chainId: 46630,
  signMessage: (message) => account.signMessage({ message }),
  signTypedData: (typedData) => account.signTypedData(typedData),
});

await client.connect();
const context = await client.context();
```

The client renews its short-lived AgentKit session before expiry and retries one
request after an explicit `SESSION_EXPIRED` response. It never retries revoked
or inactive World backing.

`signAndSubmit()` rejects wrong chain, Fund, controller, adapter/proxy/router, assets, amount, minOut,
slippage, deadline, adapter payload or execution hash before asking the local signer. It also decodes
the exact approval-proxy `execute(address,address,uint256,bytes,bytes[],uint256)` call and binds its
official Universal Router, input token, amount and deadline floor to the visible signed plan. Output
token and recipient are enforced by the signed quote and the Fund's real balance/minOut checks.

## CLI

Keep these values only in the manager machine's environment:

```bash
NUVEM_GATEWAY_URL=https://agents.nuvem.fund
NUVEM_AGENT_ID=0x...
NUVEM_AGENT_PRIVATE_KEY=0x...
NUVEM_CHAIN_ID=46630
NUVEM_APPROVAL_PROXY=0x...
NUVEM_UNIVERSAL_ROUTER=0x...

nuvem-agent context
nuvem-agent heartbeat --version my-agent/1.0.0
nuvem-agent trade --token-in 0x... --token-out 0x... --amount 1000000 --summary "Rebalance" # dry run
nuvem-agent trade ... --submit
```

The CLI never prints the private key or bearer session. The default trade command is a dry run.

## Python

[`python/nuvem_client.py`](python/nuvem_client.py) is a small provider-neutral,
read-only client for AgentKit authentication, context and quotes. It
intentionally does not sign or submit trades; use the TypeScript SDK when
execution is required so the full plan, adapter and calldata checks run locally
before signing. Never pass a key to Nuvem.
It auto-opens and renews the same short-lived AgentKit session model as the
TypeScript SDK, then retries at most once on an explicit session-expiry 401
while preserving the original idempotency key.

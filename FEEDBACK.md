# Uniswap Trading API feedback — Nuvem Agents

## Context

NuvemFund uses a smart-contract Fund as the asset owner and a separate
`UniswapApiAdapter` as the swapper. The AI signs a controller-bound EIP-712 intent; a relayer submits
it, while the Fund must receive output atomically in the same transaction.

## What fits well

- `x-permit2-disabled: true` gives contract infrastructure a normal approve → swap path without
  requiring the adapter to produce a Permit2 signature.
- The deterministic approval proxy is easy to pin in the controller, SDK and backend.
- `swapper=adapter` plus `recipient=fund` maps cleanly to non-custodial vault accounting.
- Explicit Universal Router version headers make calldata targets stable across chains.
- CLASSIC routes preserve the atomic postconditions required by `Fund.execute`.

## Integration feedback

1. The general supported-chains page lists Robinhood Chain 4663 and Universal Router 2.1.1, while
   the proxy-approval deployment table currently omits Robinhood. On 2026-07-22 a live
   `x-permit2-disabled` request returned the deprecated proxy
   `0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9`, not the documented CREATE2 address. Both addresses
   had identical 1,005-byte runtime code and codehash on Robinhood, but integrators pin the API
   target before deployment; a single canonical per-chain matrix would remove this ambiguity.
2. Please publish the current proxy ABI/entrypoint next to the address. We verified on-chain selector
   `0x2894adf9` as `execute(address,address,uint256,bytes,bytes[],uint256)` and now fail closed on every
   visible spend field, but integrators should not need selector archaeology.
3. A contract-wallet example with `swapper != recipient` would help vault/treasury integrations.
4. A response field that explicitly states proxy workflow compatibility would be safer than inferring
   it from route type and null `permitData`.
5. Quote expiry and final swap deadline should be documented as one binding value so SDKs can verify
   it consistently.

## Nuvem safety behavior

- Requests only V2/V3/V4 AMM protocols and accepts only `CLASSIC`.
- Rejects UniswapX because proxy approval cannot execute it and settlement is asynchronous.
- Pins target, sender, chain, zero native value, selector, tokenIn/out, amount and deadline.
- Approves exactly amountIn, revokes after execution and requires allowance/residue zero.
- Measures the Fund's actual output delta and reverts below minOut.

This path is green in unit tests and a Robinhood-state fork with a deterministic local liquidity
stand-in. A live API quote and calldata generation are now verified (`CLASSIC`, `permitData=null`,
adapter/Fund bound); execution of that API-generated calldata on the fork and a public canary remain
pending and are intentionally not represented as live execution.

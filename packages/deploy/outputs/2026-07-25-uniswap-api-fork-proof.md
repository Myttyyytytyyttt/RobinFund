# Uniswap Trading API → Robinhood fork proof

Date: 2026-07-25
Command: `pnpm test:uniswap:fork`

This proof requested a fresh `CLASSIC` route from the live Uniswap Trading API and executed the
returned calldata on an ephemeral fork of Robinhood Chain `4663`. It did not broadcast a public
transaction.

## Result

```text
PASS routing=CLASSIC
PASS proxy=0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9
PASS universalRouter=0x8876789976dEcBfCbBbe364623C63652db8C0904
PASS adapter=0x7a2088a1bfc9d81c55368ae168c2c02570cb814f adapterId=2
PASS fund=0xa85233C63b9Ee964Add6F2cffe00Fd84eb32338f
PASS quotedOut=3205153169974836
PASS minOut=3181114521200024
PASS received=3205153169974836
PASS allowanceAfter=0
PASS adapterResidues=0/0
```

## What this establishes

- Uniswap returned an atomic `CLASSIC` route for Robinhood Chain.
- The approval-proxy target and Universal Router matched the pinned deployment.
- The API-generated calldata executed through `UniswapApiAdapter`.
- Actual output equalled the live quoted output and exceeded `minOut`.
- The adapter revoked its token allowance and retained no input or output balance.

The local fork transaction hash is intentionally omitted because it is not a public-chain proof.
The public canary is a separate release step and must be linked from the README once confirmed.

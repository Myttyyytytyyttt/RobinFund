# RobinFund

Fondos sociales no-custodiales sobre Stock Tokens en **Robinhood Chain** (chain ID 4663). Managers con stake first-loss real, LPs con entrada/salida a NAV, acceso social ligado a la posición.

## Documentos

- [docs/SPEC.md](docs/SPEC.md) — especificación de mecanismo v0.7 (cerrada tras 6 rondas de revisión adversarial)
- [docs/REVIEW.md](docs/REVIEW.md) — historial completo de la revisión adversarial
- [docs/ROADMAP.md](docs/ROADMAP.md) — roadmap de build por fases

## Estructura

```
packages/contracts   # Solidity (Foundry)
packages/sdk         # TS SDK (viem)        [Fase 1+]
packages/keeper      # bots                  [Fase 2]
apps/web             # Next.js               [Fase 3]
apps/indexer         # Ponder                [Fase 2]
```

## Setup

1. `cp .env.example .env` y rellena tus keys (el `.env` está gitignored — **nunca** commitees secretos).
2. Contratos: `cd packages/contracts && forge build && forge test`.
3. Tests de fork (estado real de la chain): `forge test --match-path "test/fork/*" --rpc-url robinhood` (usa `RH_RPC_MAINNET` del entorno).

## Red

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 | 46630 |
| Explorer | robinhoodchain.blockscout.com | explorer.testnet.chain.robinhood.com |
| Gas | ETH | ETH |

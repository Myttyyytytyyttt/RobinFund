# NuvemFund Deploy

Centro operativo y bitácora de despliegues de NuvemFund. Este paquete documenta cada paso desde
el devnet local hasta Robinhood Chain testnet y, más adelante, mainnet.

## Regla de trabajo

Ningún entorno se considera listo solo porque los contratos compilen. Cada promoción exige:

1. código identificado por commit;
2. direcciones y bloque inicial registrados;
3. bytecode y chain ID verificados;
4. keeper, indexer y frontend conectados al mismo deployment;
5. pruebas de usuario y de recuperación completadas;
6. output reproducible guardado en Markdown dentro de `outputs/`.

Los secretos nunca se escriben aquí. Las claves privadas, RPC autenticados y credenciales viven
únicamente en el `.env` raíz o en el secret store del proveedor.

## Documentos

| Documento | Propósito |
|---|---|
| [STATUS.md](./STATUS.md) | Estado actual, decisiones y bloqueadores |
| [RUNBOOK.md](./RUNBOOK.md) | Procedimiento reproducible por entorno |
| [TESTNET-ASSET-PACK.md](./TESTNET-ASSET-PACK.md) | Diseño de los activos equivalentes para chain 46630 |
| [AGENT-RUNBOOK.md](./AGENT-RUNBOOK.md) | Promoción, operación e incidentes de Nuvem Agents/BYOA |
| [outputs/2026-07-21-baseline.md](./outputs/2026-07-21-baseline.md) | Evidencia inicial antes del reinicio |
| [outputs/2026-07-21-devnet-restart.md](./outputs/2026-07-21-devnet-restart.md) | Output del reinicio permissionless |
| [outputs/2026-07-21-testnet-asset-pack.md](./outputs/2026-07-21-testnet-asset-pack.md) | Build, tests, E2E 46630 local y preflight público |
| [outputs/2026-07-21-testnet-public.md](./outputs/2026-07-21-testnet-public.md) | CAs, coste, smoke, servicios y browser flow de la testnet pública |
| [outputs/2026-07-21-testbots-public.md](./outputs/2026-07-21-testbots-public.md) | Tres bots, trades, fees, retiros y cierre público reconciliado |
| [outputs/2026-07-21-dynamic-entry-public.md](./outputs/2026-07-21-dynamic-entry-public.md) | Curva 0%-5%, tres tasas FIFO y transfers reconciliados |
| [outputs/2026-07-22-nuvem-agents-local.md](./outputs/2026-07-22-nuvem-agents-local.md) | CAs, txs y E2E local/fork de Agents |
| [outputs/2026-07-22-world-managed-onboarding.md](./outputs/2026-07-22-world-managed-onboarding.md) | Signer gestionado + AgentBook |
| [outputs/2026-07-22-world-id-v4-nuvem-app.md](./outputs/2026-07-22-world-id-v4-nuvem-app.md) | App/RP/action propia, gateway y Supabase World ID 4.0 |
| [outputs/2026-07-22-nuvem-agents-testnet.md](./outputs/2026-07-22-nuvem-agents-testnet.md) | Gateway/frontend públicos, World Portal, AgentRegistry y adapter AI en 46630 |

## Comandos del paquete

```bash
pnpm typecheck       # valida las herramientas de deploy
pnpm check:testnet   # RPC, chain ID, address pública y saldo; nunca imprime la private key
pnpm test:local      # stack completo sobre Anvil vacío con chain ID 46630
pnpm deploy:testnet  # broadcast público; exige saldo y ALLOW_TESTNET_BROADCAST=1
pnpm smoke:testnet   # stake, LP, keeper, buy/sell, safety checks y Ponder sobre 46630 pública
pnpm services:testnet # keeper + Ponder persistente + frontend público-testnet
pnpm test:testbots   # 3 wallets, fees, 4 trades, retiros completos y cierre en 46630 pública
pnpm test:dynamic-entry # curva 0%-5%, 3 depósitos FIFO y verificación exacta en 46630
pnpm deploy:agent-adapter:testnet # adapter AI determinista para lifecycle 46630; no es Uniswap
pnpm --dir ../devnet test:agent-e2e # 10 actos BYOA sobre la devnet levantada
```

Deployment público vigente: FundRegistry
`0x696553ad390428abf3d95c90a3452917cbaa453c`, tUSDG
`0x336c508083e2afe17c594a8ef5b8542efcf672d5` y Fund canario
`0xc0FC8Edb22Dd98d1bdA19E92E34282c56c75616e`. La tabla completa está en el output público.

`test:testbots` crea o reanuda de forma idempotente `TestBots (TBOT)`. Las wallets laterales se
derivan solo en memoria, nunca se imprimen ni persisten. El broadcast exige
`ALLOW_TESTNET_BROADCAST=1`; el resultado vigente está en el output TestBots enlazado arriba.

## Entornos

| Entorno | Chain ID | Activos | Objetivo |
|---|---:|---|---|
| Devnet | 31337, estado forkeado de 4663 | Contratos reales de mainnet + feeds controlables | Mecánica y escenarios extremos |
| Testnet | 46630 | TestnetAssetPack sin valor real | Operación pública, wallets, persistencia y soak |
| Mainnet | 4663 | USDG y Stock Tokens canónicos | Solo después de auditoría, legal y runbook de producción |

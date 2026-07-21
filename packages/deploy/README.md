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
| [outputs/2026-07-21-baseline.md](./outputs/2026-07-21-baseline.md) | Evidencia inicial antes del reinicio |

## Entornos

| Entorno | Chain ID | Activos | Objetivo |
|---|---:|---|---|
| Devnet | 4663, fork local | Contratos reales de mainnet + feeds controlables | Mecánica y escenarios extremos |
| Testnet | 46630 | TestnetAssetPack sin valor real | Operación pública, wallets, persistencia y soak |
| Mainnet | 4663 | USDG y Stock Tokens canónicos | Solo después de auditoría, legal y runbook de producción |


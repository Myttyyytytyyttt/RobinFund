# TestnetAssetPack

## Motivo

Robinhood Chain testnet (46630) está viva, pero las direcciones canónicas de mainnet no contienen
USDG, Stock Tokens, feeds ni el registry de RHJ. El protocolo necesita esas interfaces para poder
desplegarse y recorrer su ciclo completo.

## Componentes implementados

| Componente | Semántica mínima |
|---|---|
| `TestnetUSDG` | ERC-20, 6 decimales, mint de faucet |
| `TestnetStockToken` | ERC-20, 18 decimales, `uiMultiplier`, pausas y blacklist |
| `TestnetStockImplementationMarker` | Commit de implementación sin lógica económica |
| `TestnetAccessRegistry` | `isBlocked(address)`, pausa global y `implementation()` para beacon drift |
| `TestnetPriceFeed` | AggregatorV3, 8 decimales, rondas y timestamps controlables |
| `TestnetLiquidityVenue` | Reservas separadas; solo paga al adapter fijado e inmutable |
| `TestnetTradeAdapter` | Swap bidireccional determinista con precio/feed, sin custodiar residuos |

## Guardas

- Los contratos de faucet y administración no forman parte del deployment mainnet.
- Los scripts abortan si `block.chainid == 4663`.
- Las direcciones se pasan al deploy por variables de entorno; `AddressBook.sol` continúa siendo
  exclusivamente mainnet.
- El output debe diferenciar claramente `TEST ASSET — NO VALUE`.

## Scripts

- `DeployTestnetAssets.s.sol`: despliega implementación, registry, tUSDG, cinco stocks, seis feeds,
  venue y adapter; configura 250 M tUSDG y 2 M unidades de cada stock como liquidez sin valor.
- `DeployTestnetProtocol.s.sol`: despliega registries, `OpenEligibilityGate`, Guardian y
  FundRegistry; registra los cinco activos y el adapter con direcciones inyectadas por entorno.
- `CreateFund.s.sol`: se reutiliza sin bifurcar la lógica de creación de fondos.

Los dos scripts exclusivos de testnet solo admiten chain ID 31337 o 46630. Además, cada contrato
del asset pack rechaza individualmente chain ID 4663 como defensa en profundidad.

## Criterio de aceptación

El pack quedó aceptado el 2026-07-21: el E2E sobre una chain local vacía con ID 46630 demostró:

1. mintear USDG de prueba;
2. crear un fondo permissionless;
3. depositar y ejecutar el batch;
4. comprar y vender un stock de prueba;
5. liquidar ganancia y pérdida;
6. pagar first-loss;
7. retirar cash e in-kind;
8. simular pausa, bloqueo y beacon drift;
9. cerrar el fondo;
10. reconstruir todo desde el indexer.

Resultado: 10/10 cumplidos. Ponder reconstruyó dos trades, retiro cash, retiros in-kind con tres
`InKindSlice`, la posición final del LP a cero y el fondo en estado `Closed`.

## Deployment público aceptado

El 2026-07-21 el mismo pack se desplegó en Robinhood Chain testnet 46630 y pasó un smoke sin time
warp: stake de 10,000 tUSDG, depósito LP de 8,000 tUSDG, keeper, buy/sell de tTSLA, blacklist,
pausa global, beacon drift y backfill Ponder. Direcciones, costes, bloques y transacciones están en
[`outputs/2026-07-21-testnet-public.md`](./outputs/2026-07-21-testnet-public.md).

Son activos de prueba sin valor. Sus CAs no se pueden reutilizar en mainnet 4663.

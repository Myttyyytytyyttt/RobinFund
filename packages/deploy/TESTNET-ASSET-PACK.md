# TestnetAssetPack

## Motivo

Robinhood Chain testnet (46630) está viva, pero las direcciones canónicas de mainnet no contienen
USDG, Stock Tokens, feeds ni el registry de RHJ. El protocolo necesita esas interfaces para poder
desplegarse y recorrer su ciclo completo.

## Componentes previstos

| Componente | Semántica mínima |
|---|---|
| `TestnetUSDG` | ERC-20, 6 decimales, mint de faucet |
| `TestnetStockToken` | ERC-20, 18 decimales, `uiMultiplier`, pausas y blacklist |
| `TestnetStockBeacon` | `implementation()` actualizable para ensayar beacon drift |
| `TestnetAccessRegistry` | `isBlocked(address)` y bloqueo global |
| `TestnetPriceFeed` | AggregatorV3, 8 decimales, rondas y timestamps controlables |
| `TestnetTradeAdapter` | Swap determinista con precio/feed y reservas de test |

## Guardas

- Los contratos de faucet y administración no forman parte del deployment mainnet.
- Los scripts abortan si `block.chainid == 4663`.
- Las direcciones se pasan al deploy por variables de entorno; `AddressBook.sol` continúa siendo
  exclusivamente mainnet.
- El output debe diferenciar claramente `TEST ASSET — NO VALUE`.

## Criterio de aceptación

El pack queda aceptado cuando un E2E sobre chain 46630 puede:

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


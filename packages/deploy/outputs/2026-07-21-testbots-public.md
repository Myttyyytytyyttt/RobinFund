# Output · TestBots en Robinhood Chain testnet

Fecha: 2026-07-21 (Europe/Lisbon)  
Red: Robinhood Chain testnet · chain ID `46630`  
Activos: asset pack de testnet sin valor económico  
Estado final: **E2E completado y vault cerrado**

## Resultado

Se creó `TestBots (TBOT)`, se financiaron tres wallets laterales con el mínimo ETH necesario, cada
bot depositó `2,000 tUSDG`, el manager ejecutó cuatro trades y realizó un beneficio controlado de
`300 tUSDG`. Después se cristalizó la performance fee, los tres bots retiraron todo en cash, el
FeeSplitter distribuyó las fees y el vault terminó en `Closed`.

- `3/3` depósitos ejecutados;
- `4/4` trades ejecutados;
- entry fee y performance fee reconciliadas;
- `3/3` retiros cash ejecutados;
- shares de bots y total supply: `0`;
- Ponder: fondo `Closed`, cuatro trades y tres posiciones con shares `0`;
- balance final de tTSLA y tNVDA en el Fund: `0`.

## Contract addresses

| Componente | CA |
|---|---|
| Fund TestBots | `0xA7588F9662DACEA303D763C6b8295F33B6fbc46d` |
| Share TBOT | `0x7Dd73318786C08f21De8c9Bba29cb247b09939b4` |
| Queue | `0xc39cFB95dBDEA2A62EA208EB750aDCd14B8ce158` |
| StakeEscrow | `0x2A4833ddc905990b288fBC5435818761f92ee0d6` |
| CompensationReserve | `0x4249E352FE2c31f4Dc2d8a8Acf288cEC2ac3c9BF` |
| FeeSplitter | `0x6eb567304f674C74909c462F091D347392bbB8f0` |
| Manager / keeper | `0xC632137E0C6657dcfA4b3709Ebf7C2a59fB62C71` |
| Protocol treasury | `0xE7C83e0F5c1CD380C133c2690c8d8849567fAf51` |

Explorer: `https://explorer.testnet.chain.robinhood.com/address/<CA>`.

## Configuración probada

| Setting | Valor |
|---|---:|
| Stake manager | `5,000 tUSDG` |
| Depósito por bot | `2,000 tUSDG` |
| Entry fee fija | `2%` |
| Parte manager de la entry fee | `50%` de la fee |
| Performance fee | `20%` |
| Split de performance fee | `90% manager / 10% protocolo` |
| kFactor | `25` |
| Periodo | `7 días` |
| Cooldown normal de retiro | `1 hora` |

Para terminar la prueba en la misma sesión se usó el flujo real de `Winding`: primero se liquidaron
todos los stocks a tUSDG, luego `requestWinding()` hizo exigible un settlement ad hoc y el estado
`Winding` permitió retirar sin saltarse el contrato ni modificar el tiempo de la red pública.

## Wallets bot y retiros

Las claves se derivaron únicamente en memoria desde la wallet de testnet. No se imprimieron ni se
guardaron. Cada bot recibió `0.00005 ETH` para gas y `100,000 tUSDG` del faucet del asset pack.

| Bot | Address | Deposit | Withdrawal | PnL | ETH final | Shares finales |
|---|---|---:|---:|---:|---:|---:|
| 1 | `0xfEe2c42FdB0403F83a82373a93b903C9034bE940` | `2,000` | `2,061.641849` | `+61.641849` | `0.00004522672` | `0` |
| 2 | `0x18A05b8e502640ec182E8137ea8CbFf77FB02Bf7` | `2,000` | `2,049.096361` | `+49.096361` | `0.00004591048` | `0` |
| 3 | `0x867fC1b4eBdc7220375d12B83880421C8d0CE0af` | `2,000` | `2,042.861789` | `+42.861789` | `0.00004591048` | `0` |

Los tres retiros suman `6,153.6 tUSDG`, es decir, `153.6 tUSDG` de beneficio neto conjunto para
los LPs. La diferencia entre bots del mismo tamaño corresponde al orden de ejecución y a la parte de
la entry fee que permanece en el fondo y beneficia a las shares ya acuñadas.

## Trades

1. Buy tNVDA por `500 tUSDG`.
2. Sell de toda la tNVDA al mismo precio.
3. Buy tTSLA por `3,000 tUSDG` a `$300`.
4. El feed administrable de testnet se llevó a `$330` y se vendió toda la tTSLA: beneficio realizado
   `300 tUSDG`.
5. El feed tTSLA quedó restaurado a `$300`.

Esto solo usa contratos sin valor del TestnetAssetPack; no simula ni afirma liquidez real de Stock
Tokens de Robinhood.

## Fees reconciliadas

### Entry fee

Sobre `6,000 tUSDG` depositados:

| Destino | Importe |
|---|---:|
| Entry fee total, 2% | `120 tUSDG` |
| Manager, 50% de la fee | `60 tUSDG` |
| Protocolo, 20% de la fee | `24 tUSDG` |
| Retenido en el Fund | `36 tUSDG` |

### Performance fee

- `PerfFeeCrystallized.feeWad`: `62.399999799999985079 USD`;
- shares acuñadas al FeeSplitter: `59.323591847117169432 TBOT`;
- cash redimido y distribuido: `62.399999 tUSDG`;
- manager: `56.159999 tUSDG`;
- protocol treasury: `6.24 tUSDG`.

Fee total del manager: `116.159999 tUSDG` (`60 + 56.159999`).  
Fee total del protocolo: `30.24 tUSDG` (`24 + 6.24`).

Reconciliación del beneficio controlado:

```text
153.600000  LPs
116.159999  manager
 30.240000  protocolo
  0.000001  dust en el Fund
-----------
300.000000  beneficio realizado
```

La tx de `distribute()` emitió dos `Transfer` de tUSDG y `Distributed(56.159999, 6.24)` en el mismo
recibo exitoso. Se usa esta evidencia canónica en vez de dos lecturas RPC adyacentes, que pueden
llegar de réplicas con distinto retraso.

## Transacciones de evidencia

| Acción | Tx hash |
|---|---|
| Deploy Fund | `0x8be351f7986549d0c085e8d39be155d366c1127b1571740a405df3bd1957bf46` |
| Register Fund | `0xf411a80429ad6ea9ed4ace53ae374748345e7da4f532a2eb26cb09d07b90a5a7` |
| Batch de los tres depósitos | `0x6139df2db1db1cfa1ee5b6169dfd38d3770223c2a4386fa98a96dc2fb1aa6a83` |
| Trade 1 | `0xfb4f1c1286463be80896a1938bb4ac3574b2fbe9b0f66cc1e480818a249cafa7` |
| Trade 2 | `0x7105c5723c0cb426bbd912825f516f2cd5ee7923e4e0691a6eff2a71e08e32b9` |
| Trade 3 | `0xf584d7ce1d4ae3c0acb3c622e6a05984bc1ea3f9dd14a30bdbaefeb091e7d47f` |
| Trade 4 | `0x98a64603338b3bddf43169ed7c460a05e9fd7232e6920ac6e2de5f1719b161f7` |
| Settlement + performance fee + Winding | `0x3fa654e7d42c237aa3f4d6bb40918aa706d891c0ccb7316270692831963e9f26` |
| Batch de retiros | `0x433870c8af2cc75eff5b8979747bb28d0df5299930853f329ee70fbd5017f132` |
| Distribución 90/10 | `0xdfe31ac2471c3571c8f8221867d012f0eedc77c3b873ee5d8548454186d17a64` |
| Close | `0xb13c434e68315464514c18ee23f76b19f8cd19ea3d4b5d050d46f15e1e5a9bd1` |

## Estado final on-chain e indexado

| Check | Resultado |
|---|---:|
| Fund.state | `3 · Closed` |
| Share.totalSupply | `0` |
| Shares de cada bot | `0` |
| Fund tTSLA / tNVDA | `0 / 0` |
| CompensationReserve tUSDG | `0` |
| FeeSplitter tUSDG | `0` |
| Fund tUSDG | `0.000001` de dust |
| StakeEscrow.stakeAvailable | `5,000 tUSDG` |
| Ponder trades | `4` |
| Ponder posiciones bot | `3`, todas con shares `0` |

El stake no se retiró; permanece en `StakeEscrow` y no forma parte de las fees anteriores.

## Coste observado

- balance de la wallet operadora antes de TestBots: `0.0145289065 ETH`;
- balance final: `0.01425805226 ETH`;
- delta total conservador: `0.00027085424 ETH`.

El delta incluye `0.00015 ETH` enviados a los bots, deploy, todas las operaciones, una tx fallida por
estimación de gas demasiado ajustada y los reintentos. No hace falta más ETH para mantener los
servicios actuales.

## Hardenings del runner surgidos de la prueba

- consultas `eth_getLogs` troceadas en ventanas de 10,000 bloques;
- keeper limitado al Fund objetivo para no mezclar contabilidad entre vaults;
- margen explícito sobre `eth_estimateGas` para Robinhood Chain;
- reanudación idempotente mediante eventos históricos de depósitos, trades y distribución;
- verificación de fees con eventos y recibos, no con lecturas potencialmente desfasadas;
- redacción del RPC privado en errores y ninguna private key en argumentos u outputs.

Runner reproducible: `packages/deploy/src/testbots-testnet.ts`.

## Verificación final

| Superficie | Resultado |
|---|---|
| Runner público TestBots | exit code `0` |
| Deploy tooling | TypeScript limpio |
| Keeper unit | `30/30` verdes; `4` E2E locales omitidos por flag |
| Indexer | TypeScript limpio |
| Ponder ready | HTTP `200` |
| Frontend testnet | HTTP `200` |
| GraphQL TestBots | state `3`, supply `0`, trades `4` |
| Secret scan | sin valores de `.env` en archivos tracked/untracked no ignorados |
| Diff whitespace | limpio |

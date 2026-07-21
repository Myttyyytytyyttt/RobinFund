# Output · Dynamic Entry Test

Fecha: 2026-07-21 (Europe/Lisbon)  
Red: Robinhood Chain testnet · chain ID `46630`  
Activos: TestnetAssetPack sin valor económico  
Estado final: **Active**

## Resultado

Se creó `Dynamic Entry Test (DYN)` con una entry fee lineal entre `0%` y `5%`. Tres wallets
depositaron `2,000 tUSDG` cada una en una única cola FIFO. El contrato recalculó el uso del cap para
cada orden y aplicó tres tasas crecientes distintas: `0.50%`, `1.49%` y `2.48%`.

La fórmula exacta, los eventos `EntryFeeCharged`, los `Transfer` de tUSDG y el balance final del Fund
coinciden. Ponder reconstruyó el vault como `Active`, con tres LPs y todas las shares acuñadas.

## Contract addresses

| Componente | CA |
|---|---|
| Fund | `0xec3a6902b3fDba7dEEF8139F16967dA6429CE282` |
| Share DYN | `0xf59bE14bD6c974e70aE19B17303BBBf52FF0F016` |
| Queue | `0xdbEE9781c5A6e17FD076fEBCfF73D7052C4F1251` |
| StakeEscrow | `0x3039A127C6bf6932D4Bc71Ad2d40FEb651b61A48` |
| Manager / keeper | `0xC632137E0C6657dcfA4b3709Ebf7C2a59fB62C71` |
| Protocol treasury | `0xE7C83e0F5c1CD380C133c2690c8d8849567fAf51` |

Explorer: `https://explorer.testnet.chain.robinhood.com/address/<CA>`.

## Configuración

| Setting | Valor |
|---|---:|
| Entry fee mínima | `0%` |
| Entry fee máxima | `5%` |
| Parte manager | `50%` de cada entry fee |
| Parte protocolo | `20%` de cada entry fee |
| Parte retenida en Fund | `30%` de cada entry fee |
| Stake manager | `1,000 tUSDG` |
| kFactor | `10` |
| AUM cap | `10,000 tUSDG` |
| Depósito por bot | `2,000 tUSDG` |

La configuración queda fijada en el constructor del Fund; actualmente no existe un setter para
cambiar la curva después del deployment.

## Curva observada

La tasa usa el punto medio del depósito:

```text
u = min(1, (NAV actual + depósito / 2) / AUM cap)
tasa = feeMin + (feeMax - feeMin) × u
fee = ceil(depósito × tasa)
```

| Orden FIFO | Tasa | Fee total | Manager | Protocolo | Retenido en Fund |
|---:|---:|---:|---:|---:|---:|
| 1 | `0.50%` | `10 tUSDG` | `5` | `2` | `3` |
| 2 | `1.49%` | `29.8 tUSDG` | `14.9` | `5.96` | `8.94` |
| 3 | `2.48%` | `49.6 tUSDG` | `24.8` | `9.92` | `14.88` |
| **Total** | — | **`89.4`** | **`44.7`** | **`17.88`** | **`26.82`** |

Los tres eventos y transferencias se produjeron en el mismo batch:
`0x98bae3db2efe5ce0b51518fd7e25819b19cc96e66cd0723038e9394137f9d4f9`.

## Shares e indexación

| LP | Deposit | Shares DYN |
|---|---:|---:|
| `0xfEe2c42FdB0403F83a82373a93b903C9034bE940` | `2,000` | `1,990` |
| `0x18A05b8e502640ec182E8137ea8CbFf77FB02Bf7` | `2,000` | `1,961.388535924039746812` |
| `0x867fC1b4eBdc7220375d12B83880421C8d0CE0af` | `2,000` | `1,934.425078304387815361` |

- total supply: `5,885.813614228427562173 DYN`;
- balance del Fund: `5,937.42 tUSDG`;
- AUM/cap después del batch: `59.3742%`;
- Ponder: state `0 · Active`, `lpCount=3`, tres posiciones con `2,000 tUSDG` depositados.

El orden importa deliberadamente: cuando una entry fee deja una parte dentro del Fund, las shares
que ya existen se benefician de ese importe. Por eso un depósito posterior recibe menos shares.

## Reconciliación

```text
6,000.00  depósitos
-  44.70  manager
-  17.88  protocolo
---------
5,937.42  balance del Fund
```

El balance líquido del manager pasó de `85,117.839999` a `84,162.539999 tUSDG`: `-1,000` de stake
en este Fund y `+44.7` de entry fees. El treasury pasó de `30.24` a `48.12 tUSDG`, exactamente
`+17.88`.

## Transacciones principales

| Acción | Tx hash |
|---|---|
| Deploy Fund | `0x5dc1422c3cde2b36e04f8e1aee9d34115cf14df8720ed13863d2f67ee59d7d22` |
| Register Fund | `0x7b3435a49d0d04b530e45f79027f8760bbaa500b216e89d96b417c473a2d8d53` |
| Batch de depósitos y fees | `0x98bae3db2efe5ce0b51518fd7e25819b19cc96e66cd0723038e9394137f9d4f9` |

## Coste y seguridad operacional

- balance ETH antes: `0.01425805226`;
- balance ETH después: `0.01416588478`;
- coste total: `0.00009216748 ETH`;
- no se enviaron nuevos top-ups ni se usaron nuevos faucets;
- las claves laterales se derivaron solo en memoria y no se imprimieron ni persistieron.

Runner reproducible: `packages/deploy/src/dynamic-entry-testnet.ts`.

## Frontend y verificación final

El frontend lee `feeMinBps`, `feeMaxBps`, NAV y AUM cap del Fund y usa la misma fórmula con redondeo
hacia abajo. Con el estado final de este vault, una próxima entrada de `2,000 tUSDG` se cotiza en
`346 bps · 3.46%`.

Verificación visual en `http://127.0.0.1:5174/?front=robinfund`: el vault aparece en Explore Funds
como Active con 3 inversores. Su modal muestra `3.46%` y `69.20 tUSDG` de fee estimada al introducir
`2,000 tUSDG`; la consola del navegador no registró errores.

| Superficie | Resultado |
|---|---|
| Runner público | exit code `0` |
| Fórmula vs eventos | 3/3 exactas |
| Transfers canónicos | manager y treasury exactos |
| Ponder | Active, 3 LPs, `6,000 tUSDG` lifetime deposits |
| Deploy tooling | TypeScript limpio |
| Indexer | TypeScript limpio |
| Frontend tests | `6/6` verdes; Supabase E2E omitido por flag |
| Frontend production build | verde; warnings conocidos de Privy y chunk size |
| Frontend visual | vault visible; quote `2,000 → 3.46% / 69.20 tUSDG`; 0 errores de consola |
| Frontend / Ponder ready | HTTP `200 / 200` |
| Secret scan | limpio |
| Diff whitespace | limpio |

# NuvemFund — Indexer

Indexer [Ponder](https://ponder.sh) del protocolo: transforma los eventos on-chain en la base de
datos que consulta el frontend (GraphQL + SQL sobre HTTP). Nada de esto toca la chain para servir
queries; el estado "live" fino (NAV al segundo, balances) se lee directo del contrato desde el
cliente.

## Qué indexa

| Fuente | Cómo | Tablas |
|---|---|---|
| `FundRegistry` | dirección fija | `fund` (metadatos leídos on-chain al registro) |
| `Fund` (todos) | **factory pattern** desde `FundRegistered` | `deposit`, `withdrawal`, `settlement` (serie de precios), `claim`, `trade`, `fundAsset`, `lpPosition`, `activity` |

Agregados corrientes en `fund` (exactos porque `FundShare` no es transferible — las shares solo se
mueven por mint/burn evented): `totalShares`, `lpCount` (holders con shares > 0), `lifetime*`,
`lastPeWad`/`lastSettledAt`, `state`/`frozen`/`guardianPaused`/`currentPeriod`.

`activity` es el feed unificado por fondo (quién/qué/cuánto/cuándo + `meta` JSON) — la capa social
del frontend pinta directamente de ahí.

## Correr

```bash
pnpm gen-abis     # regenerar ABIs desde packages/contracts/out (tras cambios de contrato)
pnpm codegen      # tipos de Ponder (ponder-env.d.ts)
pnpm dev          # dev server con hot reload — GraphiQL en http://localhost:42069
pnpm start        # producción (requiere --schema/DATABASE_SCHEMA)
pnpm test:e2e     # E2E completo: anvil fork + protocolo real + ciclo LP + asserts GraphQL
```

Env (el `.env` raíz se carga solo): `INDEXER_RPC_URL` (fallback `RH_RPC_MAINNET`), `FUND_REGISTRY`,
`INDEXER_START_BLOCK` (bloque del deploy — acota el backfill),
`INDEXER_CHAIN_ID` (default 4663), `DATABASE_URL` (Postgres; sin ella, PGlite embebida en
`PONDER_PGLITE_DIR`).

## Queries típicas del frontend

```graphql
# Explore: lista de fondos con stats — TVL = totalShares × lastPePostFeeWad / 1e18
# (lastPeWad es el precio a la marca PRE-dilución de la perf fee; para valorar usar el post-fee)
{ funds { items { address name symbol manager state totalShares lpCount lastPePostFeeWad lifetimeDeposited6 } } }

# Chart del fondo: serie de precios por período
{ settlements(where: { fund: "0x…" }, orderBy: "period") { items { period peWad fundingWad timestamp } } }

# Portfolio del LP
{ lpPositions(where: { lp: "0x…" }) { items { fund shares deposited6 withdrawn6 claimed6 } } }

# Feed de actividad de un fondo
{ activitys(where: { fund: "0x…" }, orderBy: "timestamp", orderDirection: "desc") { items { kind lp amount meta timestamp } } }
```

## El E2E

`pnpm test:e2e` levanta el mismo harness que el keeper (anvil forkeando mainnet, `Deploy.s.sol` +
`CreateFund.s.sol` reales, feed USDG mockeado — un fork no publica rondas), ejecuta el ciclo LP
completo, **mina 256 bloques para enterrar los eventos bajo la ventana de finality** (el backfill
histórico de Ponder solo cubre bloques finalizados), arranca `ponder start` contra el anvil y
verifica por GraphQL: fondo con metadatos/agregados, depósito ejecutado sin onboarding, retiro pagado,
settlement en la serie, posición del LP a cero tras salir y el orden del feed de actividad.

El indexer no almacena KYC, países ni attestations. La identidad social del website vive separada en
Supabase y se protege con SIWE/RLS; Ponder solo deriva estado financiero público de la chain.

## Revisión adversarial (aplicada)

El paquete pasó el workflow de revisión (3 lentes + escépticos): 20 hallazgos confirmados
(deduplicados en 8 raíces), todos aplicados. Los dos HIGH: (1) **el hueco deploy→register** — un
Fund es operable antes de registrarse, el factory pattern no indexa ese hueco, y un `db.update`
pelado sobre la orden inexistente tiraba el indexer entero (`RecordNotFoundError`); ahora los
handlers de ejecución son upserts que reconstruyen la fila. (2) **PendingWinding invisible** —
`requestWinding` no emite `StateChanged`; el handler de `WindingRequested` actualiza el estado.
Además: precio post-perf-fee para TVL (`lastPePostFeeWad`), retiros del FeeSplitter excluidos de
agregados de LP (kind `fee_redeem`), índices de BD en columnas calientes, `executedTxHash` +
`orderId` en `meta` para enlazar orden↔ejecución.

## Notas de implementación

- **`db.find` devuelve el objeto cacheado y `update` lo muta in place**: capturar cualquier valor
  del objeto ANTES de actualizar (bug real cazado por el E2E: `lpCount` no decrementaba).
- `PerfFeeCrystallized` se emite antes que `Settled` en la misma tx → `settlement` se upsertea
  desde ambos handlers y `Settled` ya conoce las shares de la fee para el precio post-dilución.
- El status `cancelled` de depósitos es inalcanzable (el contrato emite `DepositRefunded("cancelada")`).
- **Retiros in-kind**: cada asset entregado emite `InKindSlice(orderId, token, amount, valueWad)`
  (lo emite `NAVLib.distributeInKind` vía delegatecall, así que el log sale con la dirección del
  Fund — por eso `gen-abis` funde los eventos de NAVLib en `FundAbi`). Los slices llegan ANTES que
  su `WithdrawExecuted` (misma tx): el handler acumula `inKindValueWad` en la orden y deja el
  detalle en `in_kind_slice`; `WithdrawExecuted` cierra con `exit6 = paid6 + inKindValueWad/1e12`
  hacia `withdrawn6`/`lifetimeWithdrawn6`. `valueWad=0` = feed muerto (válvula de crisis §5.3),
  no "gratis". Un transfer que revierte (token bloqueado en Frozen) NO emite slice: el LP no lo
  recibió (residual reclamable en 1.3b del contrato).
- Cantidades: USDG en `*6`, precios/shares en WAD, como `bigint` crudo — formatea el frontend.

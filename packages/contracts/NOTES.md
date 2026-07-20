# Notas de implementación de contratos

Estado y decisiones que no viven en el código ni en la spec. Para retomar sin releer todo.

## Estado por fase (ver git log para commits)

| Fase | Qué | Tests | Estado |
|---|---|---|---|
| 0 | Monorepo, AddressBook, fork smoke | 6 fork | ✅ |
| 1.1 | `TokenRegistry` + `NAVLib` | 45 | ✅ revisado |
| 1.2 | `FundShare`, `QueueEscrow`, `StakeEscrow`, `CompensationReserve` | 63 | ✅ revisado |
| 1.3a | `Fund` núcleo (sin trading) | 93 (26 core+ataques, 4 inv, +escrows/nav) | ✅ revisado (3 lentes) |
| 1.3b | Flecos: true-up del collar in-kind, fill parcial del cap (C19), Frozen completo, cash-queue reorder | — | pendiente |
| 1.4a | Trading: AdapterRegistry + UniswapV4Adapter + fund.execute con guardarraíl + presupuesto | 103 | ✅ revisado (falta 0x RFQ, liquidación keeper-asistida) |
| 1.5 | `EligibilityGate` (EIP-712), `FeeSplitter`, `Guardian` (timelock), `FundFactory` | 117 | ✅ revisado (G1 HIGH cerrado) |

## Diferido explícitamente en Fund.sol 1.3a (buscar "1.3a" / "TODO" / "DIFERIDO" en el header)

1. **Trading** — el Fund valora activos si se le transfieren pero no opera. `registerAsset` ya existe (orden estricto). El adapter de 1.4 comprará/venderá vía el PoolManager v4 (embrión probado en `test/fork/SmokeOracleSwap.t.sol::V4SwapProbe`) y llamará a `registerAsset`.
2. **Liquidación keeper-asistida de retiros cash** — hoy un retiro cash solo ejecuta si el USDG del fondo lo cubre; si no, se para (el LP puede convertir a in-kind). En 1.4 el keeper liquidará slices pro-rata con el guardarraíl de slippage y el saliente absorbe el shortfall (§5.6.3).
3. **True-up al alza del collar in-kind** — `_executeInKind` usa `max(precioValido, lastValidSharePrice)` en el burn pero sin la corrección al alza posterior de §6 cuando aparece una ronda mejor. Bounded, documentado.
4. **Fill parcial del cap (C19)** — hoy un depósito que excede el cap espera al siguiente batch (total-o-nada); la spec pide fill parcial + refund del remanente.
5. **Frozen completo (§10.3)** — hoy `declareFrozen` cachea el flag y anula depósitos; falta la valoración con haircut de activos bloqueados, la quema parcial proporcional USDG-only, y saltar tokens que reviertan (el esqueleto try/catch está en `_executeInKind`).
6. **Residual de tokens intransferibles en in-kind** — el `ok` del try/catch se ignora; falta dejar el slice como claim in-kind (S10 #4).
7. **Frozen §10.3 incompleto** (S10) — falta: quema parcial USDG-only proporcional (mecánica 3), haircut temporal de activos bloqueados en NAVLib (mecánica 5), release de stake tras distribuir (mecánica 7). Implementado: void depósitos, trading off, first-loss suspendido, in-kind NAV-independiente (`executeInKindWithdrawals`), claim-independence.
8. **Head-of-line del retiro CASH** (S7) — un retiro cash incuBrible en la cabeza para la cola cash con `break`; mitigado porque `executeInKindWithdrawals` procesa in-kind por separado (la válvula nunca se bloquea). Reordenar cash/in-kind o colas separadas en 1.4 cuando exista liquidación.
9. **Pagination de `_touch` y `_voidAllDeposits`** (S13) — loops sin cota superior de períodos/órdenes; un LP dormido muchos períodos o una cola enorme podría acercarse al gas límite. Cota práctica alta; pagination en 1.4.
10. **HWM rounding sobre fee-fondo** (econ Q7) — `hwmWad += feeFondoWad*WAD/supply` redondea a la baja, así que la perf fee podría cristalizar sobre polvo de fee. Bounded a dust. Aceptado.

## Revisión 1.3a (3 lentes) — hallazgos aplicados

Highs: **S3** funding keeper-independiente (`min(stake,netted)`, λ=min(1,funding/gross)) — revirtió el cap v0.9.1 que reintroducía confianza en el keeper; **S1** div-por-cero perf fee con supply==0; **S2** guard de reentrancy + CEI; **S4** válvula in-kind NAV-independiente. Mediums: S5 (forceRedeem in-kind), S6 (in-kind descuenta navWad), S8 (registerAsset gated+cap). Bug extra hallado por los tests: fee-fondo no se añade al NAV pre-mint con supply==0 (rompía el precio seed). Lens económica confirmó S3 independientemente antes de colgarse. SPEC → v0.9.2.

## Invariantes que el Fund debe cumplir (verificados por fuzzing; mantener en cambios)

- `niAggregateWad == Σ NI_lp` (cuentas ≠ FEE_SPLITTER)
- `Σ claims de por vida del LP ≤ capital neto aportado`
- reserva: caja ≥ `totalFunded − totalPaid`
- `queue.balance() == queuedDeposits6`
- `funding = min(stake, neteado)` keeper-independiente (S3); `λ = min(1, funding/grossClaims)` — grossClaims solo baja λ, jamás la salida del stake

## Obligaciones del Fund que los escrows delegan (revisión 1.2, deben ser invariant tests)

- `slash` antes de `executeWithdraw` en el settlement (el clamp del escrow depende de ello)
- `executeWithdraw` solo en settlement, tras cap-check `k × stakeRestante ≥ AUM`
- no `slash` en Frozen (first-loss suspendido, §10.3)
- entrypoint de claims (`claim`/`_touch`) sin dependencias de estado/NAV/atestación/pausas (G15)
- `sweep` de la reserva solo en Closed con `totalShares == 0`

## Convenciones

- Unidades: todo interno en WAD (18 dec). USDG 6 dec → `× 1e12` al entrar, `floor(÷ 1e12)` al salir. Feeds 8 dec.
- Redondeo contra el actor: shares minteadas floor, USDG pagado floor, fees ceil.
- Toda llamada externa a contratos del emisor/upgradeables va en try/catch (NAVLib) o mide deltas (adapters, 1.4).
- Direcciones solo del `AddressBook` (hay tokens impostores en la chain).
- Tests: unit con mocks (`test/unit`), fork con estado real (`test/fork`), fuzzing (`test/invariant`).
- Correr fork tests: `set -a && source ../../.env && set +a && forge test`.


## Revisión 1.4a (trading) — hallazgos aplicados

**T1 (HIGH)**: `_valueWad`/`_tryPrice` del path de trading solo comprobaban `px>0` (no frescura ni banda como NAVLib) → un feed stale-pero-positivo (finde, o durante un split ERC-8056) cegaba a la vez el guardarraíl Y los presupuestos → extracción ilimitada. Fix: `_validPrice` con la MISMA disciplina que NAVLib (frescura ≤ maxStaleness, banda min/max, no futuro), revierte si inválido; USDG igual (T6). Mediums: T7 (vender token suspendido permitido, solo comprar prohibido), T8 (wash por par vía `dirTradeTime` mapping, inmune a interleaving), T4 (denominador stake = min(vivo, snapshot@settlement); register-before-accrue), T5 (adapter debe quedar con balance cero tras el trade), T9 (`deregisterAsset` de posiciones cero), T10 (nonReentrant defense-in-depth). T11: ventana diaria fija (no rodante) — documentado en SPEC como aceptado. Tests: +7 unit (Trading.t.sol). El fork test de trading amplía maxStaleness a 10d porque el fork es en finde (en prod el trading de finde queda bloqueado — comportamiento correcto).


## Fase 1.5 — gobernanza y onboarding

- **EligibilityGate**: atestaciones EIP-712 `(account, expiry, nonce)` firmadas por el compliance signer; `attest` permissionless (la firma autoriza), TTL 90d, `revoke` por el signer, anti-replay por nonce, rechazo de s-alta (EIP-2). Sustituye al MockGate.
- **FeeSplitter**: uno por fondo, DESPLEGADO INTERNAMENTE por el Fund (rompe la circularidad Fund↔FeeSplitter). El Fund mintea perf-fee shares aquí; `redeem` las mete en la cola, `distribute` reparte 90/10 manager/protocolo.
- **Guardian**: dos velocidades — `pauseFund`/`unpauseFund` instantáneo (freno de emergencia, nunca toca retiros), y `queue`/`execute` con DELAY (2d) para gestión de registries. Owner = multisig externo (Safe). Ostenta ownership de TokenRegistry+AdapterRegistry.
- **FundFactory**: `createFund` gatea al manager por elegibilidad, inyecta params de protocolo (registries/gate/guardian/keeper/treasury) para que el manager no cablee los suyos. Deploy directo con `new` (no clones ERC-1167: el Fund despliega 5 sub-contratos en constructor; divergencia con spec documentada).
- **Cambio en Fund.sol**: constructor pierde `feeSplitter` (interno) y gana `GUARDIAN`; `guardianPaused` gatea depósitos+trading (nunca retiros, D12); `setGuardianPaused` solo GUARDIAN. Orden nuevo: (reg, gate, adapters, guardian, manager, keeper, treasury, cfg, name, symbol).


## Revisión 1.5 (gobernanza) — hallazgos aplicados

**G1 (HIGH)**: la revocación del EligibilityGate era evadible — `revoke()` no avanzaba el nonce y `attest()` limpiaba `revokedAt`, así que una firma pre-emitida (renovación/atestación inicial no enviada) re-habilitaba a un usuario revocado, deshaciendo el control de compliance. Fix: `revoke()` avanza el nonce → re-habilitar exige firma posterior a la revocación. Mediums: G2 (Guardian gana GRACE_PERIOD 14d + MIN_DELAY 1d). Lows: G3 (domain separator recomputado en fork), G4 (FeeSplitter: code-check USDG, `redeem(inKind)` + `distributeToken` genérico), G5/G7 (trading del manager gateado por elegibilidad ongoing, fail-safe: no gatea winding/retiros), G12 (error `NotGuardian`). Docs: nonce en atestación, ERC-1167 (usamos `new`), FeeSplitter solo perf fee, depeg = pauseFund. **El manager que devenga inelegible no puede tradear pero SÍ cerrar ordenadamente; los LPs siempre salen.**


## Desplegabilidad (EIP-170) — refactor de tamaño

Al escribir el deploy script se descubrió que el `Fund` pesaba 32.7KB > límite de 24.5KB (EIP-170):
INDESPLEGABLE. Corregido a **24,542 (34B de margen)** haciendo `public` (no `internal`) las funciones
grandes de `NAVLib` (`compute`, `tradeValueWad`, `freshnessCutoff`, `sliceValueWad`) — se despliegan
como librería enlazada (delegatecall) en vez de inlinearse en el Fund. Comportamiento idéntico (117
tests siguen verdes). `via_ir=true`, `optimizer_runs=1`.

**FundFactory → FundRegistry**: la factory hacía `new Fund(...)`, embebiendo el creation code del Fund
(38KB) en su runtime (40KB, indesplegable). En v1 los fondos se despliegan DIRECTOS por el operador
(script `CreateFund.s.sol`, initcode 38KB < 49KB EIP-3860) y se registran en el `FundRegistry` ligero.
El gate de elegibilidad del manager se movió al **constructor del Fund**. Factory permissionless con
clones ERC-1167 + initialize → v2.

Scripts: `script/Deploy.s.sol` (protocolo compartido), `script/CreateFund.s.sol` (un fondo). Deploy
completo simulado OK contra fork de mainnet.

## Fleco (hallado por la revisión del indexer, 2026-07-20): valor in-kind no eventeado

`WithdrawExecuted(orderId, lp, shares, paid6, inKind)` solo lleva la pata USDG (`paid6`); el
`removedWad` (valor total entregado en tokens, calculado en `_executeInKind`) no se emite y los
transfers por asset tampoco eventean. Consecuencia: ningún indexer puede responder "qué recibió el
LP en su retiro in-kind y cuánto valía" — `withdrawn6`/PnL realizado subrepresentan las salidas
in-kind (incluye forceRedeem y la válvula de crisis). **Cambio solo posible PRE-deploy** (después
es imposible). Opciones: añadir `removedWad` a WithdrawExecuted (ojo: Fund a 34 bytes del límite
EIP-170) o un evento `InKindSlice(orderId, token, amount)` por asset. Fallback si no cabe: el
indexer reconstruye leyendo balances block-1 vs block (caro, no aísla órdenes en el mismo batch).

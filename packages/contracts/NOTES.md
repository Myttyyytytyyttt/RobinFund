# Notas de implementación de contratos

Estado y decisiones que no viven en el código ni en la spec. Para retomar sin releer todo.

## Estado por fase (ver git log para commits)

| Fase | Qué | Tests | Estado |
|---|---|---|---|
| 0 | Monorepo, AddressBook, fork smoke | 6 fork | ✅ |
| 1.1 | `TokenRegistry` + `NAVLib` | 45 | ✅ revisado |
| 1.2 | `FundShare`, `QueueEscrow`, `StakeEscrow`, `CompensationReserve` | 63 | ✅ revisado |
| 1.3a | `Fund` núcleo (sin trading) | 80 + 4 inv | ✅ revisión en curso |
| 1.3b | Flecos: true-up del collar in-kind, fill parcial del cap (C19), Frozen completo | — | pendiente |
| 1.4 | Adapters de trading (Uniswap v4 + 0x), guardarraíl de slippage, liquidación keeper-asistida | — | pendiente |
| 1.5 | `EligibilityGate` (EIP-712), `FeeSplitter`, `Guardian`, `FundFactory` | — | pendiente |

## Diferido explícitamente en Fund.sol 1.3a (buscar "1.3a" / "TODO" / "DIFERIDO" en el header)

1. **Trading** — el Fund valora activos si se le transfieren pero no opera. `registerAsset` ya existe (orden estricto). El adapter de 1.4 comprará/venderá vía el PoolManager v4 (embrión probado en `test/fork/SmokeOracleSwap.t.sol::V4SwapProbe`) y llamará a `registerAsset`.
2. **Liquidación keeper-asistida de retiros cash** — hoy un retiro cash solo ejecuta si el USDG del fondo lo cubre; si no, se para (el LP puede convertir a in-kind). En 1.4 el keeper liquidará slices pro-rata con el guardarraíl de slippage y el saliente absorbe el shortfall (§5.6.3).
3. **True-up al alza del collar in-kind** — `_executeInKind` usa `max(precioValido, lastValidSharePrice)` en el burn pero sin la corrección al alza posterior de §6 cuando aparece una ronda mejor. Bounded, documentado.
4. **Fill parcial del cap (C19)** — hoy un depósito que excede el cap espera al siguiente batch (total-o-nada); la spec pide fill parcial + refund del remanente.
5. **Frozen completo (§10.3)** — hoy `declareFrozen` cachea el flag y anula depósitos; falta la valoración con haircut de activos bloqueados, la quema parcial proporcional USDG-only, y saltar tokens que reviertan (el esqueleto try/catch está en `_executeInKind`).
6. **Residual de tokens intransferibles en in-kind** — el `ok` del try/catch se ignora; falta dejar el slice como claim in-kind.

## Invariantes que el Fund debe cumplir (verificados por fuzzing; mantener en cambios)

- `niAggregateWad == Σ NI_lp` (cuentas ≠ FEE_SPLITTER)
- `Σ claims de por vida del LP ≤ capital neto aportado`
- reserva: caja ≥ `totalFunded − totalPaid`
- `queue.balance() == queuedDeposits6`
- `funding = min(stake, neteado, grossClaims)` — el neteado es el techo (Sybil-inmune); grossClaims solo baja λ

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

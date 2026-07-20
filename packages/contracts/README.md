# NuvemFund — Contratos

Protocolo de **fondos sociales sobre Stock Tokens** en Robinhood Chain (chain ID 4663). Un manager
crea un fondo, bloquea un **stake first-loss** en USDG, y opera Stock Tokens (NVDA, TSLA, SPY…) con
capital de terceros. Los LPs entran/salen a NAV; el stake del manager cubre sus primeras pérdidas.

> **Esta es la brújula del proyecto.** Para saber por dónde vamos: esta página (qué existe y cómo
> encaja) + [NOTES.md](NOTES.md) (decisiones, deferidos, hallazgos de revisión) + [../../docs/SPEC.md](../../docs/SPEC.md)
> (mecanismo, v0.9.2) + [../../docs/REVIEW.md](../../docs/REVIEW.md) (historial de revisión adversarial del diseño).

---

## Estado (2026-07-20)

**Capa de contratos on-chain COMPLETA.** 120 tests en verde (unit con mocks + fork contra estado real
de mainnet 4663 + fuzzing de invariantes). Cada sub-fase pasó por revisión adversarial y aplicó los
hallazgos. Tres `HIGH` cerrados en revisión (ver más abajo).

| Fase | Contratos | Tests | Estado |
|---|---|---|---|
| 0 | AddressBook + verificación on-chain | 6 fork | ✅ |
| 1.1 | `TokenRegistry`, `NAVLib` | 36 | ✅ revisado |
| 1.2 | `FundShare`, `QueueEscrow`, `StakeEscrow`, `CompensationReserve` | 18 | ✅ revisado |
| 1.3a | `Fund` (núcleo) | +26 | ✅ revisado (3 lentes) |
| 1.4a | `AdapterRegistry`, `UniswapV4Adapter` + `Fund.execute` | +10 | ✅ revisado |
| 1.5 | `OpenEligibilityGate`, `FeeSplitter`, `Guardian`, `FundRegistry` + scripts de deploy | +23 | ✅ acceso abierto |

Todos los contratos < 24.5KB (EIP-170); deploy completo simulado OK contra fork de mainnet, y
**ejercitado end-to-end** por el test de integración del keeper (anvil forkeando mainnet + estos mismos
scripts + ciclo de vida LP completo — ver `packages/keeper`). **Pendiente** (flecos con fallback seguro,
ver §Deferidos): Frozen §10.3 completo, liquidación keeper-asistida de retiros cash, 0x RFQ adapter,
fill parcial del cap. **Off-chain** (Fase 2): keeper e indexer completos. El compliance signer existe
como módulo legado auditado, pero **no se despliega ni participa** mientras NuvemFund sea permissionless.

---

## Arquitectura

Un **fondo** = un contrato `Fund` que despliega en su constructor 5 sub-contratos propios (uno por
fondo). Los **registries** y la **gobernanza** son compartidos por todos los fondos.

```
                    ┌──────────────────── COMPARTIDO ────────────────────┐
                    │  TokenRegistry   AdapterRegistry  OpenEligibilityGate│
                    │  (activos+feeds) (venues trading) (siempre abierto)  │
                    │  Guardian (timelock, owner de los registries)       │
                    │  FundRegistry (índice de fondos desplegados)        │
                    └──────────────┬──────────────────────────────────────┘
                                   │ deploy directo (script) + register
                    ┌──────────────▼────────── POR FONDO ─────────────────┐
                    │                    Fund                              │
                    │   despliega en su constructor:                       │
                    │   ├─ FundShare          (ERC-20 no transferible)     │
                    │   ├─ QueueEscrow        (USDG de depósitos en cola)  │
                    │   ├─ StakeEscrow        (stake first-loss)           │
                    │   ├─ CompensationReserve(claims del first-loss)      │
                    │   └─ FeeSplitter        (perf fee 90/10)             │
                    └─────────────────────────────────────────────────────┘
```

### Dependencias externas (Robinhood Chain, verificadas on-chain — ver AddressBook.sol)
- **USDG** (`0x5fc5…d168`, **6 decimales**) — denominación de todo.
- **Stock Tokens** RHJ (ERC-20 18 dec + ERC-8056; beacon proxies upgradeables por el emisor).
- **Chainlink** feeds por activo (8 dec, heartbeat 24h) + feed **USDG/USD** (`0x61B7…9aD2`).
- **Uniswap v4** PoolManager (la liquidez real vive en v4; el pool v3 está vacío).

---

## Los contratos, uno a uno

### Compartidos

| Contrato | Qué hace | Puntos clave |
|---|---|---|
| **`AddressBook`** | Direcciones verificadas de la chain | ⚠ Hay tokens impostores (NVDA/USDG falsos): direcciones SOLO de aquí. |
| **`TokenRegistry`** | Universo de activos operables: cada Stock Token con su feed, `maxStaleness` (heartbeat+margen), bandas de cordura de precio | Suspensión permissionless por drift de beacon (C29). Owner → Guardian. |
| **`AdapterRegistry`** | Whitelist de venues de trading | Owner-gated. |
| **`OpenEligibilityGate`** | Gate inmutable usado por todos los despliegues actuales | Cualquier wallet es elegible; devuelve siempre `ineligibleSince=0`; no tiene owner, signer ni revocación. |
| **`EligibilityGate`** | Módulo EIP-712 legado, conservado para referencia/regresión | **Inactivo y no desplegado** en el producto permissionless. |
| **`Guardian`** | Gobernanza de 2 velocidades | `pauseFund` instantáneo (freno, nunca retiros) + `queue/execute` timelockeado (delay ≥1d, gracia 14d). Owner = multisig externo. |
| **`FundRegistry`** | Índice de fondos desplegados | Los fondos se despliegan directos (script) y se registran; el constructor recibe el gate abierto inmutable. Factory con clones → v2. |

### Librerías

| Contrato | Qué hace |
|---|---|
| **`NAVLib`** | Valoración WAD del NAV + validez (§5.2). **Toda llamada externa en try/catch**: un feed muerto o un upgrade hostil del emisor degradan a `valid=false`, jamás revierten. Bandas de precio anti-glitch. |
| **`SafeTransferLib`** | Transfers ERC-20 tolerantes a tokens sin return value (USDG es proxy). |

### Por fondo

| Contrato | Qué hace | Puntos clave |
|---|---|---|
| **`Fund`** | El núcleo (942 líneas). Colas con forward pricing, contabilidad NI de por vida, first-loss, fees, settlement, estados, trading | Ver §Fund abajo. |
| **`FundShare`** | Shares del fondo, **NO transferibles** (D7) | Solo mint/burn por el Fund: simplifica NI/first-loss y liga el acceso social a la posición real. |
| **`QueueEscrow`** | Custodia el USDG de depósitos aún en cola, **separado del Fund** | Un block de RHJ al Fund no alcanza el dinero no invertido (C11). |
| **`StakeEscrow`** | El stake first-loss del manager | Timelock 7d + ventana 30d para retirar; el slash SOLO va a la reserva; liberación two-step con gracia. |
| **`CompensationReserve`** | Funding y claims pull del first-loss, por período | `Σ pagado ≤ fondeado`; residuo barrido al manager solo en Closed (`totalShares==0`). |
| **`FeeSplitter`** | Reparte la performance fee 90/10 manager/protocolo | Desplegado por el Fund (rompe circularidad). `redeem(inKind)` + `distributeToken`. |
| **`UniswapV4Adapter`** | Swap exact-in contra el PoolManager v4 | Stateless (no retiene fondos). El Fund mide sus propios deltas y aplica el guardarraíl. |

---

## El `Fund` en detalle (SPEC §4–§10)

**Ciclo de vida**: `Active → (PendingWinding) → Winding → Closed`, más `Frozen` (si RHJ bloquea el fondo).

**Acceso**: completamente abierto. Manager y LPs no presentan KYC ni atestaciones. Cada `Fund`
guarda un `OpenEligibilityGate` inmutable que devuelve elegible para cualquier dirección; por ello
la ruta heredada `forceRedeem` no puede activarse. SIWE en el website solo autentica propiedad de
wallet para datos sociales, no identidad civil ni elegibilidad on-chain.

**Entrar/salir** (colas, §5): `requestDeposit`/`requestWithdraw` encolan; `executeBatch` las procesa
en la primera ventana de NAV válido con **forward pricing estricto** (la orden ejecuta contra una ronda
de precio *posterior* a la solicitud — nunca contra un precio pasado). Los retiros in-kind tienen su
propio path `executeInKindWithdrawals` que **no requiere NAV válido** (válvula de escape D12: funciona
en pausa/depeg/Frozen).

**First-loss (§6, el corazón económico)**: cada LP tiene un `NI` = capital neto invertido **de por
vida** (sin resets). En cada settlement, si el fondo perdió, el stake fondea `funding = min(stake,
pérdida_neta_agregada)` — **keeper-independiente**. Cada LP cobra un claim = su pérdida real × cobertura
(vesting) × λ, donde `λ = min(1, funding/grossClaims)`. Invariantes (verificados con fuzzing de 8k+
llamadas): `claim ≤ pérdida real`, `Σ claims de por vida ≤ capital aportado`, `NI_agregado ≡ Σ NI_lp`.

**Fees (§7)**: entry fee opcional en curva (split manager/fondo/protocolo, la parte "fondo" sube el
NAV de los LPs existentes). Perf fee sobre HWM ajustado, minteada como shares al FeeSplitter.

**Trading (§8)**: `execute(adapterId, tokenIn, tokenOut, amountIn, data)` — solo manager elegible, solo
adapters whitelisteados. **El Fund mide sus propios deltas de balance** y aplica el guardarraíl de
slippage contra el cruce Chainlink (con la misma disciplina de validez que el NAV: feed fresco + en
banda) + presupuesto acumulado (día/período) + anti-wash. No confía en el adapter.

**Settlement (§9)**: marca no discrecional (primera ventana válida ≥ due); degradado tras 7d sin ventana.

---

## Cómo correr

```bash
cd packages/contracts
forge build
forge test                       # unit (mocks) — rápido
# fork tests (estado real de la chain): necesitan RH_RPC_MAINNET del .env raíz
set -a && source ../../.env && set +a && forge test
```

Tests: `test/unit` (mocks, cada contrato), `test/fork` (estado real de mainnet 4663), `test/invariant`
(fuzzing de los invariantes del Fund).

---

## Highs cerrados en revisión adversarial

Cada sub-fase se sometió a workflows de revisión de 2–3 lentes (economía/solidity/spec). Los tres más
graves, todos con test de regresión que replica el exploit:

1. **S3 (1.3a) — funding dependiente del keeper**: al implementar, capar `funding` por `grossClaims`
   permitía a un keeper sub-declarante reducir la salida del stake (rug). → keeper-independiente.
2. **T1 (1.4a) — guardarraíl de slippage cegado**: el trade valoraba con solo `px>0`; un feed
   stale-pero-positivo (finde/split) cegaba guardarraíl y presupuestos → extracción ilimitada. → validez
   completa de NAVLib en el path de trading.
3. **G1 (1.5) — revocación de compliance evadible**: una firma pre-emitida re-habilitaba a un usuario
   revocado. → `revoke()` avanza el nonce.

Y dos **bugs de spec que solo aparecieron al implementar** (el valor de escribir código, no solo
especificar): el keeper-trust de S3, y el fee-fondo rompiendo el precio seed con `supply==0`.

---

## Deferidos (con fallback seguro — ver NOTES.md para el detalle)

- **Frozen §10.3 completo** — falta la quema parcial USDG-only y el haircut temporal de activos
  bloqueados. Implementado: void de depósitos, trading off, first-loss suspendido, in-kind
  NAV-independiente. *Fallback*: el in-kind siempre sale.
- **Liquidación keeper-asistida de retiros cash** — hoy un retiro cash espera si el fondo no tiene USDG
  suficiente. *Fallback*: el LP convierte a in-kind.
- **0x RFQ adapter** — solo Uniswap v4 por ahora.
- **Fill parcial del cap (C19)** — hoy es total-o-siguiente-batch.

---

## Convenciones (mantener en cualquier cambio)

- **Unidades**: interno todo en WAD (18 dec). USDG 6 dec → `×1e12` al entrar, `floor(÷1e12)` al salir. Feeds 8 dec.
- **Redondeo contra el actor**: shares minteadas floor, USDG pagado floor, fees ceil.
- **Llamadas externas** a contratos del emisor/upgradeables: try/catch (valoración) o medición de deltas (trading). Nunca revertir el cálculo por un fallo externo.
- **Direcciones**: solo del `AddressBook` (hay impostores).
- **Retiros nunca se bloquean** por gobernanza/compliance/pausa (D12). Solo se gatean depósitos y trading.

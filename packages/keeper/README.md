# RobinFund — Keeper

Los bots que hacen que el protocolo opere solo. Corren contra Robinhood Chain (4663) leyendo el estado
on-chain de los `Fund` y disparando las acciones permissionless que nadie más va a disparar.

## Qué hace

| Módulo | Responsabilidad |
|---|---|
| `grossClaims.ts` | **El cálculo crítico**: suma la pérdida vesteada de cada LP (`Σ loss_lp × cobertura`) para pasarla a `settle()`. Replica bit a bit `Fund._touch`. |
| `fundReader.ts` | Lee el estado de un fondo: descubre LPs desde eventos `DepositExecuted`, lee su NI/shares/vestTime, el NAV, el stake. |
| `settlement.ts` | `assessFund` (snapshot + grossClaims + decisión) y la decisión pura de settlear (due + NAV válido, o degradado tras 7d). |
| `runner.ts` | El orquestador: enumera los fondos del `FundRegistry` y por cada uno **planifica** (`planActions`, pura) y **ejecuta** las tx: `executeBatch`, `settle` degradado, válvula in-kind, `declareFrozen`, `forceRedeem`. |
| `monitors.ts` | Vigila: fondo bloqueado por RHJ; drift de beacon; LP inelegible pasada la gracia. |
| `main.ts` | Entry point: bucle de ticks con intervalo configurable, firma con `KEEPER_PK`, logs JSON. |
| `abi.ts` | ABI mínimo de Fund/share/escrow/gate/registry que el keeper consume. |

## Por qué `grossClaims` es lo más importante

El first-loss del protocolo necesita que un actor **off-chain** sume la pérdida de todos los LPs — el
contrato no puede iterar el set on-chain. El keeper calcula ese escalar y se lo pasa a `settle()`.

**Seguridad**: aunque el keeper mienta, no puede robar. `funding = min(stake, pérdida_neta_agregada)`
es keeper-independiente (calculado on-chain); `grossClaims` solo entra en `λ = min(1, funding/gross)`,
que reparte. Un `grossClaims` mal calculado solo mis-escala el reparto (efecto acotado, nunca solvencia
— ver el `HIGH` S3 en el README de contracts). Aun así lo queremos exacto: el cálculo está unit-testeado
contra la fórmula exacta de `_touch`, incluido el caso que verifica la propiedad de S3.

## Decisiones del runner que importan

- **Reloj = timestamp del último bloque**, nunca el de pared: el contrato compara contra
  `block.timestamp`; con drift de chain (o un anvil warpeado) el reloj de pared decide mal.
- **Settlement degradado → `settle()` directo, nunca `executeBatch`**: el batch settlearía y luego
  revertiría `NavInvalid` al procesar colas, deshaciendo el settlement dentro de la misma tx.
- **NAV inválido + retiros en cola**: solo dispara `executeInKindWithdrawals` si la cabeza de la cola
  es in-kind con cooldown vencido (el cash espera al NAV; una tx a ciegas sería gas quemado).

## Correr

```bash
pnpm install
pnpm test          # 33 tests unit: grossClaims, settlement, monitors, planner del runner
pnpm test:e2e      # E2E contra anvil forkeando mainnet (necesita RH_RPC_MAINNET en el .env raíz + foundry)
pnpm start         # el keeper real (compila y arranca el bucle)
```

Config del runner por env (el `.env` raíz se carga solo): `KEEPER_RPC_URL` (fallback `RH_RPC_MAINNET`),
`KEEPER_PK` (sin ella: dry-run), `FUND_REGISTRY` (obligatoria), `ACCESS_REGISTRY` (default mainnet),
`KEEPER_START_BLOCK` (bloque del deploy, acota el scan de eventos), `KEEPER_INTERVAL_S` (default 300),
`KEEPER_DRY_RUN=1` (fuerza dry-run).

## El test E2E (Fase 2b)

`integration.test.ts` cierra el bucle completo: levanta un **anvil forkeando mainnet**, despliega el
protocolo con los **mismos scripts** que irán a producción (`Deploy.s.sol` + `CreateFund.s.sol`),
atesta manager y LP (EIP-712 real contra el `EligibilityGate`), y recorre el ciclo de vida entero
disparado por el **mismo runner** de producción: depósito → batch (forward pricing) → warp 30d →
settlement (grossClaims computado off-chain) → retiro cash tras cooldown → monitores contra el
ACCESS registry real de RHJ.

Única pieza sustituida: el feed USDG/USD se apunta a un `MockFeed` vía la API pública del
`TokenRegistry` (el deployer aún es owner; la transferencia al Guardian es two-step). En un fork los
feeds Chainlink son estáticos y el forward pricing exige rondas *posteriores* a cada solicitud — el
mock nos deja publicarlas al warpear.

## Estado

**Fase 2a + 2b completas**: cálculo, lector, decisión, runner con firma/envío de tx, y E2E verde.
El servicio de firma de compliance vive en `packages/compliance-signer` (Fase 2c). **Pendiente
(resto de Fase 2)**: indexer (Ponder) para el frontend, alertas/telemetría del keeper (hoy: logs
JSON a stdout).

> Los cálculos DEBEN mantenerse en sync con `Fund._touch`/`_settle`. Si cambia la matemática del
> first-loss en el contrato, actualizar `grossClaims.ts` y sus tests.

# RobinFund — Keeper

Los bots que hacen que el protocolo opere solo. Corren contra Robinhood Chain (4663) leyendo el estado
on-chain de los `Fund` y disparando las acciones permissionless que nadie más va a disparar.

## Qué hace

| Módulo | Responsabilidad |
|---|---|
| `grossClaims.ts` | **El cálculo crítico**: suma la pérdida vesteada de cada LP (`Σ loss_lp × cobertura`) para pasarla a `settle()`. Replica bit a bit `Fund._touch`. |
| `fundReader.ts` | Lee el estado de un fondo: descubre LPs desde eventos `DepositExecuted`, lee su NI/shares/vestTime, el NAV, el stake. |
| `settlement.ts` | Decide si settlear (due + NAV válido, o degradado tras 7d) y envía `settle(grossClaims)`. |
| `monitors.ts` | Vigila: fondo bloqueado por RHJ → `declareFrozen`; drift de beacon → suspender activo; LP inelegible pasada la gracia → `forceRedeem`. |
| `abi.ts` | ABI mínimo del Fund/share/escrow/registry que el keeper consume. |

## Por qué `grossClaims` es lo más importante

El first-loss del protocolo necesita que un actor **off-chain** sume la pérdida de todos los LPs — el
contrato no puede iterar el set on-chain. El keeper calcula ese escalar y se lo pasa a `settle()`.

**Seguridad**: aunque el keeper mienta, no puede robar. `funding = min(stake, pérdida_neta_agregada)`
es keeper-independiente (calculado on-chain); `grossClaims` solo entra en `λ = min(1, funding/gross)`,
que reparte. Un `grossClaims` mal calculado solo mis-escala el reparto (efecto acotado, nunca solvencia
— ver el `HIGH` S3 en el README de contracts). Aun así lo queremos exacto: el cálculo está unit-testeado
contra la fórmula exacta de `_touch`, incluido el caso que verifica la propiedad de S3.

## Correr

```bash
pnpm install
pnpm test        # 23 tests: grossClaims, settlement, monitors
pnpm typecheck
```

## Estado (Fase 2a)

Implementado y testeado: el cálculo de `grossClaims`, el lector on-chain, la decisión de settlement, y
la lógica de los monitores. **Pendiente (2b)**: el runner con scheduling (cron/loop), la firma y envío
de tx real, y un test de integración contra un `anvil` con el protocolo desplegado (deploy scripts en
`packages/contracts/script`). El `settlement.runSettlement` ya tiene el modo `send` para enviar tx;
falta el orquestador que lo llama periódicamente sobre todos los fondos del `FundRegistry`.

> Los cálculos DEBEN mantenerse en sync con `Fund._touch`/`_settle`. Si cambia la matemática del
> first-loss en el contrato, actualizar `grossClaims.ts` y sus tests.

# Estado de despliegue

Última actualización: 2026-07-21 (Europe/Lisbon).

## Punto de partida

- Rama: `main`
- Commit: `b5ebf15`
- Modelo de acceso: permissionless mediante `OpenEligibilityGate`
- Cambio local ajeno a esta fase: `website/src/fronts/NuvemFundHero.tsx` (preservado)
- Devnet encontrada viva, pero desplegada antes de la migración permissionless

## Fases

| Fase | Estado | Criterio de salida |
|---|---|---|
| D0 · Documentación | En curso | Runbook y outputs creados |
| D1 · Reinicio limpio | Pendiente | RPC, GraphQL, keeper y web usan el deployment nuevo |
| D2 · TestnetAssetPack | Pendiente | USDG, stocks, feeds, registry y trading de prueba desplegables |
| D3 · E2E local del pack | Pendiente | Ciclo completo sin depender de state overrides del fork |
| D4 · Deploy 46630 | Pendiente | Contratos verificados y direcciones registradas |
| D5 · Servicios testnet | Pendiente | Keeper/indexer persistentes y frontend conectado |
| D6 · Soak | Pendiente | 72 h con reinicios y fallos controlados |

## Hallazgos iniciales

1. El RPC local en `8545` responde con chain ID 4663 y el indexer en `42069` responde.
2. El fondo de esa instancia apunta al `EligibilityGate` legado; una wallet arbitraria no es elegible.
3. Un deploy fresco del commit actual sí produjo un `OpenEligibilityGate` de 188 bytes y devolvió
   `true` para una wallet arbitraria.
4. El comando de drill quedó esperando después de que `forge script` ya hubiese escrito y minado el
   broadcast. El harness debe tener timeout, logs incrementales y terminación explícita.
5. En testnet 46630 no hay bytecode en las direcciones mainnet de USDG, TSLA, feed TSLA ni registry
   de RHJ. El deploy mainnet no puede reutilizarse allí sin un asset pack específico.

## Bloqueadores mainnet que no se omiten

- residual reclamable cuando un Stock Token bloqueado falla durante un retiro in-kind;
- auditoría externa y pre-audit estático;
- multisig/timelock y ownership final;
- operación redundante 24/7 y plan de incidentes;
- opinión legal sobre la distribución permissionless de Stock Tokens.


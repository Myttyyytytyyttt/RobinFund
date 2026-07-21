# NuvemFund — Devnet local permissionless

Un devnet completo sobre **anvil forkeando mainnet 4663**: el estado real de la chain (USDG,
Stock Tokens, liquidez de Uniswap v4, ACCESS registry de RHJ) con el protocolo desplegado encima
por los **scripts de producción**, y los dos servicios activos de la capa 2 corriendo como procesos reales.
Controlas el tiempo (un settlement de 30 días en segundos) y es gratis.

Única pieza no-real: los feeds USDG/TSLA se re-apuntan a mocks controlables sembrados con el precio
real del momento del fork — en un fork los feeds Chainlink no publican rondas nuevas y el forward
pricing las exige.

## Dos comandos

```bash
pnpm drill     # el drill: la vida entera de un fondo, 27 asserts, scorecard, y teardown
pnpm devnet    # devnet vivo con fondo demo + creator API local para el frontend (Ctrl-C para parar)
```

Ambos necesitan `RH_RPC_MAINNET` en el `.env` raíz y `foundry` en el PATH. `pnpm devnet` imprime
las URLs (RPC y GraphQL), las direcciones de los contratos y las cuentas. No existe signer/KYC.

## El drill (`pnpm drill`)

9 actos que ejercitan el sistema entero. El keeper actúa **por sus propios ticks** (no lo llamamos a
mano): nosotros solo movemos el tiempo, los precios y las tx de usuario, y esperamos a que reaccione.

| Acto | Qué prueba |
|---|---|
| 1 · Acceso abierto | manager, LPs y una wallet arbitraria entran sin onboarding, firma, país ni KYC |
| 2 · Capital | stake del manager + depósitos; el keeper ejecuta los batches con forward pricing |
| 3 · Trading | el manager compra TSLA contra el **Uniswap v4 real** del fork; NAV valora acciones + cash |
| 4 · Ganancia | +50% en TSLA, warp 30d, el keeper settlea, perf fee cristaliza al FeeSplitter |
| 5 · Pérdida | TSLA a 0,4×, el keeper computa grossClaims off-chain y settlea; **el stake se slashea** (first-loss); el LP cobra su claim |
| 6 · Salidas | LP sale cash (cooldown + forward pricing), otro sale in-kind (recibe TSLA + USDG) |
| 7 · Permissionless | ninguna wallet puede volverse inelegible; `forceRedeem` revierte y el LP conserva sus shares |
| 8 · Crisis | se bloquea el fondo en el **ACCESS registry real de RHJ** → el keeper declara Frozen; depósitos rechazados |
| 9 · Cierre | winding → el keeper transiciona a Winding vía la válvula in-kind |
| 0 · Indexer | el GraphQL refleja fondo, serie de precios (con el período de first-loss), y el feed de actividad |

El acto 8 (bloqueo por RHJ) es el escenario §10.3 que **solo un fork permite** ensayar — en una chain
pública no puedes manipular el registry del emisor.

## Lo que este devnet NO prueba

Persistencia 24/7, latencia real de red, y el login de wallet/SIWE desde el navegador. Eso es para la
**testnet real** (46630) — que además está vacía para nosotros (RHJ no replicó USDG/feeds/Stock
Tokens allí), así que requeriría desplegar mocks propios. El fork prueba mejor la *mecánica*; la
testnet real probará la *operación*.

## Estructura

- `chain.ts` — boot de anvil, clientes viem, control de tiempo, `dealErc20`, manipulación del ACCESS registry
- `deploy.ts` — deploy con los scripts reales + feeds mock; `OpenEligibilityGate` no requiere bootstrap
- `services.ts` — levanta keeper/indexer como procesos reales y habla con el GraphQL
- `drill.ts` — los 9 actos + scorecard
- `devnet.ts` — el devnet vivo con fondo demo

> Las cuentas son las del mnemonic estándar de anvil (claves públicas de test — nunca con fondos reales).

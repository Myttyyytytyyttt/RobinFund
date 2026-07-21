# Estado de despliegue

Última actualización: 2026-07-21 (Europe/Lisbon).

## Punto de partida

- Rama: `main`
- Commit base: `085ca02`
- Modelo de acceso: permissionless mediante `OpenEligibilityGate`
- Cambios de esta fase todavía sin commit
- La devnet anterior se sustituyó por un deployment permissionless limpio

## Fases

| Fase | Estado | Criterio de salida |
|---|---|---|
| D0 · Documentación | Completada | Runbook y outputs creados |
| D1 · Reinicio limpio | Completada | RPC, GraphQL, keeper y web usan el deployment nuevo |
| D2 · TestnetAssetPack | Completada | USDG, 5 stocks, 6 feeds, registry y venue desplegables |
| D3 · E2E local del pack | Completada | Ciclo completo sobre una chain 46630 vacía + keeper + Ponder |
| D4 · Deploy 46630 | Completada | Asset pack, protocolo y Fund canario públicos + smoke real |
| D5 · Servicios testnet | Completada localmente | Keeper 60 s, Ponder persistente y frontend testnet conectados |
| D6 · Soak | Pendiente | 72 h con reinicios y fallos controlados |
| D7 · TestBots público | Completada | 3 bots, 4 trades, fees, retiros y cierre reconciliados |
| D8 · Entry fee dinámica | Completada | Curva 0%-5%, 3 tasas FIFO y transfers reconciliados |

## Hallazgos iniciales

1. El RPC local en `8545` responde con chain ID 4663 y el indexer en `42069` responde.
2. El fondo de esa instancia apunta al `EligibilityGate` legado; una wallet arbitraria no es elegible.
3. Un deploy fresco del commit actual sí produjo un `OpenEligibilityGate` de 188 bytes y devolvió
   `true` para una wallet arbitraria.
4. El comando de drill quedó esperando después de que `forge script` ya hubiese escrito y minado el
   broadcast. El harness debe tener timeout, logs incrementales y terminación explícita.
5. En testnet 46630 no hay bytecode en las direcciones mainnet de USDG, TSLA, feed TSLA ni registry
   de RHJ. El deploy mainnet no puede reutilizarse allí sin un asset pack específico.

## TestnetAssetPack aceptado

- `TestnetUSDG`: 6 decimales y faucet de 100,000 tUSDG por wallet/día.
- `TestnetStockToken`: 18 decimales, superficie ERC-8056, pausa y blacklist compartida.
- Cinco stocks sin valor: tTSLA, tNVDA, tAAPL, tMSFT y tSPY.
- Seis feeds de 8 decimales con `poke()` permissionless para forward pricing.
- Venue separado y adapter bidireccional al precio de los feeds, sin residuos en el adapter.
- Todos los contratos administrativos del pack revierten en chain ID 4663.
- Build limpio: `Fund` 24,267 B, margen EIP-170 de 309 B.
- Contratos: 116 unit/invariant + 12 fork = 128 tests verdes.
- E2E 46630 local: depósito, buy/sell, perf fee, pérdida + first-loss, cash, in-kind,
  winding/cierre, blacklist, pausa, beacon drift y reconstrucción Ponder en `Closed`.
- Keeper: 30 unit + 4 E2E verdes.
- Indexer: typecheck + 7/7 E2E verdes.
- Frontend: build de producción Vite + 3 unit verdes; integración Supabase omitida al no ser parte
  del pack local.

Output íntegro: `outputs/2026-07-21-testnet-asset-pack.md`.

## Deployment público 46630

- RPC y chain ID: correctos.
- Wallet desechable de testnet: `0xC632137E0C6657dcfA4b3709Ebf7C2a59fB62C71`.
- Private key: solo en `.env`, gitignored; nunca se imprime ni pasa por argumentos de proceso.
- Saldo antes del trabajo: `0.0149 ETH`; saldo final observado: `0.0145289065 ETH`.
- Coste del deploy completo: `0.00025540606 ETH` a `0.01 gwei`.
- El runner exige dinámicamente `max(0.005 ETH, gas estimado × gas price × 4)`; no hace falta más
  ETH para operar el deployment actual.
- FundRegistry: `0x696553ad390428abf3d95c90a3452917cbaa453c`.
- tUSDG: `0x336c508083e2afe17c594a8ef5b8542efcf672d5`.
- Fund canario: `0xc0FC8Edb22Dd98d1bdA19E92E34282c56c75616e`.
- Smoke público: stake, depósito LP, keeper, buy/sell, blacklist, pausa, beacon drift y Ponder verdes.
- Output íntegro y todas las CAs: `outputs/2026-07-21-testnet-public.md`.

## Servicios testnet vigentes

- Frontend: `http://127.0.0.1:5174/?front=robinfund`.
- GraphQL: `http://127.0.0.1:42070/graphql`.
- Ready: `http://127.0.0.1:42070/ready`.
- Keeper: tick cada 60 segundos.
- Ponder: PGlite persistente en `packages/indexer/.ponder/testnet-public`.
- Browser flow: landing, Explore Funds y detalle del canary verdes; cero errores de consola.
- Pendientes por reloj público: settlement 7 días, retiro 1 hora y ownership Guardian 2 días.

## TestBots público

- Fund: `0xA7588F9662DACEA303D763C6b8295F33B6fbc46d`.
- Tres bots depositaron `2,000 tUSDG` cada uno y retiraron todo en cash.
- Cuatro trades realizaron un beneficio controlado de `300 tUSDG`.
- Entry fee: `120 tUSDG`; performance fee distribuida: `62.399999 tUSDG`.
- Fee total manager: `116.159999 tUSDG`; fee total protocolo: `30.24 tUSDG`.
- Estado final: `Closed`, supply `0`, cuatro trades y tres posiciones cerradas en Ponder.
- Evidencia completa: `outputs/2026-07-21-testbots-public.md`.

## Entry fee dinámica pública

- Fund: `0xec3a6902b3fDba7dEEF8139F16967dA6429CE282`.
- Curva configurada: `0% → 5%`; stake `1,000 tUSDG`; cap `10,000 tUSDG`.
- Tres depósitos FIFO de `2,000 tUSDG`: tasas `0.50%`, `1.49%` y `2.48%`.
- Fees totales: `89.4 tUSDG`; manager `44.7`; protocolo `17.88`; Fund `26.82`.
- Estado final: `Active`, balance `5,937.42 tUSDG`, tres LPs reconstruidos por Ponder.
- Evidencia completa: `outputs/2026-07-21-dynamic-entry-public.md`.

## Hardenings aplicados al harness

- `forge` deja de recibir la private key como argumento de proceso;
- el `.env` solo carga en el runner la allowlist de variables de deploy;
- el RPC público se pasa a Foundry por el alias `robinhood_testnet`, no como URL con API key;
- ningún output imprime la URL privada del RPC;
- `DEPLOYER_PK` se lee desde el entorno dentro de los scripts Solidity;
- broadcast `--slow` para confirmar cada transacción antes de enviar la siguiente;
- `--non-interactive` para impedir prompts invisibles;
- logs incrementales de stdout/stderr;
- timeout del proceso controlado por `FORGE_SCRIPT_TIMEOUT_MS`.

## Devnet vigente

- RPC: `http://127.0.0.1:8545` (chain ID local 31337, estado forkeado de 4663)
- GraphQL: `http://127.0.0.1:42069/graphql`
- Creator API: `http://127.0.0.1:8788`
- Frontend: `http://localhost:5173`
- Open gate verificado: 188 bytes, wallet arbitraria elegible
- Fondo demo indexado: 8,000 USDG de depósitos lifetime
- Revalidación final: RPC chain ID 31337 y HTTP 200 en GraphQL, Creator API y frontend

Direcciones y outputs completos: `outputs/2026-07-21-devnet-restart.md`.

## Bloqueadores mainnet que no se omiten

- residual reclamable cuando un Stock Token bloqueado falla durante un retiro in-kind;
- auditoría externa y pre-audit estático;
- multisig/timelock y ownership final;
- operación redundante 24/7 y plan de incidentes;
- opinión legal sobre la distribución permissionless de Stock Tokens.

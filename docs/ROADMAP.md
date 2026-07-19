# RobinFund — Roadmap de build paso a paso

> Complementa a [SPEC.md](SPEC.md) (mecanismo v0.3) y [REVIEW.md](REVIEW.md) (revisión adversarial).
> Orden de ejecución real: cada fase depende de la anterior salvo donde se indica. Duraciones estimadas para 1–2 personas a tiempo completo.

---

## Fase 0 — Fundaciones y verificaciones (≈ 1 semana, en paralelo con Fase 1)

- **0.1 Monorepo**: pnpm workspaces + estructura `packages/contracts` (Foundry), `packages/sdk` (TS/viem), `packages/keeper`, `apps/web` (Next.js), `apps/indexer` (Ponder), `docs/`. CI con GitHub Actions (forge test + lint + typecheck).
- **0.2 Toolchain local**: Foundry (forge/cast/anvil), Node 22 + pnpm, Slither/Aderyn para análisis estático.
- **0.3 Acceso a la chain**: RPC testnet `rpc.testnet.chain.robinhood.com` (chain 46630) y mainnet 4663 vía Alchemy/QuickNode; ETH de testnet para gas; localizar los Stock Tokens de testnet (docs.robinhood.com/chain/contracts) y sus feeds; explorer Blockscout.
- **0.4 Verificaciones pendientes de la spec (§15)** — ✅ **COMPLETADAS 2026-07-19** (fork tests 6/6 PASS, ver changelog v0.8 de SPEC.md):
  - 0.4.1 ✅ USDG = 6 dec confirmado on-chain; feed USDG/USD **existe** (`0x61B7...9aD2`).
  - 0.4.2 ✅ `isBlocked(address)` verificado en vivo; puntero real = `ACCESS_CONTROLLED_REGISTRY()`; `oraclePaused()`/`tokenPaused()` viven en el token.
  - 0.4.3 ✅ Heartbeat real = 86400s, deviation 0.5%, 24/5 (staleness de finde ~34h observado en vivo) ⇒ `maxStaleness = 86400s + margen`.
  - 0.4.4 ✅ **NO existe** sequencer uptime feed en la chain — guarda sustituida por forward pricing (SPEC §5.2.3).
  - 0.4.5 ✅ Hecho en fork de mainnet (mejor que testnet): custodia de TSLA real por contrato propio + swap real ejecutado contra **Uniswap v4** (la liquidez vive en v4; el pool v3 está vacío ⇒ el adapter de Fase 1 opera el PoolManager directamente — embrión ya escrito en `test/fork/SmokeOracleSwap.t.sol`). 0x queda para testnet/mainnet (RFQ necesita makers vivos).
  - ⚠ Hallazgo extra: tokens impostores en la chain (NVDA/USDG falsos) — direcciones solo del `AddressBook`.
- **0.5 Cuentas y servicios a dar de alta**: GitHub org · Alchemy o QuickNode (RPC) · Privy (embedded wallets) · WalletConnect Cloud (project ID) · dominio + Vercel · cuenta X del proyecto · Telegram/Discord.

**Entregable**: repo compilando, wallet de testnet con Stock Tokens de prueba movidos por contrato propio, tabla de feeds calibrada.

---

## Fase 1 — Contratos core en testnet (≈ 3–4 semanas)

Orden interno por dependencias:

- **1.1 `NAVLib` + `TokenRegistry`**: valoración WAD (§5.1), validez completa (§5.2: blocked/pausa/sequencer+gracia/staleness/dust), listado con calibración de heartbeat.
- **1.2 Periféricos de custodia**: `FundShare` (ERC-20 no transferible), `QueueEscrow` (separado), `StakeEscrow` (timelocks, suspensión Frozen), `CompensationReserve` (claims pull por período).
- **1.3 `Fund` — el núcleo** (el 60% del trabajo):
  - 1.3.1 Colas de depósito/retiro: forward pricing estricto, latencia mínima, blackout pre-settlement, paginación, mínimos y caps (§5.3).
  - 1.3.2 Secuencia canónica de batch: settlement → depósitos FIFO (fee corriente, fill parcial al cap, skip+refund por atestación) → retiros FIFO con netting (§5.4).
  - 1.3.3 Liquidación de retiros cash: precio fijado, proceeds reales al que sale, invariante de sharePrice (§5.6); retiro in-kind sin NAV.
  - 1.3.4 First-loss: basis por LP con roll-forward perezoso, agregado `B`, settlement con `grossClaims`/λ/funding, claims (§6).
  - 1.3.5 Fees: entry fee en curva con AUM corriente, HWM ajustado por aportes, cristalización con variables de §7.2.
  - 1.3.6 Estados: Winding (settlement ad-hoc en la transición), Closed (claims fijados, liberación de stake), Frozen (§10.3).
- **1.4 Trading**: `AdapterRegistry` + `UniswapV3Adapter` + `ZeroExAdapter` con medición de deltas, guardarraíl por trade, doble presupuesto de slippage, freeze pre-settlement, vigilancia de beacon (§8).
- **1.5 Gobernanza y compliance**: `EligibilityGate` (EIP-712, revocación, redención forzosa), `FeeSplitter`, `Guardian` (pausas sin retiros, depeg breaker), `FundFactory` (clones, params inmutables).
- **1.6 Testing en serio**:
  - 1.6.1 Unit tests por contrato.
  - 1.6.2 **Un test por cada uno de los 21 ataques de §14** — la suite de regresión del mecanismo.
  - 1.6.3 Invariant/fuzz testing (Foundry): sharePrice de los que quedan nunca baja por salidas, Σ claims ≤ funding, unidades WAD, conservación de USDG.
  - 1.6.4 Fork tests contra testnet real: Stock Tokens reales, feeds reales, Uniswap real.
- **1.7 Deploy a testnet 46630 + E2E manual**: crear fondo → depositar → tradear → settlement con pérdida (verificar claims) → settlement con ganancia (verificar perf fee) → winding → cierre.

**Entregable**: protocolo completo funcionando en testnet con suite de tests verde.

---

## Fase 2 — Indexer, keeper y servicios (≈ 2 semanas, arranca con 1.7)

- **2.1 Indexer** (Ponder sobre 46630/4663): eventos de todos los contratos → sharePrice histórico, track records por manager, slashes, settlements degradados, redenciones forzosas. API GraphQL/REST para el frontend.
- **2.2 Keeper bots** (TS + viem, los del protocolo — todo es permissionless igualmente):
  - 2.2.1 Ejecutor de batches y settlements (con cálculo off-chain de `grossClaims` desde eventos + publicación).
  - 2.2.2 Liquidador de retiros (routing Uniswap/0x con guardas).
  - 2.2.3 Monitores: beacon implementations, `isBlocked` por fondo, `UIMultiplierUpdated`, pausas de feeds → alertas + auto-suspensiones.
  - 2.2.4 Redenciones forzosas de compliance vencidas.
- **2.3 Compliance signer service**: verificación geo + atestación del usuario → firma EIP-712 con TTL; lista de jurisdicciones RHJ; revocación. (Evaluar proveedor externo tipo zk-KYC como upgrade.)

**Entregable**: testnet operando sola end-to-end sin intervención manual.

---

## Fase 3 — Frontend y capa social (≈ 3–4 semanas, arranca en paralelo con Fase 2)

- **3.1 Base**: Next.js + wagmi/viem + Privy (login email/social/X, sin seed phrase) + PWA instalable + WalletConnect (alcanza a Robinhood Wallet vía su browser de dapps por URL directa).
- **3.2 Flujos de LP**: explorar fondos (filtros por cobertura stake/AUM, track record, slashes), depósito con fee efectiva visible y explicación de forward pricing ("tu orden ejecuta en la próxima ventana válida ~lunes 13:30 UTC"), retiro cash/in-kind, claims de first-loss.
- **3.3 Lado manager**: creación de fondo (wizard con params + stake), terminal de trading (quotes Uniswap/0x, presupuesto de slippage visible), gestión de stake y cap.
- **3.4 Capa social**: chat token-gated por fondo (SIWE + `minAccessShares`), feed del manager, posiciones en tiempo real para LPs / delay 24h público, leaderboards, perfiles ligados a X.
- **3.5 Compliance UX**: geo-block, flujo de atestación, disclosures del riesgo emisor por fondo (§10.3).

**Entregable**: producto completo usable en testnet — la demo que se enseña.

---

## Fase 4 — Auditoría, legal y mainnet (≈ 4–8 semanas, mucho es espera externa)

- **4.1 Pre-auditoría**: freeze de alcance, Slither/Aderyn limpio, documentación de invariantes, deploy scripts reproducibles.
- **4.2 Auditoría externa** (presupuestar $30–80k según firma; alternativa/complemento: competition en Code4rena/Sherlock/Cantina). Aplicar fixes + re-review.
- **4.3 Opinión legal** (en paralelo con 4.2): estructura de entidad (dónde incorporar), análisis AIFMD sub-umbral / MiFID II del vehículo y del copy-trading, el dial de las fees, T&Cs y disclosures. Presupuestar $10–30k.
- **4.4 Grants y ecosistema** (en paralelo, desde ya): escribir a chain-developers-group@robinhood.com, aplicar al Arbitrum Open House 2026 ($1M comprometido) y Buildathons/Founder Houses, solicitar listing en robinhood.com/chain/ecosystem.
- **4.5 Mainnet**: deploy a 4663 con multisig + timelock reales, bug bounty (Immunefi), caps conservadores de lanzamiento (`aumCap` global bajo las primeras semanas), monitoreo 24/7.

**Entregable**: protocolo auditado vivo en mainnet con estructura legal definida.

---

## Fase 5 — Lanzamiento y crecimiento (continuo)

- **5.1 Cohort fundador de managers**: 5–10 traders con audiencia en X, onboarding blanco-guante, stakes subsidiados si hace falta.
- **5.2 Incentivos**: sistema de puntos por depósitos/permanencia/PnL de managers (sin promesa explícita de token), campañas con la comunidad de la chain.
- **5.3 v2 técnico**: trust-minimización de `grossClaims` (challenge window o prueba), colateral en Morpho, cestas/índices, shares transferibles con gating, keeper descentralizado.
- **5.4 v2 producto**: evaluar keys con fee-share (si legal lo permite), mercados secundarios, agentes (el MCP de trading agéntico de la chain).

---

## Qué necesitamos — checklist transversal

| Categoría | Ítem | Para cuándo |
|---|---|---|
| Infra | RPC dedicado (Alchemy/QuickNode), 2 keys (testnet/mainnet) | Fase 0 |
| Infra | Hosting: Vercel (web) + VPS/Railway (keeper, indexer, signer) | Fase 2 |
| Servicios | Privy, WalletConnect Cloud, dominio, servicio geo-IP | Fases 0–3 |
| Fondos | ETH testnet (gratis) · ETH mainnet para deploys (~$200–500) · USDG para fondos semilla y pruebas | Fases 0/4/5 |
| Fondos | Auditoría $30–80k · legal $10–30k · bug bounty (escrow) | Fase 4 |
| Seguridad | Multisig 2/3 mínimo (Guardian), hardware wallets, plan de incident response | Fase 4 |
| Legal | Jurisdicción de la entidad, T&Cs, opinión AIFMD/MiFID II | Fase 4 |
| Distribución | Cuenta X activa desde ya, contacto Robinhood dev-relations, aplicaciones a grants | desde Fase 0 |
| Personas | Mínimo viable: 1 dev Solidity + 1 dev full-stack (pueden ser la misma persona con más calendario); diseño UI puntual | — |

**Camino crítico**: 1.3 (Fund) → 1.6 (tests) → 4.2 (auditoría) → 4.5 (mainnet). Todo lo demás se paraleliza alrededor. Estimación total honesta hasta mainnet: **3–4.5 meses** con dedicación completa, dominado por la auditoría y lo legal, no por el código.

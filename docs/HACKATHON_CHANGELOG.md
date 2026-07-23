# Nuvem Agents — changelog de continuidad

Última actualización: 2026-07-22 (Europe/Lisbon).

## Línea base declarada

El tag anotado `pre-lisbon-2026` apunta al commit
`6846e4ade51fb5dcf9d31be4e2fcb863cbf58cd0`. Esa referencia contiene el protocolo NuvemFund
preexistente: fondos evergreen, NAV, first-loss, colas, fees, trading, keeper, Ponder, frontend,
Supabase social y herramientas de deploy/testnet.

```bash
git rev-parse 'pre-lisbon-2026^{}'
# 6846e4ade51fb5dcf9d31be4e2fcb863cbf58cd0
```

La feature Agents se mantiene separable de esa línea base. Una submission debe usar el track de
continuidad correcto, declarar por escrito el trabajo previo y describir con precisión qué parte fue
realizada dentro de la ventana válida. Las [reglas actuales de ETHGlobal](https://ethglobal.com/rules)
exigen esa divulgación y funcionalidad nueva sustancial; este archivo documenta diferencias técnicas,
pero no sustituye la declaración oficial ni afirma por sí mismo cuándo se escribió cada cambio.

## Superficie añadida después de la línea base

| Área | Cambio nuevo |
|---|---|
| Contratos | `AgentRegistry`, `AgentVaultController`, `UniswapApiAdapter`, scripts y tests adversariales |
| Identidad | Action World ID 4.0 propia de Nuvem + AgentBook; backing ligado a ambas evidencias, sponsor, signer, chain, registry, nonce y caducidad |
| BYOA | SDK TypeScript, CLI y cliente Python; clave local y conexiones solo salientes |
| Control plane | Gateway Hono, SIWE sponsor, sesiones AgentKit, OpenAPI, SSE e idempotencia |
| Ejecución | Quote CLASSIC, typed data EIP-712, worker durable, simulación, broadcast y receipts |
| Creación | Worker durable de tres transacciones con reserva serializada de nonces y reanudación |
| Datos | Esquema Supabase `agent_private`, RLS pública, subgraph y MCP read-only con frescura |
| Agente demo | Runtime `ToolLoopAgent`, dry-run por defecto, misma API pública que BYOA |
| Frontend | Selector Human/AI, política, external/reference agent, backing, deploy y dashboard |
| Managed onboarding | Signer aislado por vault, QR/deep link AgentBook y fallback CLI sin seed para el sponsor |
| World privacy | Proof opaco transitorio, solo HMACs/hashes privados, RP request single-use y límite atómico de tres agentes Nuvem por humano |
| Operación | E2E local de 10 actos, runbook, arquitectura, demo y outputs reproducibles |

`Fund.sol` no fue modificado para Agents. Cada AI vault usa un controller separado como `MANAGER`
inmutable, manteniendo el protocolo económico preexistente aislado de la lógica agentic.

## Estado verificable

| Capa | Estado actual |
|---|---|
| Contratos Agents | Implementados; unit tests, tamaños EIP-170 y E2E local verdes |
| BYOA | SDK/CLI/Python implementados; signer nunca se entrega al gateway |
| Gateway/worker | Implementados y cubiertos por tests de concurrencia, replay y recuperación |
| Supabase | Migraciones aplicadas al proyecto NuvemFund; RLS e integración SIWE verificadas |
| Frontend | Wizard/dashboard implementados; build/tests y visual desktop/mobile verdes |
| World Nuvem | App/RP/action de producción activas; IDKit 4.2.1, gateway y Postgres implementados; falta el primer scan humano real |
| World canonical | Integración y validadores AgentBook implementados; falta E2E público con registro real |
| The Graph | Subgraph compila; falta deployment público y `GRAPH_DEPLOYMENT_ID` real |
| Uniswap Trading API | Integración fail-closed implementada; falta API key y trade canario real |
| Robinhood 46630 | Protocolo humano/asset pack ya público; contratos Agents aún no desplegados allí |
| Robinhood 4663 | Fork probado; no hay deployment público Agents ni autorización de capital público |

## Límites honestos de la demo

- El E2E local usa estado forkeado de Robinhood 4663, pero chain ID local `31337`.
- El proxy local de swap es un stand-in explícito; el bytecode de `UniswapApiAdapter` es el de
  producción y verifica el mismo selector/campos externos.
- El backing World local es no canónico y se etiqueta como tal. El lookup canónico está cubierto por
  tests del gateway, no por una prueba pública.
- Ponder alimenta la UI local; el subgraph The Graph todavía no está desplegado.
- Mainnet con capital público sigue bloqueada por auditoría externa, operación, issuer y revisión
  legal. Los resultados locales no equivalen a una auditoría.

La evidencia ejecutable y todas las direcciones efímeras están en
[`packages/deploy/outputs/2026-07-22-nuvem-agents-local.md`](../packages/deploy/outputs/2026-07-22-nuvem-agents-local.md).

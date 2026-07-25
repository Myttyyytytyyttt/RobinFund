# Nuvem Agent Gateway

Backend model-neutral para agentes externos y el agente de referencia. Autentica AgentKit/SIWE,
exige datos Graph frescos, obtiene planes CLASSIC de Uniswap, verifica intenciones EIP-712 y las
entrega a workers durables. Una sesión nunca autoriza fondos por sí sola.

## Procesos

```powershell
pnpm build
pnpm start          # HTTP, OpenAPI, SSE y MCP
pnpm worker         # intents: simulate -> broadcast -> receipt
pnpm worker:vaults  # controller -> Fund -> register; espera bind/stake sponsor
pnpm generate:vault-artifacts # después de cambiar los contratos de deployment
```

El HTTP gateway puede desplegarse como Vercel Function mediante `api/[...route].ts`; su base
pública será `https://<proyecto>.vercel.app` (los rewrites internos apuntan a `/api`). Los loops
`worker` y `worker:vaults` siguen siendo la opción para un VPS/container. En Vercel, el vault usa
en su lugar una transición durable y finita por request; nunca se inicia un loop dentro de la
Function.

`GRAPH_ENABLED` y `TRADING_ENABLED` son controles separados. Con Graph activo y trading apagado,
contexto, estado y MCP siguen disponibles en modo read-only, mientras quotes/intents devuelven
`503`. Trading exige Graph activo: no existe un modo que permita ejecutar con inteligencia stale o
sin procedencia.

En desarrollo, los procesos cargan el `.env` gitignored de la raíz sin sobrescribir variables ya
inyectadas por el entorno. Producción debe usar el secret manager del runtime.

## API v1

| Ruta | Auth |
|---|---|
| `GET /readyz` | pública; valida deployment/cadena/frescura Graph |
| `GET /v1/graph/status` | pública; procedencia Graph sanitizada |
| `POST /v1/agent-sessions/challenge` | pública, idempotente |
| `POST /v1/agent-sessions` | header AgentKit |
| `GET /v1/agents/:id/context` | sesión agente |
| `POST /v1/agents/:id/quotes` | sesión agente |
| `POST /v1/intents` | sesión + firma EIP-712 |
| `GET /v1/intents/:id` | agente o sponsor |
| `GET /v1/agents/:id/events` | sesión, SSE con cursor |
| `POST /v1/agents/:id/heartbeat` | sesión agente |
| `POST /v1/agents/:id/decisions` | sesión agente; solo resumen sanitizado |
| `POST /v1/managed-signers` | sponsor SIWE; identidad Nuvem sin devolver clave |
| `POST /v1/agent-vaults` | sponsor SIWE |
| `GET /v1/agent-vaults/:id` | sponsor SIWE |
| `POST /v1/agent-vaults/:id/process` | sponsor SIWE, idempotente; avanza como máximo una transición global |
| `POST /v1/agents/:id/world-id/request` | sponsor SIWE; request RP de la app Nuvem |
| `POST /v1/agents/:id/world-id/verify` | sponsor SIWE; verifica Identity Check 4.0; el PoH legado queda solo por compatibilidad y no habilita vaults AI |
| `GET /v1/agents/:id/world-registration` | sponsor SIWE; nonce/estado AgentBook |
| `POST /v1/agents/:id/world-registration` | sponsor SIWE; relay del proof oficial |
| `POST /v1/agents/:id/world-backing` | sponsor SIWE |
| `POST /v1/agents/:id/sync` | sponsor SIWE |
| `POST /v1/agents/:id/pause` | sponsor SIWE |
| `/mcp` | MCP remoto read-only |

OpenAPI: `GET /openapi.json`. Health: `GET /healthz`. Toda mutación requiere
`Idempotency-Key` de 8–128 caracteres.

## Variables backend

La plantilla completa está en [`.env.example`](../../.env.example). Grupos:

- control plane: `DATABASE_URL`, Supabase URL/publishable key, session secret;
- chain: `RH_RPC_URL` + `RH_CHAIN_ID`, AgentRegistry, USDG y confirmaciones;
- World: app/RP/action Nuvem, RP signing key, RPC/relay AgentBook, pepper y verifier key dedicada;
- signer Nuvem: `MANAGED_SIGNER_SECRET` solo para dev/canario; KMS/HSM no exportable en producción;
- Graph: `GRAPH_URL`, deployment ID inmutable, RPC/cadena esperada, lag/edad/timeout;
- Uniswap: API key, base URL, approval proxy verificado contra `swap.to` y Universal Router oficial de la chain;
- relay: relayer key dedicada;
- vault worker: operator key, registries, adapter, NAVLib y asset allowlist.

Nunca usar una misma hot key para verifier, relayer y deploy operator. Ninguna de ellas se expone con
prefijo `VITE_` ni se devuelve por API.

## Vault worker request-driven

`createLazyVaultDeploymentService(store, chain)` no lee la configuración ni construye el signer al
arrancar el gateway. La primera llamada a `processNextEligible()` valida las variables del worker,
crea el transport y ejecuta un solo `VaultDeploymentWorker.runOnce()`. Requests concurrentes del
mismo isolate comparten esa ejecución; los claims de Postgres serializan isolates distintos.

`createServices` devuelve esta dependencia como `vaultDeployment` y `bootstrap.ts` la entrega al
gateway mediante `...services`. La ruta `POST /v1/agent-vaults/:id/process` autentica el bearer
SIWE, comprueba que el job pertenece al sponsor y valida que Identity Check, AgentBook y el backing
on-chain sigan activos. La mutación usa el scope idempotente
`vault-process:${sponsor}:${jobId}`; después del tick vuelve a cargar el job objetivo y responde
`{ job, processed }`. `processed` solo es `true` si el tick avanzó ese job exacto.

El tick reclama el siguiente job globalmente elegible, no necesariamente el id de la URL. Esta
propiedad conserva el orden de cualquier rango de nonces ya reservado; no debe sustituirse por un
claim «por id». Un advisory lock serializa claims entre isolates y el lease del job impide que otro
request salte al siguiente antes de reservar el primer rango. Un claim ocupado es un resultado
normal con `claimed: 0`; `attempts` cuenta fallos del worker, no polls de receipt/confirmaciones. Los
fallos permanentes de configuración usan `503 VAULT_WORKER_NOT_CONFIGURED` sin revelar nombres o
valores de secretos; `VAULT_WORKER_UNAVAILABLE` queda reservado para fallos transitorios.

El frontend llama este POST después de cada estado pendiente y luego continúa el GET normal. Cada
tick usa una `Idempotency-Key` nueva; un replay de la misma key no ejecuta una segunda transición.
Mantener `maxDuration: 60` mientras el claim se considere stale a los dos minutos. Si se amplía la
duración, primero hay que extender/renovar ese lease para impedir dos procesadores simultáneos.

Los artefactos mínimos de `AgentVaultController` y `Fund` están versionados en
`src/generated/vault-artifacts.ts`; un build limpio de Vercel no depende de `packages/contracts/out`.
Tras modificar esos contratos:

```powershell
forge build --root packages/contracts
pnpm generate:vault-artifacts
pnpm check:vault-artifacts
```

El generador conserva ABI, creation bytecode y referencias de link solamente. El worker enlaza
`NAVLib` tanto en el controller como en el Fund y rechaza cualquier placeholder o librería
desconocida antes de estimar gas.

## Garantías operativas

- Challenge/nonce AgentKit persistido y no reutilizable.
- La action propia `sponsor-ai-vault` exige Identity Check 4.0 con pasaporte + edad mínima 18,
  liga signal a sponsor + signer + agentId y solo persiste HMACs/hashes. El flujo PoH/Orb legado
  no puede satisfacer el backing de un vault AI. El RP signing key nunca llega al browser.
- Un sponsor World ya verificado puede vincular otros agentes desde la misma wallet sin otro scan;
  el límite de Nuvem-managed agents se serializa por hash humano.
- El registro AgentBook fija contrato, World Chain, app/action oficial y nonce actual; nunca devuelve
  el human ID al browser.
- El backing on-chain combina la evidencia Nuvem World ID y la evidencia AgentBook; ninguna basta sola.
- Sesión opaca revocable de 15 minutos; rotar/pausar revoca sesiones.
- Graph con deployment/cadena incorrectos, indexing errors, >50 bloques o >5 minutos stale:
  contexto, MCP y quote se rechazan.
- Quote no CLASSIC, Permit2, target/from/chain/value inesperados: rechazada.
- El calldata del proxy se decodifica y liga al Universal Router, token de entrada, amount y un deadline no menor que el firmado. Token de salida/recipient quedan ligados por quote + delta real del Fund + minOut.
- Quote e intención se persisten antes de relay; workers concurrentes usan claims atómicos.
- Caída después de broadcast recupera receipt por hash y no emite otra transacción.
- Creación reserva nonces serializados y persiste las tres raw tx antes de emitir la primera.

## Verificación

```powershell
pnpm typecheck
pnpm test
```

`pnpm check:vault-artifacts` se ejecuta después de `forge build`. Cada build de aplicación ejecuta
además `check:vault-artifact-sources`, que compara el fingerprint de Solidity/configuración sin
necesitar Foundry ni `packages/contracts/out`; un cambio de contratos con artefactos stale falla el
build limpio.

Los tests usan dependencias inyectadas y cubren replay RP, signal equivocado, rechazo World,
reutilización segura, cuota, AgentBook, sesiones, binding Uniswap, idempotencia, dos workers,
crash/restart y jobs de creación. El smoke Postgres real se activa con `SUPABASE_E2E=1`. La evidencia multi-capa está en
[`packages/deploy/outputs/2026-07-22-nuvem-agents-local.md`](../../packages/deploy/outputs/2026-07-22-nuvem-agents-local.md).

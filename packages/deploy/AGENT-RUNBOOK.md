# Runbook — Nuvem Agents

Este documento promueve exactamente la misma feature desde devnet hasta un canario público. No
autoriza mainnet con capital público.

## 0. Reglas de promoción

- Anotar commit/tag y guardar un output Markdown por entorno.
- No copiar CAs de devnet: chain 31337 es efímera.
- Verificar bytecode, chain ID, owners, adapter ID, World verifier y start blocks.
- Nunca imprimir private keys, RPC autenticados, database URLs o API keys.
- Mantener verifier, relayer y deploy operator en cuentas separadas.
- Si World, Graph o Uniswap no están realmente conectados, mostrar el modo degradado y no una badge
  de integración live.

## 1. Devnet reproducible

```powershell
cd C:\Users\Kw\Desktop\RobinFund\packages\devnet
pnpm devnet
```

Esperar:

```text
DEVNET VIVO
RPC          http://127.0.0.1:8545 (31337)
GraphQL      http://127.0.0.1:42069/graphql
Creator API  http://127.0.0.1:8788
```

Luego:

```powershell
pnpm test:agent-e2e
```

Debe terminar con `21 checks passed; 0 failed`. El swap usa un proxy local explícito y el adapter de
producción; World se etiqueta `local non-canonical`.

## 2. Build y tests de gate

```powershell
cd packages/contracts
forge test --match-path "test/unit/agents/*"
forge build --sizes

cd ../../apps/agent-gateway
pnpm typecheck
pnpm test

cd ../../packages/managed-signer
pnpm build
pnpm test

cd ../../packages/agent-sdk
pnpm typecheck
pnpm test
pnpm build

cd ../subgraph
pnpm codegen
pnpm build

cd ../../website
pnpm build
pnpm test
```

No promover si `Fund` supera 24,576 bytes, si cambia el hash EIP-712 o si gateway/SDK/adapter no
rechazan el mismo calldata alterado.

## 3. Supabase

Aplicar en orden:

```text
20260722003000_nuvem_agents_control_plane.sql
20260722013000_nuvem_agents_fk_indexes.sql
20260722023000_agent_vault_deployment_worker.sql
20260722024500_serialize_vault_nonce_ranges.sql
20260722043635_managed_signer_world_onboarding.sql
20260722061000_world_id_v4_sponsor_gate.sql
20260722062000_world_id_v4_fk_indexes.sql
```

Comprobar:

- RLS activa en `agent_profiles` y `agent_decisions`;
- tablas `agent_private` inaccesibles al navegador;
- audit log append-only;
- índices de foreign keys presentes;
- dos workers no reclaman el mismo intent/job/nonce range.
- `agent_private.managed_signers` no contiene material de clave;
- `world_id_requests`, `world_id_sponsors` y `world_id_agent_bindings` contienen solo hashes/HMACs,
  nunca proof, nullifier o identificador humano en claro;
- requests RP consumidas no pueden reutilizarse y un sponsor verificado puede ligar agentes futuros
  sin otro scan, respetando la cuota;
- `anon`/`authenticated` no tienen grants sobre ninguna tabla `agent_private`.

El navegador recibe solo URL + publishable key. `DATABASE_URL` permanece backend-only.

## 4. Contratos Agents

Variables no secretas requeridas por `DeployAgents.s.sol`:

- AgentRegistry verifier address;
- AdapterRegistry owner/operator;
- approval proxy esperado;
- Universal Router oficial esperado;
- adapter ID resultante y bloque de deploy.

Broadcast con una key dedicada desde `.env`/secret manager, nunca en argumentos de proceso:

```powershell
cd packages/contracts
forge script script/DeployAgents.s.sol --rpc-url <alias> --broadcast --slow --non-interactive
```

Verificar on-chain:

- `AgentRegistry.WORLD_VERIFIER()` coincide con la cuenta prevista;
- `UniswapApiAdapter.APPROVAL_PROXY()` coincide con el `swap.to` observado en el probe;
- `UniswapApiAdapter.UNIVERSAL_ROUTER()` coincide con el router oficial de la chain;
- AdapterRegistry resuelve el ID al bytecode correcto;
- controller y adapter bajo EIP-170;
- ownership final y fondos del relayer mínimos.

### Nuvem World ID 4.0

Configuración pública fijada en gateway y frontend:

```text
App ID: app_5fe197d24d83c55573c5d9d0356f3d6e
RP ID: rp_db7d77ff9edef255
Action: sponsor-ai-vault
Protocol: World ID 4.0 + verified legacy Orb fallback
Credential: proof_of_human / orb only
```

Secretos backend-only: `WORLD_RP_SIGNING_KEY`, `WORLD_ID_PEPPER` y la API administrativa del
Developer Portal. Nunca usar prefijo `VITE_`. El gateway debe verificar nonce, action, signal,
environment y respuesta del Portal antes de consumir el request. El signal liga chain + agentId +
sponsor + signer. La action propia identifica al sponsor; no sustituye AgentBook.

Pruebas según el tipo de usuario:

- un LP normal no necesita World y puede probar depósitos/retiros permissionless ahora;
- el Simulator con `environment=staging` sirve para ensayar IDKit y el backend, pero no demuestra
  AgentBook canónico ni una verificación real en el dashboard de producción;
- el E2E canónico necesita que una persona con Proof of Human complete el scan desde su propio
  World App;
- no prestar ni compartir una cuenta World. Si el owner no tiene Orb, usar un tester/teammate
  verificado que actúe como sponsor de un vault demo con su propia wallet;
- `credential_unavailable` significa que la cuenta no dispone de la credencial solicitada; no es un
  error que el gateway pueda reparar.

### World AgentBook

Constantes canónicas fijadas en gateway y frontend:

```text
World Chain: eip155:480
AgentBook: 0xA23aB2712eA7BBa896930544C7d6636a96b944dA
App ID: app_a7c3e2b6b83927251a0db5345bd7146a
Action: agentbook-registration
Signal: abi.encode(agentSigner, currentAgentBookNonce)
```

Prueba manual completa:

1. Crear el AI vault hasta mostrar QR/deep link.
2. Confirmar primero `sponsor-ai-vault` de la app Nuvem y comprobar que el dashboard World aumenta.
3. Confirmar después el registro AgentBook oficial.
4. Verificar `lookupHuman(signer) != 0` sin imprimir el valor.
5. Confirmar que Supabase guarda solo hashes, que replay/signal alterado fallan y que un segundo
   agente de la misma wallet reutiliza el sponsor binding.
6. Confirmar que el cuarto Nuvem reference agent del mismo humano se rechaza.
7. Activar `AgentRegistry`: borrar/omitir cualquiera de las dos evidencias debe fallar.
8. Probar el comando CLI mostrado por el wizard como fallback AgentBook.

La API key del World Developer Portal permanece backend-only y administra la app Nuvem; no participa
en el proof oficial de AgentBook. Rotarla antes de la demo/publicación final porque la credencial de
desarrollo fue compartida durante el setup. Rotar también la RP signing key antes de producción si
ha salido del secret manager local.

## 5. The Graph

Robinhood Chain `robinhood` expone actualmente Firehose/Substreams, pero no debe asumirse que un
subgraph clásico de Studio esté soportado solo porque el identificador de red exista. El paquete
`packages/subgraph` conserva el modelo y sirve para graph-node propio; no es evidencia de un
deployment alojado.

Ruta pública aceptada:

1. crear un package Substreams que filtre AgentRegistry, FundRegistry, controllers y Funds;
2. ejecutarlo contra un endpoint Robinhood del proveedor de The Graph;
3. hundir los cambios en un sink durable con cursor/reorg handling;
4. exponer un endpoint consultable al Vault Intelligence MCP;
5. registrar deployment/package ID, bloque, timestamp y chain head en cada respuesta;
6. mantener `TRADING_ENABLED=false` mientras falte token, endpoint o el lag exceda 20 bloques/2 min.

El flujo siguiente queda solamente como alternativa self-hosted/compatible si el proveedor confirma
soporte de Subgraphs para el deployment objetivo:

```powershell
cd packages/subgraph
$env:AGENT_REGISTRY_ADDRESS = "0x..."
$env:FUND_REGISTRY_ADDRESS = "0x..."
$env:SUBGRAPH_START_BLOCK = "..."
pnpm build:robinhood
graph auth --studio <deploy-key>
graph deploy --studio <slug> --network robinhood
```

Guardar deployment ID y endpoint como secretos/config backend. Consultar `_meta` y rechazar trades
si el lag supera 20 bloques o dos minutos. No reutilizar un start block anterior al deployment real.

## 6. Gateway y workers

Arrancar como tres procesos independientes:

```powershell
cd apps/agent-gateway
pnpm build
pnpm start
pnpm worker
pnpm worker:vaults
```

Checks:

- `/healthz` 200 y `/openapi.json` 200;
- CORS limitado al dominio del frontend;
- sesión AgentKit caduca a 15 minutos;
- Graph deployment ID visible en context, nunca credenciales;
- relayer simula antes de transmitir;
- receipts alcanzan las confirmaciones configuradas;
- reiniciar cada proceso por separado conserva jobs/intents.

## 7. Uniswap gate

El gateway envía `x-permit2-disabled: true`, solicita `V2/V3/V4`, exige `CLASSIC` y fija Universal
Router `2.1.1`. Antes de testnet/mainnet:

1. Confirmar que la API devuelve swap con target proxy y `from=adapter`.
2. Decodificar `execute(address,address,uint256,bytes,bytes[],uint256)` como
   `(router, tokenIn, amountIn, commands, inputs, deadline)`; no interpretar los dos primeros campos
   como `tokenIn/tokenOut`.
3. Simular contra el bloque actual.
4. Ejecutar un canario mínimo y comprobar allowance/residuos cero.

La página general de Uniswap lista Robinhood 4663, pero la tabla actual de despliegues del proxy
no incluye Robinhood. El probe real del 2026-07-22 devolvió el proxy legado
`0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9`; tanto esa dirección como la CREATE2 canónica tenían
1,005 bytes y el mismo codehash en 4663. Fijar siempre el `swap.to` observado en un probe fresco,
desplegar el adapter contra esa dirección exacta y no permitir una lista dinámica de targets.

Variables backend/SDK que deben coincidir con el deployment:

```text
UNISWAP_APPROVAL_PROXY
UNISWAP_UNIVERSAL_ROUTER
NUVEM_APPROVAL_PROXY
NUVEM_UNIVERSAL_ROUTER
```

La ejecución de fork del 2026-07-22 quedó verde con el router
`0x8876789976decbfcbbbe364623c63652db8c0904`, `minOut` respetado, allowance final cero y sin residuos.
No promover basándose únicamente en ese resultado histórico: repetir el probe porque el target de la
API puede migrar. Mientras el proxy legado/canónico no esté decidido y documentado para el canario,
mantener `TRADING_ENABLED=false` en público.

## 8. Frontend

Config pública únicamente:

```text
VITE_AGENT_GATEWAY_URL
VITE_AGENT_REGISTRY_ADDRESS
VITE_UNISWAP_API_ADAPTER_ADDRESS
VITE_UNISWAP_API_ADAPTER_ID
VITE_UNISWAP_APPROVAL_PROXY
VITE_UNISWAP_UNIVERSAL_ROUTER
```

Después de cambiar `VITE_*`, hacer nuevo build/redeploy: Vite las incrusta en build time. Verificar
desktop y móvil, Human y AI, job resume, bind/stake, World activation, pause y rotate signer.

Las capturas locales de referencia están en `docs/assets/nuvem-agents-{wizard,policy}-{desktop,mobile}.png`.
La verificación visual no sustituye el E2E de wallet: en navegadores headless Privy puede no completar
su iframe, así que el gate de autenticación debe comprobarse también con los tests SIWE y una wallet
real antes de promoción.

## 9. Testnet 46630

El core/asset pack existente no implica que Agents esté desplegado. Publicar nuevas CAs de
AgentRegistry, adapter y cada controller/Fund. Ejecutar los diez actos de
[`docs/AGENT_DEMO_SCRIPT.md`](../../docs/AGENT_DEMO_SCRIPT.md) y guardar hashes públicos.

Si no hay Uniswap Trading API/ruta real en 46630, probar lifecycle/controller con el asset pack y
mantener el canario API sobre fork 4663. No etiquetar un venue mock como Uniswap.

## 10. Incidente y rollback

Orden de contención:

1. Sponsor `AgentRegistry.pause(agentId)`; invalida backing y sesiones.
2. Sponsor `controller.setPaused(true)`; freno local redundante.
3. Revocar/fondear de nuevo relayer, verifier u operator según el incidente.
4. Rotar agent signer; la clave vieja pasa a `PendingBacking` inmediatamente.
5. Si no se recupera, `requestWinding`; retiros LP permanecen disponibles.

No “rollbackear” una policy activa instantáneamente: proponer la segura y esperar 24 h. La pausa
cubre esa ventana.

## 11. Gate mainnet

Requiere además: auditoría externa de contratos/infra, multisig y ownership final, observabilidad y
on-call, prueba de issuer para direcciones contrato, revisión legal y canario con capital mínimo. El
lanzamiento permissionless con fondos públicos permanece bloqueado hasta cerrar todo el gate.

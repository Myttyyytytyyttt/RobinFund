# Output — Nuvem Agents en testnet pública

Fecha: 2026-07-22, Europe/Lisbon.

## Resultado

El control plane de Nuvem Agents está publicado, el frontend usa Robinhood Chain testnet 46630 y
el operador de despliegue de vaults está activo. Se desplegaron `AgentRegistry` y un adapter
compatible con `AgentVaultController` para probar el lifecycle sobre el `TestnetAssetPack`.

Este output no declara trading Uniswap ni The Graph live. `TRADING_ENABLED=false` permanece como
gate deliberado hasta disponer de datos Substreams/Firehose y de una ruta Uniswap real ejecutable.

## Servicios públicos

| Superficie | URL / resultado |
|---|---|
| Frontend | `https://www.nuvem.fund/?front=robinfund` |
| Frontend deployment | `dpl_D78LEBCSceZCRtzHBb62YEAbWxmn`, `Ready` |
| Agent gateway | `https://nuvem-agent-gateway.vercel.app` |
| Health | `/healthz` → HTTP 200 |
| OpenAPI | `/openapi.json` → HTTP 200 |
| MCP/trading | `/mcp` → HTTP 503 fail-closed |
| Worker de vaults | proceso testnet local activo; Supabase es la cola durable |

El bundle publicado contiene chain `46630`, `AgentRegistry`, tUSDG, las cinco acciones de prueba y
el adapter ID 1. Se comparó contra los secretos locales configurados y no se encontró ninguna
coincidencia. CORS permite `https://nuvem.fund` y no refleja orígenes arbitrarios.

## Contratos 46630

| Componente | Dirección |
|---|---|
| TokenRegistry | `0xb5355a8acf17b7a8fedb05600fe9c2d26a4e4dc7` |
| AdapterRegistry | `0xca3ed32482e64c62cc50c72a01493ea5b33a689e` |
| OpenEligibilityGate | `0xf0cc1f908203caf04852cbf11b8569a8a48949f2` |
| Guardian | `0x44952d28eca003b4cac2191f0ae73a993defbff7` |
| FundRegistry | `0x696553ad390428abf3d95c90a3452917cbaa453c` |
| NAVLib | `0x26c6c76d7f9c17c5290e09406a2446dcd4605bcd` |
| tUSDG | `0x336c508083e2afe17c594a8ef5b8542efcf672d5` |
| AgentRegistry | `0xA27E31af49cEA5113Fe84F69C2B91B999b48491B` |
| World verifier | `0x0b478805D5Ca6dC5d417Ff2035D5e87b58ab5D53` |
| TestnetLiquidityVenue | `0x2be64463e097e8b9e423edfa409493fc5d0c6bd3` |
| TestnetTradeAdapter AI | `0x375897F8a225021230FFFbdc308F192db049E4d2` |
| Adapter ID | `1` |

Verificación read-only contra RPC público: chain ID `46630`, `AgentRegistry.WORLD_VERIFIER()`
correcto, `AdapterRegistry.count() == 2` y `AdapterRegistry.get(1)` resuelve el adapter anterior.

### Transacciones principales

| Acción | Hash |
|---|---|
| Deploy AgentRegistry | `0x70852ae3e0969c751d19c904ec2d41a7d1bd8143ad1b791b0faf2e5b20ce2ca7` |
| Deploy venue sin valor | `0x06a11329120f5b682825891c372adfe98f20d5704a1f4ded3999ec4814f2374c` |
| Deploy adapter AI | `0x19b28ebb2388834c3354fb371e3b95fd5f9fe3f5cca4d63047d10c2669f2b3ee` |
| Registrar adapter ID 1 | `0xec825a3ea70400a62cba4690380b947dc331170bd9d974cd87f099af5e90e7e0` |

Los dieciséis hashes del asset setup están en
`packages/contracts/broadcast/DeployAgentTestnetAdapter.s.sol/46630/run-latest.json`.
Coste observado del nuevo venue + adapter + liquidez + registro: `0.00002030989 ETH`. Saldo del
operador después de la verificación: `0.01413233151 ETH`.

El venue anterior y el nuevo adapter son infraestructura determinista sin valor para 46630. No son
Uniswap y nunca deben presentarse como tal.

## World

Estado consultado y actualizado mediante el Developer Portal MCP oficial:

| Campo | Resultado |
|---|---|
| App | `Nuvem Fund` / `app_5fe197d24d83c55573c5d9d0356f3d6e` |
| RP | `rp_db7d77ff9edef255`, managed, production + staging registrados |
| RP signer | `0xE77b9bAB6c5e6e7c7C9EeaDD790D621009008073` |
| Action | `sponsor-ai-vault`, production, activa |
| Action ID | `action_v4_f37c535152f022506e54282fa09a843b` |
| Integration URL | `https://www.nuvem.fund/?front=robinfund` |
| Website | `https://www.nuvem.fund` |
| Logo | `website/public/favicon.png`, upload confirmado |
| Review/listing | no enviado |

La action Nuvem verifica al sponsor. El signer agente debe completar además el registro canónico
AgentBook. Esto aplica por igual a `Nuvem reference` y BYOA; los LPs siguen sin World ni KYC.

Falta una única evidencia no automatizable: una persona con World ID debe completar el QR real. No
se incrementará artificialmente el dashboard ni se sustituirá por un mock. La API key de Developer
Portal compartida durante setup debe rotarse antes de la demo pública.

## Supabase NuvemFund

- Proyecto `pseqckmlumujeatdnsty`, `ACTIVE_HEALTHY`, región `eu-west-1`.
- Todas las tablas Agents privadas tienen RLS.
- `agent_private.vault_jobs` está vacía antes del primer onboarding real.
- Una mutación idempotente contra el gateway público persistió su estado `failed/404` y se limpió
  después, demostrando que Vercel usa el pooler transaccional real.
- El worker arrancó con configuración válida: chain 46630, adapter 1, cinco assets, dos
  confirmaciones y sin errores de stderr.

## Verificación ejecutada

| Superficie | Resultado |
|---|---:|
| Gateway completo | 55 passed, 1 integración Postgres opt-in omitida |
| World + backing + AgentBook + worker focalizado | 19/19 |
| Gateway typecheck/config smoke | verde; 200/200/503/503 esperado |
| Website | 12 passed, 1 integración opt-in omitida |
| Website production build | verde |
| TestnetAssetPack focalizado | 9/9 |
| Solidity build/sizes | verde; Fund 24,267 B, 309 B de margen |
| Frontend HTTP/browser | 200; sin error overlay; un warning no bloqueante de Privy |
| Secret scan bundle público | 0 coincidencias |

## Gates abiertos

1. Completar en una wallet sponsor el QR Nuvem World ID y el QR AgentBook.
2. Desplegar el primer `AgentVaultController + Fund` mediante la cola ya activa y aportar stake.
3. Sustituir el scaffold de subgraph clásico por el camino soportado para Robinhood:
   Firehose/Substreams + sink consultable. Hace falta un `SUBSTREAMS_API_TOKEN` y endpoint del
   proveedor; `GRAPH_URL=unconfigured.invalid` continúa fail-closed.
4. El quote/ruta CLASSIC y la ejecución real ya pasaron sobre fork 4663. Antes del canario público,
   repetir el probe y fijar explícitamente tanto Approval Proxy como Universal Router. La API siguió
   devolviendo el proxy legado aunque la documentación marca la dirección CREATE2 como canónica;
   ambas direcciones tenían runtime idéntico en el bloque observado. El adapter ID 1 de este
   documento sigue siendo solo el venue determinista de testnet y no satisface ese gate.
5. Repetir E2E público, pausa, rotación, fee al sponsor y reinicio sin duplicar intención.

No se transmitió ninguna operación Uniswap a una red pública durante esta revalidación.

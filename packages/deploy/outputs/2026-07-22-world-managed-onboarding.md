# Output — World AgentBook + Nuvem managed onboarding

Fecha: 2026-07-22, Europe/Lisbon.

> Extensión posterior: el gate de producción ahora exige además la action propia World ID 4.0 de
> Nuvem antes de AgentBook. Ver `2026-07-22-world-id-v4-nuvem-app.md`. Este documento conserva la
> evidencia de la primera integración AgentBook/managed signer.

## Resultado implementado

- `Nuvem reference`: el sponsor no crea wallet ni recibe seed/private key. El gateway devuelve solo
  `agentId` y signer público, ambos aislados por sponsor + draft de vault.
- `External agent`: conserva signer local/BYOA y usa exactamente el mismo onboarding World.
- Wizard: SIWE → identidad → registro AgentRegistry → QR/deep link World App → relay AgentBook →
  backing on-chain → deploy/bind/stake.
- Fallback: el wizard muestra el comando oficial AgentKit CLI si el deep link no funciona.
- Privacidad: el human ID de AgentBook solo vive transitoriamente en memoria; Supabase guarda
  `HMAC(WORLD_ID_PEPPER, humanId)`.
- Sybil policy inicial: máximo tres `nuvem_reference` activos por hash humano, aplicado dentro de una
  transacción Postgres con advisory lock.
- LPs: sin World, KYC ni allowlist.

## Constantes oficiales fijadas

| Campo | Valor |
|---|---|
| World Chain | `eip155:480` |
| AgentBook | `0xA23aB2712eA7BBa896930544C7d6636a96b944dA` |
| World app | `app_a7c3e2b6b83927251a0db5345bd7146a` |
| Action | `agentbook-registration` |
| Signal | ABI `(agent signer, current nonce)` |
| Relay default | `https://x402-worldchain.vercel.app/register` |

La API key de la app `Nuvem Fund` del Developer Portal quedó solo en `.env` gitignored. No se envía
al browser ni se usa como sustituto del action oficial de AgentBook. Debe rotarse antes del deploy
público porque fue compartida durante el setup.

## Supabase NuvemFund

Proyecto: `pseqckmlumujeatdnsty` (`NuvemFund`, eu-west-1).

- Migración local: `20260722043635_managed_signer_world_onboarding.sql`.
- Migración remota aplicada: `20260722045513 managed_signer_world_onboarding`.
- Tablas nuevas: `agent_private.managed_signers`, `agent_private.world_human_bindings`.
- 18/18 tablas `agent_private`: RLS activa.
- 18/18: `anon_select=false`, `authenticated_select=false`, `service_role_crud=true`.
- Filas iniciales de las tablas nuevas: 0.
- Security Advisor: cero errores críticos; INFO esperado por RLS sin políticas de browser. Warning
  independiente: leaked-password protection desactivada (el producto usa SIWE, no password auth).
- Performance Advisor: índices sin uso por ser tablas recién creadas; no se eliminaron antes de carga
  real.

No existen columnas de private key, seed o human ID en las tablas nuevas.

## Verificación ejecutada

| Superficie | Resultado |
|---|---:|
| Managed signer package | build + 3/3 tests |
| Agent gateway | typecheck + 45/45 tests |
| Website World proof | build + 3/3 proof tests |
| Website total | 9/9 unit tests |
| Supabase live | 1/1 SIWE + profile RLS |
| Reference runtime | typecheck + build |
| Devnet creator | typecheck |
| Devnet Agents E2E | 21/21 checks |
| Contratos Solidity | 146/146 (134 unit/invariant + 12 fork 4663) |
| Devnet drill completo | 27/27 actos/checks |
| Bytecode | `Fund` 24,267 B (309 B de margen EIP-170) |
| Secret scan | `.env` ignorado; 0 coincidencias de la key World en archivos tracked |

El E2E confirmó identidad gestionada determinista/idempotente sin material privado, LP permissionless,
stake, fee al sponsor, rechazo de policy, trade válido, replay, Ponder y rotación. Evidencia del último
run:

- Fund: `0xe6e340d132b5f46d1e472debcd681b2abc16e57e`
- Controller: `0x67d269191c92caf3cd7723f116c85e6e9bf55933`
- Trade: `0xd4e81449727dfef565f1c1b69bebfb3bbea67e4610d630affd1f15c1eae00871`
- Rotate: `0x09bd19202997f6397e5b35ca98583fe2c39fe6bc9a685fc5ecb2aeccc23f46ee`
- NAV final válido: `985.84999999999999951 USDG`.

El drill completo adicional validó acceso abierto, stake y depósitos, compra TSLA por Uniswap v4,
performance fee, first-loss y claim, retiros cash e in-kind, Frozen, winding/cierre y el read model
GraphQL. Resultado: `27/27`, cero fallos.

La comprobación visual del frontend confirmó carga HTTP 200, contenido visible, sin overflow
horizontal ni error overlay, y sin errores nuevos de consola tras reiniciar Vite con el nuevo
bundle de World IDKit. El wizard requiere primero conectar la wallet sponsor, como corresponde a
la firma SIWE y al stake.

## Servicios locales vivos

```text
Frontend     http://localhost:5173/?front=robinfund
RPC          http://127.0.0.1:8545       chain 31337
Creator API  http://127.0.0.1:8788
GraphQL      http://127.0.0.1:42069/graphql
```

El backing de devnet continúa etiquetado `devnet-mock / non-canonical`. El proof canónico requiere
que el sponsor complete el QR real en World App contra un AgentRegistry/gateway público; no se
declara demostrado hasta guardar esa transacción pública.

## Gate de producción

`local-derived-v1` evita persistencia de claves, pero el secreto raíz del backend puede derivarlas.
Antes de capital público hay que implementar `kms-v1`/HSM no exportable, separar verifier/relayer/
operator, desplegar gateway público HTTPS y completar un registro AgentBook real. No cambia el límite
on-chain del controller ni la propiedad del sponsor.

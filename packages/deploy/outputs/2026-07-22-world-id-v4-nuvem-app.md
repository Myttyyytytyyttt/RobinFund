# Output — Nuvem World ID 4.0 sponsor gate

Fecha: 2026-07-22, Europe/Lisbon.

## Developer Portal

| Campo | Resultado |
|---|---|
| Team/app | `Nuvem Fund` |
| App ID | `app_5fe197d24d83c55573c5d9d0356f3d6e` |
| App status | activa; listing todavía no verificado |
| RP mode | Managed |
| RP ID | `rp_db7d77ff9edef255` |
| RP signer público | `0xE77b9bAB6c5e6e7c7C9EeaDD790D621009008073` |
| RP production/staging | registrado e inicializado on-chain |
| Action ID | `action_v4_f37c535152f022506e54282fa09a843b` |
| Action | `sponsor-ai-vault` |
| Action environment | production |
| Action registration | registrada |
| Integration URL | `https://www.nuvem.fund/?front=robinfund` |
| Website | `https://www.nuvem.fund` |
| Logo | `logo_img.png`, 51,009 B, upload confirmado por Developer Portal MCP |
| App review | no enviada; metadata/listing todavía incompletos |

La metadata pública incluye además una descripción del sponsor gate, del registro AgentBook y de que
los LPs permanecen permissionless. La app no se envió a review: faltan showcase, países soportados y
la primera prueba humana real.

El Developer API key, RP signing key y `WORLD_ID_PEPPER` están solo en `.env` gitignored. Este output
no contiene ninguno de sus valores. La API key compartida durante setup debe rotarse antes de la
demo pública.

Durante la validación local se detectó que el signer privado no coincidía con el signer público del
portal. Se rotó de nuevo usando una clave generada localmente y se verificó después que `.env`, el
portal y los registros production/staging coinciden. Las credenciales previas quedan invalidadas.

## Flujo implementado

1. Sponsor SIWE crea el perfil/job y registra el signer en `AgentRegistry`.
2. `POST /v1/agents/:id/world-id/request` firma un RP request de cinco minutos.
3. El signal fija `chainId + agentId + sponsor + signer + action`.
4. Frontend IDKit `4.2.2` solicita `proof_of_human`; prefiere protocolo 4.0 y permite únicamente el
   fallback legacy `orb` para cuentas verificadas todavía no migradas.
5. `POST /v1/agents/:id/world-id/verify` valida nonce/action/signal y reenvía el payload opaco sin
   transformarlo al endpoint oficial World.
6. Postgres consume el request atómicamente y guarda solo HMACs/hashes.
7. La wallet sponsor puede reutilizar su verificación para agentes posteriores; la cuota inicial de
   tres `nuvem_reference` se serializa por hash humano.
8. El signer completa además AgentBook. `WorldBacking` combina ambos hashes; ninguna evidencia basta sola.

Esto se aplica igual al agente Nuvem y a BYOA. La private key BYOA permanece en PC/VPS; el signer
gestionado Nuvem permanece en su boundary aislado. Los LPs no pasan World ni KYC.

## Supabase NuvemFund

Proyecto `pseqckmlumujeatdnsty`, región `eu-west-1`, estado `ACTIVE_HEALTHY`.

Migraciones remotas:

- `20260722061643 world_id_v4_sponsor_gate`
- `20260722061834 world_id_v4_fk_indexes`

Tablas privadas nuevas:

- `agent_private.world_id_requests`
- `agent_private.world_id_sponsors`
- `agent_private.world_id_agent_bindings`

Verificación live: 3/3 con RLS activa, `anon_select=false`, `authenticated_select=false`,
`service_role_crud=true`; cero filas residuales tras el smoke. Los dos avisos de foreign keys sin
índice fueron corregidos; los avisos restantes para estas tablas son INFO esperados por tablas nuevas
o por RLS deliberadamente sin políticas de navegador.

## Verificación ejecutada

| Superficie | Resultado |
|---|---:|
| Gateway typecheck | verde |
| Gateway unit | 51/51 |
| World ID unit | 6/6 dentro del total gateway |
| Postgres remoto real | 1/1, con cleanup verificado |
| Website unit | 12/12 |
| Website production build | verde; WASM IDKit generado |

Casos cubiertos: signal alterado, RP replay, request expirado/consumido, Portal reject, sponsor reuse,
cuota managed, AgentBook sin Nuvem World, Nuvem World sin AgentBook, pinning frontend de app/RP/action
y ausencia de proof/nullifier raw en persistencia.

## Evidencia todavía pendiente

No se declara una verificación humana real hasta que un sponsor escanee el QR, World acepte el proof
y el contador de verificaciones de la app deje de estar en cero. Ese acto requiere una persona con
World ID en World App; no se reemplaza por un mock ni por el smoke Postgres.

## Corrección de compatibilidad — 2026-07-24

Los logs públicos mostraron tres requests Nuvem creados con HTTP `201` y ninguna llamada posterior a
`/world-id/verify`: World App fallaba antes de devolver un proof al browser. La integración exigía
4.0 estricto, aunque World recomienda que `proofOfHuman` permita el fallback Orb para cuentas
verificadas que todavía responden con World ID 3.0.

Se cambió el request a `allow_legacy_proofs=true` y el backend acepta exactamente dos formatos:

- World ID 4.0 con `identifier=proof_of_human`;
- World ID 3.0 con `identifier=orb`.

Device, Document y Selfie siguen rechazados. Ambos formatos se ligan al mismo nonce/action/signal y
se reenvían sin transformar al endpoint oficial `/api/v4/verify/{rp_id}`, que valida v4 y legacy v3.
IDKit core se actualizó de `4.2.1` a `4.2.2`.

La UX mantiene explícitamente la pestaña abierta, indica la caducidad de cinco minutos, limpia el QR
fallido y muestra el error junto al flujo. El frontend quedó en `15/15` unit tests y build production
verde; el gateway quedó en `57/57` unit tests y typecheck verde.

Deploy production:

- gateway `dpl_B62AaSvYvSQ3a2u2GY9TVMqo3PDJ`, `READY`, alias
  `https://nuvem-agent-gateway.vercel.app`;
- frontend `dpl_7nNmeEqB1cradrxRDSMWv9StvCjh`, `READY`, alias
  `https://www.nuvem.fund`;
- `/healthz=200`, web `=200`, preflight desde `https://www.nuvem.fund=204`;
- bundle productivo confirmado con fallback legacy, error accionable y aviso de mantener la pestaña.

No hubo errores runtime en los primeros 30 minutos observados. La corrección no se considera una
verificación humana completa hasta observar `/world-id/verify` con HTTP `200` tras un scan real.

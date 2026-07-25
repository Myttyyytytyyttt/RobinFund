# World ID production — corrección del `WORLD_ID_PROOF_INVALID`

Fecha: 2026-07-24 (Europe/Lisbon).

## Incidente

Una cuenta World verificada completó correctamente el QR y World App mostró la confirmación, pero
`POST /v1/agents/:id/world-id/verify` respondió HTTP `400`. Vercel descartó timeout y CORS.
La fila privada de idempotencia en Supabase confirmó:

- código: `WORLD_ID_PROOF_INVALID`;
- estado: `failed`;
- la solicitud World no se consumió;
- no se persistió proof, nullifier ni identificador World raw.

## Causa

El parser del gateway era más estricto que el tipo real exportado por IDKit `4.2.2`. Exigía una
representación concreta de cada campo y asumía que un resultado compatible con protocolo 3.0
siempre usaría `identifier=orb`. IDKit también puede representar ese credential como
`identifier=proof_of_human`; algunos field elements pueden llegar con una codificación numérica
equivalente.

## Solución

- El parser estructural ahora sigue `IDKitResultV3 | IDKitResultV4`.
- Se aceptan únicamente:
  - protocolo 4.0, `proof_of_human`, issuer schema `1`;
  - protocolo 3.0 compatible, `orb` o `proof_of_human`.
- Device, Selfie, Document y cualquier otro credential siguen rechazados.
- Antes de contactar World se exige:
  - environment `production`;
  - `user_presence_completed=true`;
  - action, RP nonce y signal ligados al sponsor, signer y agent;
  - nullifier numérico válido y canonizado.
- El payload opaco sigue verificándose sin modificar en el endpoint oficial de World.
- Los fallos de shape solo registran metadata no sensible: versión, identifiers, presencia de campos
  y paths Zod. Nunca proof, nonce, nullifier ni signal.
- El frontend conserva una prueba ya aprobada únicamente en memoria de la pestaña. Un fallo
  transitorio se puede reintentar sin otro QR; un request expirado se detecta y genera uno nuevo.

## Verificación

| Superficie | Resultado |
|---|---:|
| Gateway typecheck/build | verde |
| Gateway unit | 60/60 |
| Website typecheck/build | verde |
| Website unit | 15/15 |
| Supabase diagnóstico read-only | `WORLD_ID_PROOF_INVALID` confirmado |
| Gateway production health | HTTP 200 |
| Website production | HTTP 200 |
| CORS desde `https://www.nuvem.fund` | HTTP 204 |
| Runtime errors tras deploy | 0 |

Casos nuevos: formato V3 `proof_of_human`, fallback Orb, rechazo Device, presencia humana obligatoria
y equivalencia segura entre field elements hexadecimales y decimales.

## Deploy production

- Gateway: `dpl_9pfTZV8b1nTK3XpG26SEVDTA1vNg`, `READY`.
- Gateway alias: `https://nuvem-agent-gateway.vercel.app`.
- Frontend: `dpl_ExjphZoMZpgJ8McuzwM2seceefZS`, `READY`.
- Frontend alias: `https://www.nuvem.fund`.

## Criterio pendiente

La infraestructura y el formato están corregidos, pero el cierre real requiere una nueva acción
humana: completar un QR fresco y observar `/world-id/verify=200`. Después el wizard debe avanzar
automáticamente a AgentBook. Esa prueba no se sustituye por un mock.

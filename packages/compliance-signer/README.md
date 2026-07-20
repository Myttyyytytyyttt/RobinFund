# RobinFund — Compliance Signer

El servicio off-chain que emite las **atestaciones EIP-712** que gatean los depósitos (SPEC §10,
Condición 28 del prospecto RHJ). Sin una atestación válida en el `EligibilityGate`, nadie puede
depositar en ningún fondo. Este servicio es quien la firma.

## El modelo

```
capa 3 (frontend + Privy/KYC)          este servicio                       on-chain
─────────────────────────────          ─────────────────────────────────   ─────────────────────
verifica identidad real        ──►     POST /admissions (admin bearer)     EligibilityGate
(quién es, jurisdicción,               política → binding → firma    ──►   attest(acc,exp,nonce,sig)
 US person)                            EIP-712 con el nonce ON-CHAIN       (permissionless: la envía
                                                                            el propio usuario)
```

- La **verificación** de identidad es de la capa de arriba (Privy/KYC en el frontend del usuario).
  Este servicio recibe la declaración YA verificada y decide con política pura.
- La **admisión** es admin (bearer token): la declaración KYC viene de un backend verificador, nunca
  del navegador. La **renovación** es pública: solo re-firma a quien ya está admitido.
- El servicio devuelve la firma; enviarla on-chain es permissionless (la manda el usuario o el
  frontend; `COMPLIANCE_AUTO_SUBMIT=1` hace que la envíe el servicio).

## Reglas que importan

- **El nonce se lee on-chain en CADA firma, jamás se cachea**: `revoke()` avanza el nonce (fix G1
  del contrato) y una firma al nonce viejo debe quedar muerta. Cachear el nonce re-abriría
  exactamente el bypass que G1 cerró. El E2E lo verifica contra el gate real.
- **La renovación pública NO confía en estado local**: lee `revokedAt` on-chain (antes y DESPUÉS de
  firmar) y deniega si está revocada — sin esto, una renovación durante la ventana de desync
  firmaría el nonce post-revocación y `attest()` LIMPIARÍA la revocación (el signer desharía su
  propia revocación; HIGH de la revisión adversarial, con test de regresión E2E).
- **Revocación write-ahead**: la marca local se escribe ANTES de la tx on-chain. Un crash entre
  ambos deja la renovación CERRADA (fail-closed); el admin reintenta.
- **Ventana de renovación**: solo renovable con el expiry a < 30d (config). Sin ventana, renovar en
  bucle convierte el TTL de 90d en elegibilidad perpetua sin re-verificación.
- **TTL ≤ 90 días** (política §10.1 — el contrato no lo acota, el signer sí), sobre el timestamp
  del último bloque.
- **Unicidad §10.1**: una dirección activa por persona (`personId` = ID **opaco** del proveedor de
  verificación — nunca PII). Rotar dirección = revocar la vieja + re-admitir con la nueva. Todo
  binding que deja de estar activo queda en el rastro de auditoría del store (append-only).
- **Jurisdicciones**: la lista de la SPEC §10.1 (US + sancionadas RHJ) está **codificada como
  default no-removible**; `COMPLIANCE_BLOCKED_JURISDICTIONS` solo AÑADE (p.ej. CA/GB/CH). Un test
  falla si el default diverge de la spec.
- **La admisión es el camino de re-habilitación**: tras una revocación, una re-admisión admin firma
  con el nonce nuevo (el contrato limpia `revokedAt`). La renovación pública queda cerrada para
  revocados — local Y on-chain.
- **`autoSubmit` solo aplica a admisiones** (admin): auto-enviar desde `/renewals` (público)
  dejaría que cualquiera queme el gas de la clave del signer hasta inutilizar `revoke()`.
- **Fail-fast al arrancar**: clave ≠ `gate.signer()`, TTL/ventana inválidos, o `ACCESS_REGISTRY`
  malformado (un `""` accidental NO desactiva el chequeo RHJ en silencio: solo `"0"` explícito, con
  aviso) → el servicio no arranca. Bind por defecto a `127.0.0.1`.

## API

| Ruta | Auth | Qué hace |
|---|---|---|
| `GET /healthz` | — | `{ ok, signer, gate, chainId }` |
| `GET /status/:address` | — | estado on-chain + local (sin PII) |
| `POST /admissions` | admin | `{ personId, address, usPerson, jurisdiction }` → atestación firmada |
| `POST /renewals` | — | `{ address }` → re-firma para una dirección ya admitida |
| `POST /revocations` | admin | `{ address }` → `gate.revoke()` on-chain + marca local |

Admin = `Authorization: Bearer <COMPLIANCE_ADMIN_TOKEN>` (comparación en tiempo constante).

## Correr

```bash
pnpm test        # 26 tests unit: política, store, firma (incl. digest EIP-712 replicado a mano)
pnpm test:e2e    # 9 tests E2E: gate REAL en anvil (sin fork) — admisión, renovación, G1, rotación,
                 #   y la regresión del HIGH (revocación externa + store desincronizado → deniega)
pnpm start
```

Config por env (el `.env` raíz se carga solo): `COMPLIANCE_SIGNER_PK` (debe ser el signer del gate),
`ELIGIBILITY_GATE`, `COMPLIANCE_ADMIN_TOKEN` (≥16 chars), `COMPLIANCE_RPC_URL` (fallback
`RH_RPC_MAINNET`), `ACCESS_REGISTRY` (default mainnet; `0` explícito desactiva), `COMPLIANCE_TTL_DAYS`
(≤90), `COMPLIANCE_RENEWAL_WINDOW_DAYS` (default 30, ≤TTL), `COMPLIANCE_BLOCKED_JURISDICTIONS` (CSV
que solo añade), `COMPLIANCE_STORE` (default `./data/compliance-store.json`, gitignored),
`COMPLIANCE_HOST`/`COMPLIANCE_PORT` (default 127.0.0.1:8787), `COMPLIANCE_AUTO_SUBMIT`.

## Revisión adversarial (aplicada)

El paquete pasó el workflow de revisión del proyecto (3 lentes + escépticos): 16 hallazgos
confirmados, todos aplicados. Los 3 HIGH compartían raíz — la renovación pública confiaba solo en el
store local, y una ventana de desync (crash entre tx y marca, o carrera) permitía firmar el nonce
post-revocación y deshacer una revocación de compliance. Cerrado con: lectura de `revokedAt`
on-chain en la renovación (antes y después de firmar) + revocación write-ahead + ventana de
renovación. El cuarto HIGH: el default de jurisdicciones no cubría la lista fija de la SPEC §10.1 —
ahora codificada y protegida por test.

## Estado y límites conocidos (v1)

Un proceso, un archivo JSON de store (interfaz lista para Postgres cuando haya réplicas). Sin rate
limiting HTTP (ponerlo detrás de un reverse proxy). Sin CORS: pensado para llamarse
backend-a-backend (el navegador no llama aquí directo). La rotación del signer on-chain
(`setSigner`) requiere reiniciar el servicio con la clave nueva. Las tx del signer salen en serie
por request (sin cola de nonces): admisiones admin concurrentes con `autoSubmit` pueden colisionar
en el nonce de la cuenta — reintentar.

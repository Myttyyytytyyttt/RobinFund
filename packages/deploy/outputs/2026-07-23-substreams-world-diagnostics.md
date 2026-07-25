# Output — Robinhood Substreams y diagnóstico World

Fecha: 2026-07-23, Europe/Lisbon.

## Substreams

Las credenciales se leyeron únicamente desde el `.env` raíz gitignored. El JWT no se imprimió,
copió a documentación ni pasó como valor en los argumentos del proceso.

| Comprobación | Resultado |
|---|---|
| `SUBSTREAMS_API_TOKEN` | presente; JWT de tres segmentos |
| endpoint | `robinhood.substreams.pinax.network:443` |
| CLI | imagen oficial `ghcr.io/streamingfast/substreams:v1.20.1` |
| package de probe | `ethereum-common@v0.3.3`, módulo `all_events` |
| bloque recibido | `16,863,868` |
| hash | `feddd8b092d13d3f663a8fcf4c8a755fd678843be95872e5f0834a0b055ff75a` |
| resultado | PASS; 1 bloque, 12 KiB sin comprimir |

Esto valida autenticación, endpoint y compatibilidad del modelo EVM. No equivale todavía a tener el
dataset Nuvem consultable: faltan el package específico, sink SQL con cursor/reorg, esquema de lectura
y conexión del gateway/MCP. `GRAPH_URL=https://unconfigured.invalid/graphql` permanece fail-closed.

## World

El QR de la action Nuvem llegó a World App. Al continuar, IDKit devolvió:

```text
credential_unavailable
```

Este código se produce antes de que exista un proof que el gateway pueda verificar. La action solicita
`proof_of_human`; según World, esa credencial requiere una World ID verificada por Orb. Crear la cuenta
en World App no emite por sí solo esa credencial.

Acción operativa:

1. completar Proof of Human/Orb en World App;
2. esperar a que la credencial termine de sincronizar;
3. repetir primero el QR `sponsor-ai-vault` de Nuvem y después el QR AgentBook;
4. si una cuenta ya verificada devuelve `inclusion_proof_pending`, esperar y reintentar sin crear otro
   agent/job.

El frontend traduce ahora `credential_unavailable`, `inclusion_proof_pending` y cancelación a mensajes
accionables. No se habilitó un credential de menor garantía ni se etiquetó un fallback como backing
canónico.

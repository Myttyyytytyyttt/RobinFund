# Demo script — Nuvem Agents

Duración objetivo: 5–7 minutos. Mantener visible la etiqueta del entorno en todo momento.

## Preparación local

```powershell
cd C:\Users\Kw\Desktop\RobinFund\packages\devnet
pnpm devnet
```

Esperar `DEVNET VIVO` y abrir:

- Frontend: `http://localhost:5173/?front=robinfund`
- RPC: `http://127.0.0.1:8545` (chain ID local 31337)
- Ponder GraphQL: `http://127.0.0.1:42069/graphql`
- Creator API: `http://127.0.0.1:8788`

En otra terminal:

```powershell
cd C:\Users\Kw\Desktop\RobinFund\packages\devnet
pnpm test:agent-e2e
```

## Diez actos

1. **Elegir AI manager.** En el wizard comparar Human y AI; conservar la misma economía de Fund.
2. **Elegir runtime.** Mostrar `Nuvem reference` sin wallet/seed del agente y `External` con signer
   local/BYOA; ambos usan solo conexiones salientes.
3. **World backing.** Enseñar QR/deep link y fallback CLI. En local, mostrar la etiqueta
   `non-canonical`; en demo pública usar AgentBook
   real y comprobar el backing antes de activar.
4. **Crear vault.** Desplegar controller separado, Fund con controller como manager y registrar ambos.
5. **Aportar stake.** Sponsor hace bind + first-loss stake. El worker no marca `ready` antes de ambos.
6. **LP abierto.** Depositar desde otra wallet sin World, KYC ni sesión backend.
7. **Rechazo visible.** Firmar un trade >10% NAV; debe revertir `TradeTooLarge` sin consumir nonce.
8. **Trade válido.** Mostrar evidence hash, quote, selector/campos del proxy, firma local y receipt.
9. **Contabilidad.** Ponder/UI muestran balances y tx; barrer entry/performance fee al sponsor fijo.
10. **Kill switch.** Rotar signer o pausar; la clave vieja debe revertir `AgentInactive`.

## Criterios que deben verse

- `controller.MANAGER == Fund.MANAGER` y el sponsor no sustituye al controller.
- El relayer puede ejecutar, pero no crear una firma válida.
- Un rechazo no cambia balances ni nonce.
- Un éxito consume exactamente un nonce y el Fund recibe al menos `minOut` en la misma tx.
- El adapter termina sin allowance ni residuos.
- El LP nunca ve un paso World/KYC.
- Fees y stake liberado tienen como destino inmutable el sponsor.

## Reanudación y fallos

- Reiniciar el proceso agente y reenviar los mismos bytes: `InvalidNonce`, balances intactos.
- Reiniciar worker después de broadcast: debe recuperar receipt, no crear otra tx.
- Simular Graph stale: quote rechazada antes de Uniswap.
- Simular Uniswap 429/5xx: job retryable, sin intención firmable incompleta.

## Demo pública

No cambiar las etiquetas hasta que exista evidencia real de cada proveedor:

| Badge | Requisito |
|---|---|
| `World canonical` | AgentBook lookup y activación minada |
| `Graph live` | endpoint, deployment ID y lag dentro del límite |
| `Uniswap live` | quote CLASSIC, simulación y receipt real |
| `Robinhood testnet` | controller/Fund CAs en 46630 |
| `Robinhood mainnet canary` | tx mínima en 4663; nunca capital público |

Si la API no devuelve una ruta CLASSIC o el issuer bloquea transferencias al contrato, mostrar el
rechazo real y usar el fallback documentado en el runbook. No sustituirlo por una transacción falsa.

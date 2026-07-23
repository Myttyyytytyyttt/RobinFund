# Output — Uniswap Trading API probe sobre Robinhood 4663

Fecha: 2026-07-22, Europe/Lisbon.

## Alcance

Probe read-only usando la key backend desde `.env`; el secreto no se imprimió, copió ni persistió
en outputs. No se transmitió ninguna transacción.

Par y parámetros:

- chain: Robinhood `4663`;
- exact input: `1 USDG` (`1,000,000` unidades);
- output: Stock Token TSLA;
- `swapper`: `UniswapApiAdapter` efímero de devnet;
- `recipient`: Fund efímero de devnet;
- headers: `x-permit2-disabled: true` y Universal Router `2.1.1`.

## Resultado `/quote`

| Comprobación | Resultado |
|---|---|
| HTTP | 200 |
| routing | `CLASSIC` |
| permitData | `null` |
| output | `2631393502987515` wei TSLA |
| quote ID | presente |
| swapper | ligado al adapter |
| recipient | ligado al Fund |

## Resultado `/swap`

Se pidió calldata con `simulateTransaction=false` porque las direcciones efímeras del fork no existen
en el estado público usado por el simulador remoto de Uniswap.

| Comprobación | Resultado |
|---|---|
| from | adapter correcto |
| chainId | `4663` |
| native value | `0` |
| selector | `0x2894adf9` |
| selector decodificado | `execute(address,address,uint256,bytes,bytes[],uint256)` |
| target API | `0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9` |
| Universal Router decodificado | `0x8876789976decbfcbbbe364623c63652db8c0904` |

El target es el proxy legado documentado por Uniswap, no la dirección CREATE2 canónica
`0x0000000085E102724e78eCd2F45DC9cA239Affad`.

## Verificación on-chain

Ambas direcciones tenían bytecode en el último estado 4663 consultado:

| Dirección | Runtime | Codehash |
|---|---:|---|
| proxy canónico | 1,005 B | `0x24a203c24b85e0994ae6aecccc2bc0c1df4e22f1b3d63f33d18bec0245867aaf` |
| proxy legado | 1,005 B | `0x24a203c24b85e0994ae6aecccc2bc0c1df4e22f1b3d63f33d18bec0245867aaf` |

## Semántica corregida del Approval Proxy

El selector anterior no recibe `tokenOut` ni `recipient` como sus dos primeros argumentos. La ABI
real es:

```text
execute(router, tokenIn, amountIn, commands, inputs, deadline)
```

El adapter fija por deployment tanto `APPROVAL_PROXY` como `UNIVERSAL_ROUTER`; además decodifica y
comprueba `router`, `tokenIn`, `amountIn` y deadline antes de llamar al proxy. `tokenOut`, recipient y
`minAmountOut` quedan ligados por el plan firmado y por el delta real de balance que el Fund recibe.
La allowance se concede por el importe exacto y se revoca después de ejecutar.

## Ejecución real sobre fork 4663

Se desplegó un `UniswapApiAdapter` efímero contra el target que devolvió la API y se ejecutó la ruta
CLASSIC real sobre un fork fresco. El primer intento revirtió correctamente con `BudgetExceeded()`
porque el Fund de prueba no tenía stake; se añadió `100 USDG` de stake y no se relajó ningún límite.

| Comprobación | Resultado |
|---|---|
| adapter | `0x7a2088a1bfc9d81c55368ae168c2c02570cb814f` |
| Fund | `0xa85233C63b9Ee964Add6F2cffe00Fd84eb32338f` |
| stake | `100 USDG` |
| quotedOut | `2660263402326409` wei TSLA |
| minOut | `2640311426808960` wei TSLA |
| recibido por el Fund | `2655204843634926` wei TSLA |
| allowance final | `0` |
| residuos adapter | `0 USDG / 0 TSLA` |
| tx local del fork | `0x9128f06e85afa7e5d30929aec1aaf4b9389821db712a46bdb6ac1c562cd9c6f3` |

Resultado: **PASS**. No se transmitió ninguna transacción pública.

## Decisión

- El proxy deja de tener un default silencioso en gateway, SDK, runtime y ejemplos.
- Cada deployment debe fijar explícitamente el target devuelto por un probe real para su chain.
- También debe fijar explícitamente el Universal Router oficial de esa chain.
- Gateway, SDK y adapter seguirán aceptando exactamente una dirección; no se añade una allowlist
  doble que permita cambiar el target después de firmar.
- El gate de fork queda cerrado. El deploy público permanece bloqueado hasta decidir y documentar
  por qué la API sigue devolviendo el proxy legado aunque la documentación marque la dirección
  CREATE2 como canónica; un probe fresco debe preceder cada promoción.

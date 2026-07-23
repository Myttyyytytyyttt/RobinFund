# Output — Nuvem Agents local/fork

Fecha: 2026-07-22, Europe/Lisbon.

## Identidad del código

- Baseline declarado: tag `pre-lisbon-2026`.
- Target del tag: `6846e4ade51fb5dcf9d31be4e2fcb863cbf58cd0`.
- Feature Agents: working tree posterior, todavía sin commit al generar este output.
- `Fund.sol`: sin cambios por Agents.

## Entorno

- Chain firmada: 31337.
- Estado: fork RPC de Robinhood Chain 4663.
- RPC local: `http://127.0.0.1:8545`.
- Ponder: `http://127.0.0.1:42069/graphql`.
- Creator: `http://127.0.0.1:8788`.
- Swap mode: `devnet-mock proxy + production UniswapApiAdapter bytecode`.
- World mode: atestación local no canónica.

El primer intento de reinicio recibió un timeout transitorio de Anvil al consultar el RPC del fork.
El RPC upstream respondió al probe posterior y el segundo arranque desplegó todo correctamente. No
hubo revert de protocolo ni cambio de código para ocultar el fallo.

## Contratos efímeros del arranque vigente

| Contrato | Dirección |
|---|---|
| TokenRegistry | `0x5fbdb2315678afecb367f032d93f642f64180aa3` |
| FundRegistry | `0x0165878a594ca255338adfa4d48449f69242eb8f` |
| OpenEligibilityGate | `0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0` |
| Guardian | `0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9` |
| AgentRegistry | `0x959922be3caee4b8cd9a407cc3ac1c251c2007b1` |
| UniswapApiAdapter | `0x9a9f2ccfde556a7e9ff0848998aa4a0cfd8863ae` |
| Adapter ID | `1` |
| DevnetApprovalProxy | `0x0b306bf915c4d645ff596e518faf3f9669b97016` |
| Devnet Universal Router | `0x0b306bf915c4d645ff596e518faf3f9669b97016` |
| Demo Fund | `0xa85233c63b9ee964add6f2cffe00fd84eb32338f` |

Estas CAs dejan de ser válidas al reiniciar Anvil y no deben copiarse a Vercel/testnet.

## E2E BYOA — 21/21

Resultado:

1. signer externo local, sin puertos entrantes;
2. backing local etiquetado no canónico;
3. controller y Fund separados;
4. controller autorizado, bind y stake `2,000 USDG`;
5. LP deposita `1,000 USDG` sin KYC/World y recibe 980 shares;
6. entry fee fija 2%, manager recibe 10 USDG y sweep llega al sponsor;
7. trade >10% NAV revierte `TradeTooLarge`, nonce intacto;
8. trade válido de 50 USDG usa controller → Fund → adapter → proxy;
9. adapter gasta exactamente amountIn y Fund recibe al menos minOut;
10. replay tras reinicio lógico revierte `InvalidNonce`, balances intactos;
11. Ponder descubre Fund y tx exacta;
12. rotación vuelve el agente a PendingBacking y la clave vieja revierte `AgentInactive`;
13. NAV final válido: `985.84999999999999951 USDG`.

Direcciones/hashes de esa ejecución:

| Dato | Valor |
|---|---|
| Agent signer | `0x211B681A5eb6d710E91eB75A4ad553b11dA831f8` (efímero; key no impresa/persistida) |
| Controller | `0x67d269191c92caf3cd7723f116c85e6e9bf55933` |
| Fund | `0xe6e340d132b5f46d1e472debcd681b2abc16e57e` |
| registerTx | `0xe40476ea3d7553776ec8afb9a116f633986dfea933e1e38903ae2d925c358115` |
| controllerTx | `0x1d9db8e31978be7cec81f913749e82df59ff5038bb93e721a1583970028b1f2b` |
| bindTx | `0x39dcf1b88ea12dc4e8e429f4da5658e7a681325833c01fe5e9e1db0cfb199667` |
| stakeTx | `0x01f7600fa846532bbb307a585c0f8d671a07abacaa8b55fe3efc55d4eca34a27` |
| depositRequestTx | `0xafc0acacc61c14b43ac9c81ba16e7fbb84f97b5149ac8def5acc0ffec7492aac` |
| depositBatchTx | `0x4d938cce9ea5c4f0ae61b13806ba0075cb792e4e79fcc11a1e9601b9888212ea` |
| feeSweepTx | `0xe19dbee9b1611c376237ba2a42b4ab4cbe393cd8248de321d6b33bbc620880e9` |
| tradeTx | `0x4a8fc9368c6d4124c8f03faa11d5ea8e110e3a5e96155d5c1dd96b0d6d771566` |
| rotateTx | `0x9e4d87a0bd0b0d40bd393e8dbfef89404515c26c8517f514d717643de7f887fa` |

Ponder reconstruyó dos fondos `Active`: `Demo Fund` y `Agent E2E Vault`; el manager del segundo es
exactamente el controller anterior.

## Regresiones de seguridad específicas

- Adapter: selector exacto
  `execute(address,address,uint256,bytes,bytes[],uint256)` con semántica
  `(router, tokenIn, amountIn, commands, inputs, deadline)`; router, input, amount y deadline ligados.
- Gateway: rechaza selector, router, tokenIn, tokenOut, amount, recipient o deadline cambiados.
- SDK: repite esa validación local antes de invocar el signer.
- Controller: firma, chain/controller, nonce, policy, World, NAV, trade, concentración, turnover,
  frecuencia y slippage.
- El proxy canónico tiene bytecode en el estado forkeado, pero el E2E usa el stand-in 31337 para
  liquidez determinista.

## Estado de servicios externos

| Servicio | Evidencia |
|---|---|
| Supabase NuvemFund | 4 migraciones Agents aplicadas; RLS e integración SIWE verdes |
| World AgentBook | Código/tests; no activación canónica pública en este output |
| The Graph | codegen/build verde; no endpoint/deployment ID público |
| Uniswap Trading API | quote, calldata y ejecución CLASSIC real sobre fork verdes; sin tx pública |
| Robinhood 46630 Agents | no deploy; las CAs públicas existentes son del core/asset pack |
| Robinhood 4663 Agents | no deploy; solo fork local |

## Matriz

Matriz final ejecutada sobre este working tree:

| Superficie | Resultado |
|---|---:|
| Contratos unit | 132/132 |
| Contratos invariant | 4/4; 32,768 calls combinadas |
| Contratos fork Robinhood 4663 | 12/12 |
| Total contratos | 148/148 |
| Contratos Agents | 19/19, incluidos dentro del total |
| Devnet Agents BYOA | 21/21 |
| Agent gateway | 55/55 + typecheck + build; 1 Postgres opt-in omitido |
| Agent SDK | 9/9 + typecheck + build |
| Reference runtime | 4/4 + typecheck + build |
| Vault intelligence MCP | 5/5 + typecheck + build |
| Keeper | 30 unit + 4/4 E2E |
| Indexer | typecheck + 7/7 E2E |
| Compliance signer legado | 26 unit + 9/9 E2E |
| Deploy lifecycle | 8/8, incluido cierre e in-kind |
| Website | 12/12 + build; 1 test Supabase opt-in omitido por diseño |
| Supabase live | 1/1 SIWE/RLS |
| Subgraph | configure + codegen + build |

Tamaños relevantes: `AgentRegistry` 5,323 B, `AgentVaultController` 14,549 B,
`UniswapApiAdapter` 3,815 B y `Fund` 24,267 B (309 B de margen EIP-170).

## Revalidación integral tras corregir el Approval Proxy

- Devnet reiniciada desde cero con las CAs efímeras de la tabla anterior.
- RPC chain ID `31337`; RPC, Creator, Ponder y frontend responden correctamente.
- Creator `/config` expone por separado `uniswapApprovalProxy` y `uniswapUniversalRouter`.
- Drill económico/lifecycle: `27/27`.
- Agents BYOA: `21/21`.
- Keeper E2E: `4/4`; compliance signer E2E: `9/9`; indexer E2E: `7/7`.
- El E2E del indexer ahora fija `PORT` explícitamente porque Ponder da prioridad a esa variable sobre
  `--port`; así un `.env` o shell del desarrollador no puede redirigir silenciosamente el test.
- Ejecución Trading API real sobre fork: PASS, `minOut` respetado, allowance final y residuos `0`.

## Verificación visual

`agent-browser` verificó la landing y el wizard AI en 1440×1000 y 390×844:

- contenido visible y sin overlay Vite/Next;
- cero page errors;
- sin overflow horizontal móvil;
- selector Human/AI y External/Nuvem funcional;
- policy defaults, World backing y launch path visibles;
- el botón de creación permanece deshabilitado sin wallet.

Evidencias:

- [`nuvem-agents-home-desktop.png`](../../../docs/assets/nuvem-agents-home-desktop.png)
- [`nuvem-agents-wizard-desktop.png`](../../../docs/assets/nuvem-agents-wizard-desktop.png)
- [`nuvem-agents-policy-desktop.png`](../../../docs/assets/nuvem-agents-policy-desktop.png)
- [`nuvem-agents-wizard-mobile.png`](../../../docs/assets/nuvem-agents-wizard-mobile.png)
- [`nuvem-agents-policy-mobile.png`](../../../docs/assets/nuvem-agents-policy-mobile.png)

Para abrir el wizard sin reducir su autenticación, la prueba visual sustituyó solo en memoria del
navegador la lectura de fondos por una respuesta vacía y usó el CTA público `Create the first vault`.
No se cambió código ni estado de la devnet. Privy no completó su iframe dentro del navegador
headless, por lo que no se afirma un login visual; SIWE y wallet flows sí están cubiertos por tests
de integración y E2E.

Ningún resultado de este archivo convierte el sistema en auditado o mainnet-ready.

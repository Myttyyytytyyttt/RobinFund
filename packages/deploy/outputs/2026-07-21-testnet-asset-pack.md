# Output · TestnetAssetPack y ensayo 46630

Fecha: 2026-07-21 (Europe/Lisbon)  
Rama: `main`  
Commit base: `085ca02`  
Estado del cambio: sin commit al producir este output

> Este documento conserva el ensayo local y el preflight previo a la financiación. El deploy público
> posterior, las CAs y el smoke vigente están en
> [`2026-07-21-testnet-public.md`](./2026-07-21-testnet-public.md).

## Alcance construido

- `packages/contracts/src/testnet/TestnetAssetPack.sol`
- `packages/contracts/script/DeployTestnetAssets.s.sol`
- `packages/contracts/script/DeployTestnetProtocol.s.sol`
- `packages/contracts/test/unit/TestnetAssetPack.t.sol`
- `packages/deploy/src/common.ts`
- `packages/deploy/src/check-testnet.ts`
- `packages/deploy/src/deploy-testnet.ts`
- `packages/deploy/src/local-e2e.ts`

También se endurecieron `Deploy.s.sol`, `CreateFund.s.sol`, el launcher de devnet y los E2E de
keeper/indexer: la private key llega solo por `DEPLOYER_PK` en el entorno, nunca por CLI.

## Build desde cero

Comandos:

```text
forge clean
forge build --sizes
```

Resultado: compilación limpia con Solc 0.8.26. No reapareció el artifact obsoleto de
`FundFactory.sol`.

| Contrato | Runtime | Margen EIP-170 |
|---|---:|---:|
| Fund | 24,267 B | 309 B |
| TestnetUSDG | 2,509 B | 22,067 B |
| TestnetStockToken | 3,728 B | 20,848 B |
| TestnetAccessRegistry | 1,053 B | 23,523 B |
| TestnetPriceFeed | 1,576 B | 23,000 B |
| TestnetLiquidityVenue | 1,089 B | 23,487 B |
| TestnetTradeAdapter | 2,687 B | 21,889 B |

## Tests de contratos

```text
forge test --no-match-path "test/fork/*"
116 passed; 0 failed

forge test --match-path "test/fork/*" --rpc-url robinhood
12 passed; 0 failed
```

Total: **128/128**. Dentro de esos 116 hay ocho tests nuevos del asset pack: mainnet guard,
faucet/cooldown, blacklist/pausas, ERC-8056, feeds, buy/sell, cero residuos, listado y beacon drift.

## Validación de servicios y frontend

Se ejecutó la matriz completa después del build limpio y de regenerar los ABI del indexer:

| Paquete | Comando | Resultado |
|---|---|---|
| deploy | `pnpm typecheck` | verde |
| devnet | `pnpm typecheck` | verde |
| keeper | `pnpm test && pnpm typecheck` | 30 unit verdes; 4 E2E omitidos en la pasada unit |
| keeper | `pnpm test:e2e` | 4/4 verdes contra Anvil y scripts reales |
| indexer | `pnpm gen-abis && pnpm typecheck && pnpm test` | typecheck verde; 7 E2E omitidos en la pasada unit |
| indexer | `pnpm test:e2e` | 7/7 verdes con Ponder y PGlite |
| website | `pnpm build && pnpm test` | build Vite verde; 3 unit verdes; 1 integración Supabase omitida por configuración |

El build del website emite warnings no bloqueantes de anotaciones `PURE` dentro de dependencias de
Privy/Rollup y un aviso de chunks grandes. No hubo error de TypeScript, Vite ni Vitest.

Higiene reproducible final:

```text
pnpm install --frozen-lockfile   verde; lockfile actual
forge fmt --check <scope>        verde
git diff --check                 verde; solo avisos informativos LF/CRLF de Git para Windows
escaneo de secretos del scope    sin valores encontrados
```

El warning de `pnpm` sobre el script ignorado de `@reown/appkit` no bloqueó instalación, build ni
tests; no se habilitó un script de dependencia adicional sin una necesidad demostrada.

## E2E local sobre chain ID 46630

Comando:

```text
cd packages/deploy
pnpm typecheck
pnpm test:local
```

Topología: Anvil vacío 46630 → scripts de broadcast reales → Fund canario → keeper real → Ponder
con PGlite temporal → asserts GraphQL.

Checks observados:

```text
openEligibility             true
keeperExecutedDeposit       true
deterministicBuyAndSell     true
performanceSettlement       true
firstLossSettlement         true
cashWithdrawal              true
inKindSlices                3
closure                     true
blacklist                   true
globalPause                 true
beaconDrift                 true
indexedState                Closed
```

Direcciones del ensayo local — **efímeras y no públicas**:

| Componente | Address local |
|---|---|
| tUSDG | `0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0` |
| tTSLA | `0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9` |
| TestnetTradeAdapter | `0x0b306bf915c4d645ff596e518faf3f9669b97016` |
| TokenRegistry | `0x67d269191c92caf3cd7723f116c85e6e9bf55933` |
| AdapterRegistry | `0xe6e340d132b5f46d1e472debcd681b2abc16e57e` |
| OpenEligibilityGate | `0xc3e53f4d16ae77db1c982e75a937b9f60fe63690` |
| Guardian | `0x84ea74d481ee0a5332c457a4d796187f6ba67feb` |
| FundRegistry | `0x9e545e3c0baab3e08cdfd552c960a1050f373042` |
| Fund canario | `0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf` |

Estas addresses son deterministas por la cuenta Anvil y se destruyeron al finalizar; no sirven en
Robinhood Chain testnet ni deben entrar en Vercel/Supabase.

## Estimación observada

Medición final de Foundry:

- asset pack: 14,293,889 gas;
- protocolo: 4,633,568 gas;
- Fund canario: 11,978,122 gas;
- total nominal: 30,905,579 gas.

El preflight público observó 0.01 gwei. El límite fijo histórico de 0.05 ETH fue sustituido antes del
broadcast por `max(0.005 ETH, 31 M gas × gasPrice × 4)`. Con ese gas price el requisito fue 0.005 ETH.

## Preflight histórico de Robinhood Chain testnet pública

```text
chainId:        46630
blockNumber:    91896831
deployer:       0xC632137E0C6657dcfA4b3709Ebf7C2a59fB62C71
balance:        0 ETH
fundedForDeploy false
```

Preflight final al terminar toda la validación y el hardening de secretos:

```text
chainId:        46630
blockNumber:    91900893
deployer:       0xC632137E0C6657dcfA4b3709Ebf7C2a59fB62C71
balance:        0 ETH
gasPrice:       0.01 gwei
required:       0.05 ETH (límite histórico, sustituido)
fundedForDeploy false
```

La wallet se generó exclusivamente para testnet. Su private key vive solo en `.env` (gitignored).
Ese estado quedó superado: se recibieron 0.0149 ETH, se ejecutó el broadcast y el smoke público, y
el saldo final observado fue 0.0145289065 ETH. Véase el output público enlazado arriba.

Hardening final: preflight y deploy comparten un único cálculo dinámico de saldo mínimo; la carga del
`.env` está limitada a variables de deployment; Foundry recibe `robinhood_testnet` como alias en vez
de la URL privada; y el JSON final nunca incluye esa URL.

## Estado vivo de la devnet después de los tests

```text
RPC chainId:     31337 (0x7a69)
GraphQL:         HTTP 200
Creator API:     HTTP 200
Frontend:        HTTP 200
Open gate:       bytecode presente; wallet 0x...BEEF elegible
Fund demo state: Active (0)
```

La devnet permaneció levantada durante y después de esta batería. El E2E 46630 usa su propio Anvil
temporal y no altera el deployment de desarrollo persistente. El ciclo completo se repitió una vez
más después del hardening del runner y volvió a finalizar con todos los checks en `true`.

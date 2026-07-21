# Reinicio limpio de devnet

Fecha: 2026-07-21, Europe/Lisbon.

## Cambios previos al reinicio

- private key retirada de los argumentos visibles de `forge`;
- `DEPLOYER_PK` inyectada por entorno;
- broadcasts secuenciales con `--slow`;
- modo `--non-interactive`;
- logs incrementales y timeout del proceso.

Los dos scripts (`Deploy.s.sol` y `CreateFund.s.sol`) finalizaron con
`ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`; el bloqueo posterior al broadcast no reapareció.

## Endpoints vivos

```text
RPC          http://127.0.0.1:8545
chainId      31337
GraphQL      http://127.0.0.1:42069/graphql
Creator API  http://127.0.0.1:8788
Frontend     http://localhost:5173
```

El chain ID local 31337 evita que una wallet confunda el fork con mainnet. El estado forkeado y las
direcciones canónicas de USDG/Stock Tokens permanecen iguales a chain 4663.

## Contratos

```text
TokenRegistry        0x5FbDB2315678afecb367f032d93F642f64180aa3
AdapterRegistry      0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
OpenEligibilityGate  0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0
Guardian             0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9
UniswapV4Adapter     0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9
FundRegistry         0x0165878A594ca255338adfa4d48449f69242Eb8F
Demo Fund            0xc6e7DF5E7b4f2A278906862b61205850344D4e7d
```

## Verificaciones

```text
Fund.GATE coincide con OpenEligibilityGate: sí
runtime del gate:                         188 bytes
isEligible(wallet arbitraria):            true
Creator /health:                          ok=true, creatorEnabled=true
Frontend HTTP:                            200
GraphQL fondo demo:                       presente
GraphQL state:                            Active (0)
GraphQL totalShares:                      7993401999600079987198
GraphQL lifetimeDeposited6:               8000000000 (8,000 USDG)
```

## Procesos conservados y reiniciados

Se detuvo exclusivamente el árbol anterior de devnet (Anvil, keeper, Ponder y creator). El proceso
Vite del frontend en el puerto 5173 se conservó. Tras el reinicio, los cuatro endpoints esperados
quedaron escuchando.

## Revalidación posterior al TestnetAssetPack

Después del build limpio, los 128 tests Solidity y los E2E de keeper/indexer, la devnet persistente
seguía respondiendo sin haber sido contaminada por el Anvil temporal 46630:

```text
eth_chainId:                              0x7a69 (31337)
GraphQL /graphql:                         HTTP 200
Creator API /health:                      HTTP 200
Frontend /:                               HTTP 200
OpenEligibilityGate.isEligible(0x...BEEF) true
Fund.state():                             0 (Active)
```

## Avisos no bloqueantes

Foundry avisó de un artifact antiguo de `FundFactory.sol`, archivo que ya no existe. No afectó el
deployment, pero se limpiará el cache generado antes de la batería final para garantizar un build
totalmente fresco.

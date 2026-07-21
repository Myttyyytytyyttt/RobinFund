# Output · Robinhood Chain testnet pública

Fecha: 2026-07-21 (Europe/Lisbon)  
Red: Robinhood Chain testnet  
Chain ID: `46630`  
Estado del cambio: sin commit al producir este output

## Resultado ejecutivo

El asset pack, protocolo y fondo canario de NuvemFund están desplegados en la testnet pública.
Después del broadcast se recorrió con transacciones reales el flujo manager → stake → depósito LP →
keeper → buy/sell → controles de seguridad → reconstrucción Ponder → frontend.

- Saldo recibido y observado antes del trabajo: `0.0149 ETH`.
- Saldo tras el deploy: `0.01464459394 ETH`.
- Coste del deploy completo: `0.00025540606 ETH`.
- Saldo tras smoke y revalidación final: `0.0145289065 ETH`.
- Gas price observado: `0.01 gwei`.
- Saldo mínimo dinámico del runner: `max(0.005 ETH, gas estimado × gas price × 4)`.
- Resultado: **no hace falta enviar más ETH ahora**.

El deployment comenzó en el bloque `92051088`; el preflight anterior al broadcast observó el bloque
`92051054`. El smoke público terminó en el bloque `92056186`.

## Contract addresses públicas

Explorer base: `https://explorer.testnet.chain.robinhood.com/address/<CA>`.

### Asset pack sin valor

| Componente | CA |
|---|---|
| Implementation marker | `0x1c3173354f81ec434eefb902c5d75b98ea9e41d5` |
| TestnetAccessRegistry | `0xba6d27e48fcc41b6c38ff515a4bc54adbe538967` |
| tUSDG | `0x336c508083e2afe17c594a8ef5b8542efcf672d5` |
| Feed tUSDG | `0xf9f57ca222ba95b0c9f081cdf657eaf6c2ada255` |
| tTSLA | `0x3f1a8f0a7d944875e3350b0c78d56d22990a6e2f` |
| Feed tTSLA | `0xe34bdc7e618c38cbdb794efca53eeec22caff017` |
| tNVDA | `0x3b334d58c329f7a98ca3c11a09e45ae3352263ae` |
| Feed tNVDA | `0xf3faaa261127ec23aad71c44ea0b54e6515485ef` |
| tAAPL | `0x6fd0d905af9841a2a268ab4784efe24575a48d1c` |
| Feed tAAPL | `0x9769e666f0557b50417fe9bdf8038f40e41faa22` |
| tMSFT | `0x5cc41b676e626c29fa685c1e9057d0264d3c6f05` |
| Feed tMSFT | `0xe5d3ea4066cd7871f1920d9cdad1f77990882a84` |
| tSPY | `0x2b41f3c8b61e7188a2c7dbf494ebf6d0beaced22` |
| Feed tSPY | `0x249363c9fb7fa1e1b45ac270598486ff292a1ded` |
| TestnetLiquidityVenue | `0xb3270d346640a7db33ec3ec0c60e0e878a47e813` |
| TestnetTradeAdapter | `0xb6c1d1017e456427de9e52df3b29392862e80da3` |

### Protocolo

| Componente | CA |
|---|---|
| TokenRegistry | `0xb5355a8acf17b7a8fedb05600fe9c2d26a4e4dc7` |
| AdapterRegistry | `0xca3ed32482e64c62cc50c72a01493ea5b33a689e` |
| OpenEligibilityGate | `0xf0cc1f908203caf04852cbf11b8569a8a48949f2` |
| Guardian | `0x44952d28eca003b4cac2191f0ae73a993defbff7` |
| FundRegistry | `0x696553ad390428abf3d95c90a3452917cbaa453c` |
| NuvemFund Testnet Canary | `0xc0FC8Edb22Dd98d1bdA19E92E34282c56c75616e` |

Deployer/manager/keeper/treasury del canary:
`0xC632137E0C6657dcfA4b3709Ebf7C2a59fB62C71`. Es una simplificación exclusiva de testnet, no el
modelo de roles para mainnet.

## Smoke público

Comando:

```powershell
cd C:\Users\Kw\Desktop\RobinFund\packages\deploy
$env:ALLOW_TESTNET_BROADCAST='1'
pnpm smoke:testnet
```

El runner derivó un LP separado sin persistir ni imprimir una segunda clave, le envió solo
`0.0001 ETH` y usó el faucet propio del asset pack. Esperó los 10 minutos reales de
`MIN_QUEUE_LATENCY`; no se usó time warp.

| Check | Resultado |
|---|---|
| Gate permissionless | `true` |
| Stake manager | `10,000 tUSDG` |
| Depósito LP | `8,000 tUSDG` |
| Shares LP | `7,997.6 NVT` |
| Keeper ejecutó el batch | `true` |
| Buy y sell deterministas | `true` |
| Residuo del adapter | `0` |
| Blacklist rechazó la operación | `true` |
| Pausa global rechazó la operación | `true` |
| Beacon drift suspendió y restauró | `true` |
| Ponder indexó el fondo | `1` |
| Ponder indexó trades | `2` |
| Ponder reconstruyó shares LP | `7,997.6 NVT` |

LP de prueba: `0x1c990A91911490e201f35a5BbD3BFcE37174963B`.

Transacciones de evidencia:

- depósito ejecutado:
  `0xe3e6d11cdb5f70c420c4aba7d1d904f4cfc6c9d57af0adbe7adba1e8ad040be7`;
- compra tTSLA:
  `0x2d7a0a60afc4bff6b86b33b82371d878640eb2e5948e1b462f5b74041fdb4b90`;
- venta tTSLA:
  `0x9ab17ba870243a4d4a63515d7dc3994f7c5c2fc699c9b6082d49a411c2a138eb`.

Los checks de blacklist, pausa y beacon drift dejaron el estado restaurado al terminar.

## Servicios vivos

Se levantan juntos con:

```powershell
cd C:\Users\Kw\Desktop\RobinFund\packages\deploy
pnpm services:testnet
```

| Servicio | URL/intervalo |
|---|---|
| Frontend testnet | `http://127.0.0.1:5174/?front=robinfund` |
| Ponder GraphQL | `http://127.0.0.1:42070/graphql` |
| Ponder ready | `http://127.0.0.1:42070/ready` |
| Keeper | tick cada `60 s` |
| PGlite persistente | `packages/indexer/.ponder/testnet-public` |

El launcher no expone la clave ni el RPC autenticado. El frontend recibe el RPC público oficial;
keeper e indexer reciben el RPC de backend únicamente en memoria.

## Verificación del frontend

La prueba en navegador recorrió landing → Explore Funds → detalle del canary y comprobó:

- contenido visible y ausencia de overlay Vite;
- cero errores de consola;
- canary público, 1 investor y `7,997.6` shares reconstruidas por backend;
- buy y sell de TSLA mostrados como `$300` cada uno;
- NAV `$1`, protección `$10,000`, cap `$250,000` y depósito mínimo `$50`;
- acceso `Open to any wallet · no KYC`;
- formulario de depósito y estimación de fee/shares visibles.

La revisión visual encontró y cerró dos fallos de configuración:

1. `VITE_DISABLE_LOCAL_CREATOR=1` no anulaba una `VITE_VAULT_CREATOR_URL` heredada y mezclaba RPC
   local 31337 con datos públicos. Ahora el disable tiene precedencia y el launcher elimina esa
   variable heredada.
2. El frontend solo conocía CAs de tokens mainnet. Se añadieron las seis CAs testnet para que
   buy/sell, ticker y unidades USDG se calculen correctamente.

## Incidencia de consistencia RPC

La primera pasada leyó cero shares inmediatamente después de una tx minada. El evento
`DepositExecuted` y una lectura posterior confirmaron `7,997.6` shares: era retraso de lectura del
proveedor, no un refund. El smoke usa ahora lecturas `eventually(...)` para estados recién minados.
El RPC público se revalidó después: bloque `92058237` y runtime del Fund de `24,267 B`.

## Checks temporales pendientes

No se forzó tiempo en la red pública. Por diseño quedan programados:

- settlement del primer período: 7 días;
- retiro cash: cooldown de 1 hora;
- aceptación de ownership de registries por Guardian: timelock de 2 días;
- soak D6: 72 horas con reinicios y fallos controlados.

Los mismos flujos temporales ya pasaron en el E2E local 46630 usando Anvil. Esto no sustituye su
confirmación pública cuando venzan los relojes.

## Estado de verificación

- bytecode y wiring de Fund: verificados;
- contrato y servicios públicos: funcionales;
- frontend: build, tests y browser flow verdes;
- fuentes en Blockscout: todavía no verificadas;
- ownership de TokenRegistry/AdapterRegistry: transferencia pendiente del timelock de Guardian;
- mainnet: **no autorizada** por este resultado.

Pasada final:

| Superficie | Resultado |
|---|---|
| Contratos unit/invariant | `116/116` |
| Contratos fork mainnet real | `12/12` |
| Deploy runner | typecheck verde |
| Keeper | build TypeScript verde |
| Indexer | typecheck verde |
| Website | build Vite verde; 3 unit verdes; 1 integración Supabase omitida |
| Browser | landing, listado y detalle verdes; 0 errores de consola |
| Servicios | ready `200`, frontend `200`, 1 fund, 2 trades, 1 LP |
| Public RPC | bloque `92059551`, Fund runtime `24,267 B`, `fundCount=1` |

Los warnings del build web son los ya conocidos de anotaciones `PURE` de Privy/Rollup y tamaño de
chunks; el proceso terminó con exit code 0.

# Runbook de despliegue

## 1. Devnet limpia

1. Resolver exactamente los procesos que pertenecen a este workspace.
2. Detener solo el árbol `packages/devnet/src/devnet.ts` y sus hijos.
3. Mantener el frontend si está siendo desarrollado en otra sesión.
4. Ejecutar `pnpm devnet` desde `packages/devnet`.
5. Registrar en `outputs/`:
   - URL RPC y chain ID;
   - URL GraphQL;
   - bloque de despliegue;
   - direcciones compartidas y fondo demo;
   - bytecode del gate y `isEligible` de una wallet arbitraria;
   - estado del keeper e indexer.
6. Ejecutar el drill desde cero en puertos aislados.

## 2. TestnetAssetPack

El pack de testnet debe reproducir interfaces y fallos relevantes, no valor económico:

- USDG de 6 decimales y mint controlado;
- Stock Tokens de 18 decimales con `uiMultiplier`, pausas y bloqueo por dirección;
- beacon/registry consultable para detectar drift de implementación;
- feeds de 8 decimales con timestamp y precio actualizables;
- ruta de trading con liquidez determinista;
- faucet público limitado únicamente para activos sin valor.

Todos los contratos del pack deben llevar `Testnet` en el nombre y rechazar chain ID 4663 para
evitar un despliegue accidental en mainnet.

Validación completa local:

```bash
cd packages/deploy
pnpm typecheck
pnpm test:local
```

El test levanta un Anvil temporal con chain ID 46630, ejecuta
`DeployTestnetAssets.s.sol`, `DeployTestnetProtocol.s.sol` y `CreateFund.s.sol`, usa el runner real
del keeper y arranca Ponder contra el historial resultante. Los puertos y la base PGlite son
temporales y se eliminan al terminar.

## 3. Robinhood Chain testnet

1. Guardar `RH_RPC_TESTNET` y una `DEPLOYER_PK` exclusiva de testnet en el `.env` raíz.
2. Ejecutar `pnpm check:testnet` desde `packages/deploy`.
3. Financiar solo si `fundedForDeploy=false`. El requisito es dinámico:
   `max(0.005 ETH, 31 M gas × gasPrice × 4)`; no se usa ya el mínimo fijo de 0.05 ETH.
4. Ejecutar el broadcast explícitamente:

   ```powershell
   $env:ALLOW_TESTNET_BROADCAST='1'
   pnpm deploy:testnet
   ```

5. El runner despliega el TestnetAssetPack, el protocolo y un fondo canario, y después comprueba
   bytecode, `Fund.GATE` y `Fund.MANAGER`.
6. Guardar el JSON público en un Markdown nuevo dentro de `outputs/`; nunca copiar secretos.
7. Ejecutar el smoke público (espera los 10 minutos reales de la cola):

   ```powershell
   $env:ALLOW_TESTNET_BROADCAST='1'
   pnpm smoke:testnet
   ```

8. Levantar el stack persistente local de testnet:

   ```powershell
   pnpm services:testnet
   ```

   Esto expone frontend `5174`, GraphQL `42070`, mantiene PGlite y ejecuta el keeper cada 60 s.
9. Validar en navegador landing → fondos → detalle y confirmar que no se heredó el Creator API del
   devnet. `VITE_DISABLE_LOCAL_CREATOR=1` debe prevalecer sobre cualquier URL local.
10. Verificar fuentes en `https://explorer.testnet.chain.robinhood.com/`.
11. Tras 2 días, ejecutar la aceptación de ownership con Guardian y registrar la tx.
12. Tras 1 hora/7 días, completar respectivamente retiro y settlement públicos.
13. Comenzar el soak de 72 h con reinicios y fallos controlados.

El runner no imprime la URL privada, no pasa claves por argumentos y solo carga del `.env` la
allowlist necesaria para este deployment. La autorización `ALLOW_TESTNET_BROADCAST=1` no se carga
desde `.env`: debe declararse expresamente para esa terminal. Foundry resuelve el RPC mediante el
alias `robinhood_testnet` de `packages/contracts/foundry.toml`.

## 4. Promoción a mainnet

Testnet no autoriza mainnet por sí sola. Se requiere además cerrar los bloqueadores de
`STATUS.md`, congelar el scope, auditar el commit exacto y ensayar el deploy con multisig.

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
- faucet administrativo únicamente para activos sin valor.

Todos los contratos del pack deben llevar `Testnet` en el nombre y rechazar chain ID 4663 para
evitar un despliegue accidental en mainnet.

## 3. Robinhood Chain testnet

1. Confirmar RPC chain ID `46630`.
2. Obtener ETH de testnet con una wallet desechable.
3. Desplegar el TestnetAssetPack.
4. Desplegar protocolo compartido usando las direcciones del pack.
5. Ejecutar la aceptación de ownership y registrar el bloque inicial.
6. Crear un fondo canario y sembrar stake/activos de prueba.
7. Verificar bytecode y fuentes en Blockscout.
8. Levantar keeper e indexer con Postgres persistente.
9. Configurar el frontend con chain ID, RPC, GraphQL y FundRegistry testnet.
10. Ejecutar el mismo ciclo de vida del drill mediante wallets normales.

## 4. Promoción a mainnet

Testnet no autoriza mainnet por sí sola. Se requiere además cerrar los bloqueadores de
`STATUS.md`, congelar el scope, auditar el commit exacto y ensayar el deploy con multisig.


/**
 * Devnet local VIVO para conectar el frontend: anvil forkeando mainnet + protocolo desplegado +
 * un fondo demo con LPs atestados y algo de actividad + keeper/signer/indexer corriendo. Queda
 * levantado hasta Ctrl-C, imprimiendo las URLs y las cuentas.
 *
 * Correr:  pnpm devnet   (necesita RH_RPC_MAINNET en el .env raíz + foundry en PATH)
 */
import { erc20Abi, type Address } from "viem";
import {
  bootAnvil,
  dealErc20,
  now,
  warpTo,
  write,
  acct,
  MANAGER,
  LP1,
  LP2,
  LP3,
  USDG,
  type Devnet,
} from "./chain.js";
import { attest, createFund, deployProtocol, pushFeeds, type Protocol } from "./deploy.js";
import { fundAbi, stakeEscrowAbi } from "./abis.js";
import { gateAbi } from "./deploy.js";
import { buildServices, signerAdmit, startServices, stopServices, type Services } from "./services.js";

const PORT = 8545;
const SIGNER_PORT = 8787;
const INDEXER_PORT = 42069;

async function seedDemo(d: Devnet, p: Protocol, s: Services, fund: Address): Promise<void> {
  const stake = (await d.pub.readContract({ address: fund, abi: fundAbi, functionName: "stakeEscrow" })) as Address;
  // onboard LP1 y LP2 por la API real del signer
  for (const [i, who] of [[1, LP1], [2, LP2]] as const) {
    const r = await signerAdmit(s, { personId: `demo-lp${i}`, address: acct[who]!.address, usPerson: false, jurisdiction: "ES" });
    if (r.ok && r.attestation) {
      const a = r.attestation;
      await write(d, who, p.eligibilityGate, gateAbi, "attest", [a.account, a.expiry, BigInt(a.nonce), a.signature]);
    }
  }
  // stake + un par de depósitos ejecutados para que el frontend tenga algo que mostrar
  await dealErc20(d, USDG, acct[MANAGER]!.address, 30_000_000000n);
  await dealErc20(d, USDG, acct[LP1]!.address, 20_000_000000n);
  await dealErc20(d, USDG, acct[LP2]!.address, 20_000_000000n);
  await write(d, MANAGER, USDG, erc20Abi, "approve", [stake, 5_000_000000n]);
  await write(d, MANAGER, stake, stakeEscrowAbi, "addStake", [5_000_000000n]);
  for (const who of [LP1, LP2]) {
    const amt = who === LP1 ? 3_000_000000n : 5_000_000000n;
    await write(d, who, USDG, erc20Abi, "approve", [fund, amt]);
    await write(d, who, fund, fundAbi, "requestDeposit", [amt]);
  }
  await warpTo(d, (await now(d)) + 700n);
  await pushFeeds(d, p);
  // el keeper (corriendo) ejecutará el batch en su próximo tick
}

async function main(): Promise<void> {
  console.log("\x1b[1mRobinFund — devnet local\x1b[0m\n");
  console.log("Compilando servicios…");
  buildServices();
  const d = await bootAnvil(PORT);
  const p = await deployProtocol(d);
  const fund = await createFund(d, p, "Demo Fund", "DEMO");
  const services = await startServices(d.rpcUrl, d.chainId, p, {
    signerPort: SIGNER_PORT,
    indexerPort: INDEXER_PORT,
    keeperIntervalS: 5,
  });
  await seedDemo(d, p, services, fund);

  const line = "─".repeat(56);
  console.log(`\n\x1b[1m\x1b[32mDEVNET VIVO\x1b[0m\n${line}`);
  console.log(`  RPC          ${d.rpcUrl}   (chainId ${d.chainId})`);
  console.log(`  GraphQL      http://127.0.0.1:${INDEXER_PORT}/graphql`);
  console.log(`  Signer API   http://127.0.0.1:${SIGNER_PORT}`);
  console.log(`${line}`);
  console.log("  Contratos:");
  console.log(`    FundRegistry     ${p.fundRegistry}`);
  console.log(`    EligibilityGate  ${p.eligibilityGate}`);
  console.log(`    Guardian         ${p.guardian}`);
  console.log(`    Fondo demo       ${fund}`);
  console.log(`${line}`);
  console.log("  Cuentas (mnemonic anvil estándar):");
  console.log(`    manager  ${acct[MANAGER]!.address}`);
  console.log(`    LP1      ${acct[LP1]!.address}  (atestado)`);
  console.log(`    LP2      ${acct[LP2]!.address}  (atestado)`);
  console.log(`    LP3      ${acct[LP3]!.address}  (sin atestar — pruébalo)`);
  console.log(`${line}`);
  console.log("  Signer admin token: devnet-admin-token-0123456789");
  console.log("  keeper + indexer + signer corriendo. Ctrl-C para parar.\n");

  const shutdown = (): void => {
    console.log("\nParando devnet…");
    stopServices(services);
    clearInterval(d.heartbeat);
    d.anvil.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // vive hasta la señal
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

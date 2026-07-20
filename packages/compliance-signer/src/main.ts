/**
 * Entry point del compliance signer.
 *
 * Config por env (el .env raíz del monorepo se carga solo):
 *   COMPLIANCE_SIGNER_PK      — clave del signer (0x…). DEBE ser el signer del gate on-chain.
 *   COMPLIANCE_RPC_URL        — RPC (fallback: RH_RPC_MAINNET)
 *   ELIGIBILITY_GATE          — dirección del EligibilityGate (obligatoria)
 *   ACCESS_REGISTRY           — ACCESS registry RHJ (default mainnet; "0" desactiva el chequeo)
 *   COMPLIANCE_ADMIN_TOKEN    — bearer token de los endpoints admin (obligatorio)
 *   COMPLIANCE_HOST           — bind del HTTP (default 127.0.0.1; exponer es decisión explícita)
 *   COMPLIANCE_PORT           — puerto HTTP (default 8787)
 *   COMPLIANCE_TTL_DAYS       — TTL de las atestaciones (default 90, máx 90)
 *   COMPLIANCE_RENEWAL_WINDOW_DAYS — solo renovable con expiry a menos de esto (default 30, ≤ TTL)
 *   COMPLIANCE_BLOCKED_JURISDICTIONS — CSV que AÑADE a la lista fija de la SPEC §10.1 (p.ej. "CA,GB,CH");
 *                               la lista base (US+sancionadas) NO es configurable
 *   COMPLIANCE_STORE          — ruta del store JSON (default ./data/compliance-store.json)
 *   COMPLIANCE_AUTO_SUBMIT    — "1" → la ADMISIÓN también envía attest() (nunca las renovaciones)
 */
import { createPublicClient, createWalletClient, defineChain, http, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { loadRootEnv } from "./env.js";
import { ComplianceService } from "./service.js";
import { ComplianceStore } from "./store.js";
import { createHttpServer } from "./http.js";
import { DEFAULT_BLOCKED_JURISDICTIONS } from "./policy.js";

const DEFAULT_ACCESS_REGISTRY = "0xe10b6f6B275de231345c20D14Ab812db62151b00" as Address;

async function main(): Promise<void> {
  loadRootEnv();

  const rpcUrl = process.env.COMPLIANCE_RPC_URL ?? process.env.RH_RPC_MAINNET;
  if (!rpcUrl) throw new Error("falta COMPLIANCE_RPC_URL o RH_RPC_MAINNET en el .env");
  const gate = process.env.ELIGIBILITY_GATE as Address | undefined;
  if (!gate) throw new Error("falta ELIGIBILITY_GATE");
  const pk = process.env.COMPLIANCE_SIGNER_PK as `0x${string}` | undefined;
  if (!pk) throw new Error("falta COMPLIANCE_SIGNER_PK");
  const adminToken = process.env.COMPLIANCE_ADMIN_TOKEN;
  if (!adminToken || adminToken.length < 16) {
    throw new Error("falta COMPLIANCE_ADMIN_TOKEN (mínimo 16 caracteres)");
  }

  // TTL y ventana: validación POSITIVA en el arranque — un env vacío da Number("")=0 y "abc" da
  // NaN; ambos deben tumbar el arranque, no descubrirse en la primera admisión real
  const ttlDays = Number(process.env.COMPLIANCE_TTL_DAYS ?? "90");
  if (!(Number.isFinite(ttlDays) && ttlDays > 0 && ttlDays <= 90)) {
    throw new Error(`COMPLIANCE_TTL_DAYS inválido: "${process.env.COMPLIANCE_TTL_DAYS}" (esperado 0 < días ≤ 90)`);
  }
  const renewalWindowDays = Number(process.env.COMPLIANCE_RENEWAL_WINDOW_DAYS ?? "30");
  if (!(Number.isFinite(renewalWindowDays) && renewalWindowDays > 0 && renewalWindowDays <= ttlDays)) {
    throw new Error(
      `COMPLIANCE_RENEWAL_WINDOW_DAYS inválido: "${process.env.COMPLIANCE_RENEWAL_WINDOW_DAYS}" (esperado 0 < días ≤ TTL)`,
    );
  }

  // ACCESS registry: SOLO "0" explícito desactiva el chequeo (con log); "" o un valor no-address
  // son error de config — jamás apagar un control de compliance en silencio
  const accessRegistryEnv = process.env.ACCESS_REGISTRY;
  let accessRegistry: Address | null;
  if (accessRegistryEnv === undefined) {
    accessRegistry = DEFAULT_ACCESS_REGISTRY;
  } else if (accessRegistryEnv === "0") {
    accessRegistry = null;
    console.warn(JSON.stringify({ msg: "AVISO: chequeo del ACCESS registry de RHJ DESACTIVADO (ACCESS_REGISTRY=0)" }));
  } else if (isAddress(accessRegistryEnv, { strict: false })) {
    accessRegistry = accessRegistryEnv as Address;
  } else {
    throw new Error(`ACCESS_REGISTRY inválido: "${accessRegistryEnv}" (dirección, o "0" para desactivar explícitamente)`);
  }

  const extra = (process.env.COMPLIANCE_BLOCKED_JURISDICTIONS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const signerAccount = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `robinhood-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const walletClient = createWalletClient({ account: signerAccount, chain, transport: http(rpcUrl) });

  const store = new ComplianceStore(
    process.env.COMPLIANCE_STORE ?? resolve(process.cwd(), "data/compliance-store.json"),
  );
  const service = new ComplianceService(publicClient, walletClient, signerAccount, chain, store, {
    gate,
    accessRegistry,
    chainId,
    ttlSeconds: Math.floor(ttlDays * 24 * 3600),
    renewalWindowSeconds: Math.floor(renewalWindowDays * 24 * 3600),
    blockedJurisdictions: [...new Set([...DEFAULT_BLOCKED_JURISDICTIONS, ...extra])],
    autoSubmit: process.env.COMPLIANCE_AUTO_SUBMIT === "1",
  });

  await service.assertSignerMatches(); // fail-fast si la clave no es el signer del gate

  const port = Number(process.env.COMPLIANCE_PORT ?? "8787");
  // bind por defecto a loopback: exponerlo a la red es una decisión EXPLÍCITA del operador
  const host = process.env.COMPLIANCE_HOST ?? "127.0.0.1";
  const server = createHttpServer(service, { signer: signerAccount.address, gate, chainId }, adminToken);
  server.listen(port, host, () => {
    console.log(
      JSON.stringify({ msg: "compliance signer arrancado", host, port, chainId, gate, signer: signerAccount.address }),
    );
  });

  const stop = (): void => {
    console.log(JSON.stringify({ msg: "parando" }));
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

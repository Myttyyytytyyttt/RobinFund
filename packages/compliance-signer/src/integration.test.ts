/**
 * E2E del compliance signer contra el EligibilityGate REAL en anvil (sin fork — no necesita RPC key):
 *
 *   anvil limpio → deploy del gate desde el artefacto de forge → servicio HTTP completo →
 *   admisión → attest on-chain → elegible → renovación (nonce fresco) → revocación on-chain →
 *   REGRESIÓN G1: la firma pre-revocación muere (BadNonce) → re-admisión → elegible otra vez.
 *
 * Correr:  pnpm test:e2e   (necesita anvil en PATH y el artefacto compilado en packages/contracts/out)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gateAbi } from "./abi.js";
import { ComplianceService } from "./service.js";
import { ComplianceStore } from "./store.js";
import { createHttpServer } from "./http.js";
import type { Server } from "node:http";
import type { SignedAttestation } from "./signer.js";

const RUN = process.env.COMPLIANCE_E2E === "1";

const PK = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0 signer
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1 user1 (LP)
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 2 user2
] as const;
const acct = PK.map((pk) => privateKeyToAccount(pk as Hex));

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "../../contracts");
const PORT = 8546 + ((process.pid + 137) % 1000);
const ANVIL_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";

// errores del gate para que viem los decodifique en los asserts de revert
const gateAbiWithErrors = [
  ...gateAbi,
  { type: "error", name: "BadNonce", inputs: [] },
  { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
] as const;

let anvil: ChildProcess | null = null;
let chain: Chain;
let pub: PublicClient;
let signerWallet: WalletClient;
let userWallet: WalletClient;
let gate: Address;
let server: Server | null = null;
let baseUrl = "";
let storeDir = "";
let service: ComplianceService;

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ code: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: res.status, json: await res.json() };
}

/** Envía la atestación on-chain desde el USUARIO (attest es permissionless). */
async function submitAttestation(a: SignedAttestation): Promise<void> {
  const hash = await userWallet.writeContract({
    address: gate,
    abi: gateAbiWithErrors,
    functionName: "attest",
    args: [a.account, a.expiry, BigInt(a.nonce), a.signature],
    account: acct[1]!,
    chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
}

async function isEligible(address: Address): Promise<boolean> {
  return (await pub.readContract({ address: gate, abi: gateAbi, functionName: "isEligible", args: [address] })) as boolean;
}

beforeAll(async () => {
  if (!RUN) return;

  // artefacto del gate (compilar si hace falta)
  const artifactPath = resolve(contractsDir, "out/EligibilityGate.sol/EligibilityGate.json");
  if (!existsSync(artifactPath)) {
    const res = spawnSync("forge", ["build"], { cwd: contractsDir, encoding: "utf8" });
    if (res.status !== 0) throw new Error(`forge build falló:\n${res.stdout}\n${res.stderr}`);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    abi: unknown[];
    bytecode: { object: Hex };
  };

  // anvil limpio (sin fork)
  anvil = spawn("anvil", ["--port", String(PORT)], { stdio: "ignore" });
  const probe = createPublicClient({ transport: http(ANVIL_URL) });
  let chainId = 0;
  for (let i = 0; i < 60; i++) {
    try {
      chainId = await probe.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!chainId) throw new Error(`anvil no arrancó en ${ANVIL_URL}`);

  chain = defineChain({
    id: chainId,
    name: "anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_URL] } },
  });
  pub = createPublicClient({ chain, transport: http(ANVIL_URL) });
  signerWallet = createWalletClient({ account: acct[0]!, chain, transport: http(ANVIL_URL) });
  userWallet = createWalletClient({ account: acct[1]!, chain, transport: http(ANVIL_URL) });

  // deploy del gate REAL, constructor(signer = acct0)
  const deployHash = await signerWallet.deployContract({
    abi: artifact.abi as never,
    bytecode: artifact.bytecode.object,
    args: [acct[0]!.address],
    account: acct[0]!,
    chain,
  });
  const rec = await pub.waitForTransactionReceipt({ hash: deployHash });
  gate = rec.contractAddress!;

  // servicio + HTTP
  storeDir = mkdtempSync(join(tmpdir(), "compliance-e2e-"));
  service = new ComplianceService(
    pub,
    signerWallet,
    acct[0]!,
    chain,
    new ComplianceStore(join(storeDir, "store.json")),
    {
      gate,
      accessRegistry: null, // anvil limpio: no existe el registry de RHJ
      chainId,
      ttlSeconds: 30 * 24 * 3600,
      // ventana > TTL: renovable siempre en el E2E (los tests de ventana son unit). No es TTL
      // exacto porque anvil mina todo en el mismo segundo → secondsToExpiry == TTL y `<` falla.
      renewalWindowSeconds: 31 * 24 * 3600,
      blockedJurisdictions: ["US", "KP"],
      autoSubmit: false,
    },
  );
  await service.assertSignerMatches();

  server = createHttpServer(service, { signer: acct[0]!.address, gate, chainId }, ADMIN_TOKEN);
  await new Promise<void>((res) => server!.listen(0, () => res()));
  const addr = server.address();
  if (typeof addr === "object" && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
}, 120_000);

afterAll(() => {
  server?.close();
  anvil?.kill();
  if (storeDir) rmSync(storeDir, { recursive: true, force: true });
});

describe.skipIf(!RUN)("E2E: compliance signer contra el EligibilityGate real", () => {
  let heldPreRevokeSig: SignedAttestation | null = null;

  it("healthz responde y el signer coincide con el del gate", async () => {
    const { code, json } = await api("GET", "/healthz");
    expect(code).toBe(200);
    expect(json.signer.toLowerCase()).toBe(acct[0]!.address.toLowerCase());
  });

  it("admisión sin token → 401; con token → atestación que el USUARIO envía y queda elegible", async () => {
    const body = { personId: "kyc-user1", address: acct[1]!.address, usPerson: false, jurisdiction: "ES" };
    expect((await api("POST", "/admissions", body)).code).toBe(401);

    const { code, json } = await api("POST", "/admissions", body, ADMIN_TOKEN);
    expect(code).toBe(201);
    expect(json.attestation.nonce).toBe("0");

    expect(await isEligible(acct[1]!.address)).toBe(false); // aún no enviada
    await submitAttestation(json.attestation as SignedAttestation);
    expect(await isEligible(acct[1]!.address)).toBe(true);

    const st = await api("GET", `/status/${acct[1]!.address}`);
    expect(st.json.eligible).toBe(true);
    expect(st.json.admittedLocally).toBe(true);
    expect(st.json.nonce).toBe("1"); // attest avanzó el nonce
  });

  it("política vía HTTP: US person, jurisdicción bloqueada, y unicidad → 403", async () => {
    const us = await api(
      "POST",
      "/admissions",
      { personId: "kyc-x", address: acct[2]!.address, usPerson: true, jurisdiction: "ES" },
      ADMIN_TOKEN,
    );
    expect(us.code).toBe(403);

    const kp = await api(
      "POST",
      "/admissions",
      { personId: "kyc-x", address: acct[2]!.address, usPerson: false, jurisdiction: "kp" },
      ADMIN_TOKEN,
    );
    expect(kp.code).toBe(403);

    // la dirección de user1 ya es de kyc-user1
    const stolen = await api(
      "POST",
      "/admissions",
      { personId: "kyc-otro", address: acct[1]!.address, usPerson: false, jurisdiction: "ES" },
      ADMIN_TOKEN,
    );
    expect(stolen.code).toBe(403);

    // kyc-user1 no puede tener segunda dirección activa
    const second = await api(
      "POST",
      "/admissions",
      { personId: "kyc-user1", address: acct[2]!.address, usPerson: false, jurisdiction: "ES" },
      ADMIN_TOKEN,
    );
    expect(second.code).toBe(403);
  });

  it("renovación pública: firma con el nonce FRESCO post-attest y verifica on-chain", async () => {
    const { code, json } = await api("POST", "/renewals", { address: acct[1]!.address });
    expect(code).toBe(201);
    expect(json.attestation.nonce).toBe("1"); // leyó el nonce avanzado, no el cacheado

    heldPreRevokeSig = json.attestation as SignedAttestation; // la retenemos SIN enviar (para G1)

    // una renovación enviada extiende el expiry
    const { json: again } = await api("POST", "/renewals", { address: acct[1]!.address });
    await submitAttestation(again.attestation as SignedAttestation);
    expect(await isEligible(acct[1]!.address)).toBe(true);
  });

  it("renovación de dirección no admitida → 403", async () => {
    const { code } = await api("POST", "/renewals", { address: acct[2]!.address });
    expect(code).toBe(403);
  });

  it("revocación admin: tx on-chain, inelegible, y REGRESIÓN G1 — la firma pre-revocación muere", async () => {
    expect((await api("POST", "/revocations", { address: acct[1]!.address })).code).toBe(401);

    const { code, json } = await api("POST", "/revocations", { address: acct[1]!.address }, ADMIN_TOKEN);
    expect(code).toBe(200);
    expect(json.txHash).toMatch(/^0x/);
    expect(await isEligible(acct[1]!.address)).toBe(false);

    // G1: la firma retenida (nonce 2... no: nonce de ANTES de revocar) ya no puede re-habilitar
    await expect(submitAttestation(heldPreRevokeSig!)).rejects.toThrow(/BadNonce/);
    expect(await isEligible(acct[1]!.address)).toBe(false);

    // y la renovación pública queda cerrada (revocado localmente)
    expect((await api("POST", "/renewals", { address: acct[1]!.address })).code).toBe(403);
  });

  it("re-admisión tras revocación (re-verificación admin): nonce nuevo → elegible otra vez", async () => {
    const { code, json } = await api(
      "POST",
      "/admissions",
      { personId: "kyc-user1", address: acct[1]!.address, usPerson: false, jurisdiction: "ES" },
      ADMIN_TOKEN,
    );
    expect(code).toBe(201);

    await submitAttestation(json.attestation as SignedAttestation);
    expect(await isEligible(acct[1]!.address)).toBe(true);
  });

  it("rotación: revocar y re-admitir a la persona con OTRA dirección", async () => {
    await api("POST", "/revocations", { address: acct[1]!.address }, ADMIN_TOKEN);
    const { code, json } = await api(
      "POST",
      "/admissions",
      { personId: "kyc-user1", address: acct[2]!.address, usPerson: false, jurisdiction: "ES" },
      ADMIN_TOKEN,
    );
    expect(code).toBe(201);
    await submitAttestation(json.attestation as SignedAttestation);
    expect(await isEligible(acct[2]!.address)).toBe(true);
  });

  it("REGRESIÓN (HIGH de la revisión): revocación on-chain FUERA del servicio → la renovación pública deniega aunque el store local diga activa", async () => {
    // user2 está admitido y elegible; revocamos DIRECTO contra el gate (cast/segunda réplica/crash
    // pre-marca-local: el store del servicio se queda diciendo "activa" — desync real)
    const hash = await signerWallet.writeContract({
      address: gate,
      abi: gateAbiWithErrors,
      functionName: "revoke",
      args: [acct[2]!.address],
      account: acct[0]!,
      chain,
    });
    await pub.waitForTransactionReceipt({ hash });
    expect(await isEligible(acct[2]!.address)).toBe(false);

    // sin el fix, esto firmaba el nonce post-revocación y attest() limpiaba la revocación
    const { code, json } = await api("POST", "/renewals", { address: acct[2]!.address });
    expect(code).toBe(403);
    expect(json.reason).toContain("on-chain");
    expect(await isEligible(acct[2]!.address)).toBe(false);

    // el camino LEGÍTIMO de re-habilitación (admisión admin) sí funciona
    const re = await api(
      "POST",
      "/admissions",
      { personId: "kyc-user1", address: acct[2]!.address, usPerson: false, jurisdiction: "ES" },
      ADMIN_TOKEN,
    );
    expect(re.code).toBe(201);
    await submitAttestation(re.json.attestation as SignedAttestation);
    expect(await isEligible(acct[2]!.address)).toBe(true);
  });
});

/**
 * Orquestación de los TRES servicios de la capa 2 como procesos reales (los mismos que irán a
 * producción), apuntados al devnet: keeper (bucle de ticks), compliance signer (HTTP) e indexer
 * Ponder (GraphQL). Más los clientes para hablar con ellos.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Address } from "viem";
import { rootDir, PK, KEEPER, SIGNER } from "./chain.js";
import type { Protocol } from "./deploy.js";

const keeperDir = resolve(rootDir, "packages/keeper");
const signerDir = resolve(rootDir, "packages/compliance-signer");
const indexerDir = resolve(rootDir, "packages/indexer");

export interface Services {
  procs: ChildProcess[];
  signerUrl: string;
  indexerUrl: string;
  adminToken: string;
  logs: Record<string, string>;
}

const ADMIN_TOKEN = "devnet-admin-token-0123456789";

/** Compila keeper y signer (su `start` es `pnpm build && node dist/main.js`) y hace el codegen del indexer. */
export function buildServices(): void {
  for (const [dir, name] of [[keeperDir, "keeper"], [signerDir, "signer"]] as const) {
    const r = spawnSync("pnpm", ["build"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" });
    if (r.status !== 0) throw new Error(`build de ${name} falló:\n${r.stdout}\n${r.stderr}`);
  }
  if (!existsSync(resolve(indexerDir, "ponder-env.d.ts"))) {
    spawnSync("pnpm", ["codegen"], {
      cwd: indexerDir,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, FUND_REGISTRY: "0x0000000000000000000000000000000000000001", ELIGIBILITY_GATE: "0x0000000000000000000000000000000000000002", INDEXER_RPC_URL: "http://127.0.0.1:9" },
    });
  }
}

function pipeLogs(proc: ChildProcess, key: string, logs: Record<string, string>): void {
  logs[key] = "";
  const cap = (b: Buffer) => (logs[key] = (logs[key]! + b.toString()).slice(-6000));
  proc.stdout?.on("data", cap);
  proc.stderr?.on("data", cap);
}

/** Levanta keeper + signer + indexer contra el devnet. keeperIntervalS bajo para un drill ágil. */
export async function startServices(
  rpcUrl: string,
  chainId: number,
  p: Protocol,
  opts: { keeperPort?: number; signerPort: number; indexerPort: number; keeperIntervalS?: number },
): Promise<Services> {
  const logs: Record<string, string> = {};
  const procs: ChildProcess[] = [];
  const common = { ...process.env, RH_RPC_MAINNET: undefined } as NodeJS.ProcessEnv;

  // --- compliance signer (HTTP) ---
  const signerStore = mkdtempSync(join(tmpdir(), "devnet-signer-"));
  const signer = spawn("node", ["dist/main.js"], {
    cwd: signerDir,
    env: {
      ...common,
      COMPLIANCE_RPC_URL: rpcUrl,
      ELIGIBILITY_GATE: p.eligibilityGate,
      COMPLIANCE_SIGNER_PK: PK[SIGNER],
      COMPLIANCE_ADMIN_TOKEN: ADMIN_TOKEN,
      COMPLIANCE_PORT: String(opts.signerPort),
      COMPLIANCE_HOST: "127.0.0.1",
      ACCESS_REGISTRY: "0", // en el fork isBlocked del registry real se usa vía el Fund; el signer no lo necesita
      COMPLIANCE_STORE: join(signerStore, "store.json"),
      COMPLIANCE_TTL_DAYS: "85",
      COMPLIANCE_RENEWAL_WINDOW_DAYS: "84",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeLogs(signer, "signer", logs);
  procs.push(signer);

  // --- keeper (bucle) ---
  const keeper = spawn("node", ["dist/main.js"], {
    cwd: keeperDir,
    env: {
      ...common,
      KEEPER_RPC_URL: rpcUrl,
      FUND_REGISTRY: p.fundRegistry,
      ACCESS_REGISTRY: "0xe10b6f6B275de231345c20D14Ab812db62151b00",
      KEEPER_PK: PK[KEEPER],
      KEEPER_START_BLOCK: String(p.deployBlock),
      KEEPER_INTERVAL_S: String(opts.keeperIntervalS ?? 3),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pipeLogs(keeper, "keeper", logs);
  procs.push(keeper);

  // --- indexer (Ponder GraphQL) ---
  const pgliteDir = mkdtempSync(join(tmpdir(), "devnet-ponder-"));
  const indexer = spawn(
    "node",
    ["node_modules/ponder/dist/esm/bin/ponder.js", "start", "--schema", "public", "--port", String(opts.indexerPort), "--hostname", "127.0.0.1"],
    {
      cwd: indexerDir,
      env: {
        ...common,
        INDEXER_RPC_URL: rpcUrl,
        INDEXER_CHAIN_ID: String(chainId),
        FUND_REGISTRY: p.fundRegistry,
        ELIGIBILITY_GATE: p.eligibilityGate,
        INDEXER_START_BLOCK: String(p.deployBlock),
        PONDER_PGLITE_DIR: pgliteDir,
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeLogs(indexer, "indexer", logs);
  procs.push(indexer);

  const signerUrl = `http://127.0.0.1:${opts.signerPort}`;
  const indexerUrl = `http://127.0.0.1:${opts.indexerPort}`;

  await waitForHttp(`${signerUrl}/healthz`, 60_000, "signer", logs);
  await waitForHttp(`${indexerUrl}/ready`, 180_000, "indexer", logs);

  return { procs, signerUrl, indexerUrl, adminToken: ADMIN_TOKEN, logs };
}

async function waitForHttp(url: string, timeoutMs: number, name: string, logs: Record<string, string>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      /* aún no */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} no respondió en ${url}\n--- logs ---\n${logs[name] ?? ""}`);
}

export function stopServices(s: Services): void {
  for (const p of s.procs) p.kill();
}

// ---------- clientes ----------

export interface SignedAttestation {
  account: Address;
  expiry: number;
  nonce: string;
  signature: `0x${string}`;
}

export async function signerAdmit(
  s: Services,
  body: { personId: string; address: Address; usPerson: boolean; jurisdiction: string },
): Promise<{ ok: boolean; status: number; attestation?: SignedAttestation; reason?: string }> {
  const res = await fetch(`${s.signerUrl}/admissions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.adminToken}` },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { ok?: boolean; attestation?: SignedAttestation; reason?: string };
  return { ok: !!j.ok, status: res.status, attestation: j.attestation, reason: j.reason };
}

export async function signerRevoke(s: Services, address: Address): Promise<{ status: number; txHash?: string }> {
  const res = await fetch(`${s.signerUrl}/revocations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.adminToken}` },
    body: JSON.stringify({ address }),
  });
  const j = (await res.json()) as { txHash?: string };
  return { status: res.status, txHash: j.txHash };
}

export async function signerRenew(s: Services, address: Address): Promise<{ status: number; reason?: string }> {
  const res = await fetch(`${s.signerUrl}/renewals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const j = (await res.json()) as { reason?: string };
  return { status: res.status, reason: j.reason };
}

export async function gql(s: Services, query: string): Promise<any> {
  const res = await fetch(`${s.indexerUrl}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = (await res.json()) as { data?: unknown; errors?: unknown };
  if (j.errors) throw new Error(`GraphQL: ${JSON.stringify(j.errors)}`);
  return j.data;
}

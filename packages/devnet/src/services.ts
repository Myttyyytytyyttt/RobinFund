/**
 * Orquestación de los DOS servicios activos de la capa 2 como procesos reales (los mismos que irán
 * a producción), apuntados al devnet: keeper (bucle de ticks) e indexer Ponder (GraphQL).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rootDir, PK, KEEPER } from "./chain.js";
import type { Protocol } from "./deploy.js";

const keeperDir = resolve(rootDir, "packages/keeper");
const indexerDir = resolve(rootDir, "packages/indexer");

export interface Services {
  procs: ChildProcess[];
  indexerUrl: string;
  logs: Record<string, string>;
}

/** Compila keeper y hace el codegen del indexer cuando aún no existe. */
export function buildServices(): void {
  const keeperBuild = spawnSync("pnpm", ["build"], { cwd: keeperDir, encoding: "utf8", shell: process.platform === "win32" });
  if (keeperBuild.status !== 0) throw new Error(`build de keeper falló:\n${keeperBuild.stdout}\n${keeperBuild.stderr}`);
  if (!existsSync(resolve(indexerDir, "ponder-env.d.ts"))) {
    spawnSync("pnpm", ["codegen"], {
      cwd: indexerDir,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, FUND_REGISTRY: "0x0000000000000000000000000000000000000001", INDEXER_RPC_URL: "http://127.0.0.1:9" },
    });
  }
}

function pipeLogs(proc: ChildProcess, key: string, logs: Record<string, string>): void {
  logs[key] = "";
  const cap = (b: Buffer) => (logs[key] = (logs[key]! + b.toString()).slice(-6000));
  proc.stdout?.on("data", cap);
  proc.stderr?.on("data", cap);
}

/** Levanta keeper + indexer contra el devnet. keeperIntervalS bajo para un drill ágil. */
export async function startServices(
  rpcUrl: string,
  chainId: number,
  p: Protocol,
  opts: { indexerPort: number; keeperIntervalS?: number },
): Promise<Services> {
  const logs: Record<string, string> = {};
  const procs: ChildProcess[] = [];
  const common = { ...process.env, RH_RPC_MAINNET: undefined } as NodeJS.ProcessEnv;

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
        INDEXER_START_BLOCK: String(p.deployBlock),
        PONDER_PGLITE_DIR: pgliteDir,
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  pipeLogs(indexer, "indexer", logs);
  procs.push(indexer);

  const indexerUrl = `http://127.0.0.1:${opts.indexerPort}`;

  await waitForHttp(`${indexerUrl}/ready`, 180_000, "indexer", logs);

  return { procs, indexerUrl, logs };
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

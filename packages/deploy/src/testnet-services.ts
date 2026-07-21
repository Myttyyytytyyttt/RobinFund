import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  contractsDir,
  loadRootEnv,
  readAssetManifest,
  readProtocolManifest,
  requirePrivateKey,
  rootDir,
} from "./common.js";

const INDEXER_PORT = 42_070;
const FRONTEND_PORT = 5_174;
const PUBLIC_TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

interface BroadcastFile { receipts: Array<{ blockNumber: string }> }

function deploymentStartBlock(): bigint {
  const path = resolve(contractsDir, "broadcast/DeployTestnetAssets.s.sol/46630/run-latest.json");
  const file = JSON.parse(readFileSync(path, "utf8")) as BroadcastFile;
  if (file.receipts.length === 0) throw new Error("broadcast público sin receipts");
  return file.receipts.reduce((min, row) => {
    const block = BigInt(row.blockNumber);
    return block < min ? block : min;
  }, BigInt(file.receipts[0]!.blockNumber));
}

const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function waitFor(url: string, label: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch { /* arrancando */ }
    await sleep(1_000);
  }
  throw new Error(`${label} no respondió en ${url}`);
}

async function main(): Promise<void> {
  loadRootEnv();
  const rpcUrl = process.env.RH_RPC_TESTNET;
  if (!rpcUrl) throw new Error("falta RH_RPC_TESTNET en el .env raíz");
  const keeperPk = requirePrivateKey(
    process.env.TESTNET_DEPLOYER_PK ?? process.env.DEPLOYER_PK,
    "TESTNET_DEPLOYER_PK/DEPLOYER_PK",
  );
  const assets = readAssetManifest(46_630);
  const protocol = readProtocolManifest(46_630);
  const startBlock = deploymentStartBlock();
  const keeperDir = resolve(rootDir, "packages/keeper");
  const indexerDir = resolve(rootDir, "packages/indexer");
  const websiteDir = resolve(rootDir, "website");
  const pgliteDir = resolve(indexerDir, ".ponder/testnet-public");
  mkdirSync(pgliteDir, { recursive: true });

  const processes: Array<{ name: string; child: ChildProcess }> = [];
  const logs = new Map<string, string>();
  let stopping = false;

  const launch = (name: string, child: ChildProcess): void => {
    logs.set(name, "");
    const capture = (chunk: Buffer) => logs.set(name, `${logs.get(name) ?? ""}${chunk.toString()}`.slice(-12_000));
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("exit", (code) => {
      if (!stopping) {
        console.error(JSON.stringify({ msg: "servicio detenido inesperadamente", name, code, logs: logs.get(name) }));
        stop();
        process.exitCode = 1;
      }
    });
    processes.push({ name, child });
  };

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    for (const { child } of processes) if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const baseEnv = { ...process.env };
  delete baseEnv.DEPLOYER_PK;
  delete baseEnv.TESTNET_DEPLOYER_PK;
  delete baseEnv.RH_RPC_TESTNET;
  delete baseEnv.VITE_VAULT_CREATOR_URL;

  launch("keeper", spawn("node", ["dist/main.js"], {
    cwd: keeperDir,
    env: {
      ...baseEnv,
      KEEPER_RPC_URL: rpcUrl,
      KEEPER_PK: keeperPk,
      FUND_REGISTRY: protocol.fundRegistry,
      ACCESS_REGISTRY: assets.accessRegistry,
      KEEPER_START_BLOCK: startBlock.toString(),
      KEEPER_INTERVAL_S: "60",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));

  launch("indexer", spawn("node", [
    "node_modules/ponder/dist/esm/bin/ponder.js",
    "start",
    "--schema",
    "public",
    "--port",
    String(INDEXER_PORT),
    "--hostname",
    "127.0.0.1",
  ], {
    cwd: indexerDir,
    env: {
      ...baseEnv,
      INDEXER_RPC_URL: rpcUrl,
      INDEXER_CHAIN_ID: "46630",
      FUND_REGISTRY: protocol.fundRegistry,
      INDEXER_START_BLOCK: startBlock.toString(),
      PONDER_PGLITE_DIR: pgliteDir,
      DATABASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));

  launch("frontend", spawn("node", [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    String(FRONTEND_PORT),
    "--strictPort",
  ], {
    cwd: websiteDir,
    env: {
      ...baseEnv,
      VITE_RH_CHAIN_ID: "46630",
      VITE_RH_RPC_URL: PUBLIC_TESTNET_RPC,
      VITE_INDEXER_GRAPHQL_URL: `http://127.0.0.1:${INDEXER_PORT}/graphql`,
      VITE_FUND_REGISTRY_ADDRESS: protocol.fundRegistry,
      VITE_USDG_ADDRESS: assets.usdg,
      VITE_DISABLE_LOCAL_CREATOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));

  try {
    await Promise.all([
      waitFor(`http://127.0.0.1:${INDEXER_PORT}/ready`, "indexer"),
      waitFor(`http://127.0.0.1:${FRONTEND_PORT}/?front=robinfund`, "frontend"),
    ]);
    let indexed = false;
    for (let i = 0; i < 90; i++) {
      const response = await fetch(`http://127.0.0.1:${INDEXER_PORT}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ funds { items { address } } trades { items { fund } } }" }),
      });
      const json = (await response.json()) as { data?: { funds: { items: unknown[] }; trades: { items: unknown[] } } };
      if (json.data && json.data.funds.items.length === 1 && json.data.trades.items.length >= 2) {
        indexed = true;
        break;
      }
      await sleep(2_000);
    }
    if (!indexed) throw new Error("el indexer persistente no completó el backfill público");

    console.log(JSON.stringify({
      ok: true,
      mode: "public-testnet",
      chainId: 46_630,
      startBlock: startBlock.toString(),
      fundRegistry: protocol.fundRegistry,
      usdg: assets.usdg,
      urls: {
        frontend: `http://127.0.0.1:${FRONTEND_PORT}/?front=robinfund`,
        graphql: `http://127.0.0.1:${INDEXER_PORT}/graphql`,
        indexerReady: `http://127.0.0.1:${INDEXER_PORT}/ready`,
      },
      keeperIntervalSeconds: 60,
      pgliteDir,
    }, null, 2));
  } catch (error) {
    const safe = Object.fromEntries([...logs.entries()].map(([name, value]) => [name, value.replaceAll(rpcUrl, "[REDACTED_RPC]")]));
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), logs: safe }, null, 2));
    stop();
    process.exit(1);
  }

  while (!stopping) await sleep(1_000);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

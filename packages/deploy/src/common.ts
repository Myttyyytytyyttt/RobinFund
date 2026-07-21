import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
export const deployDir = resolve(here, "..");
export const rootDir = resolve(deployDir, "../..");
export const contractsDir = resolve(rootDir, "packages/contracts");
export const ESTIMATED_TESTNET_DEPLOY_GAS = 31_000_000n;
export const MIN_TESTNET_BALANCE_FLOOR_WEI = 5_000_000_000_000_000n;
const TESTNET_GAS_BUFFER_MULTIPLIER = 4n;

export function requiredTestnetBalanceWei(gasPrice: bigint): bigint {
  const bufferedEstimate = ESTIMATED_TESTNET_DEPLOY_GAS * gasPrice * TESTNET_GAS_BUFFER_MULTIPLIER;
  return bufferedEstimate > MIN_TESTNET_BALANCE_FLOOR_WEI
    ? bufferedEstimate
    : MIN_TESTNET_BALANCE_FLOOR_WEI;
}

const DEPLOY_ENV_KEYS = new Set([
  "RH_RPC_TESTNET",
  "TESTNET_DEPLOYER_PK",
  "DEPLOYER_PK",
  "TESTNET_ASSET_ADMIN",
  "GUARDIAN_MULTISIG",
  "GUARDIAN_DELAY",
  "TESTNET_FUND_MANAGER",
  "TESTNET_KEEPER_ADDRESS",
  "TESTNET_PROTOCOL_TREASURY",
  "TESTNET_FUND_NAME",
  "TESTNET_FUND_SYMBOL",
  "FORGE_SCRIPT_TIMEOUT_MS",
]);

export function loadRootEnv(): void {
  const path = resolve(rootDir, ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!DEPLOY_ENV_KEYS.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requirePrivateKey(value: string | undefined, name: string): Hex {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} falta o no es una private key hexadecimal de 32 bytes`);
  }
  return value as Hex;
}

export interface CreateTx {
  transactionType: string;
  contractName?: string;
  contractAddress?: Address;
}

export function broadcastCreates(script: string, chainId: number): CreateTx[] {
  const path = resolve(contractsDir, `broadcast/${script}/${chainId}/run-latest.json`);
  const json = JSON.parse(readFileSync(path, "utf8")) as { transactions: CreateTx[] };
  return json.transactions.filter(
    (tx) => tx.transactionType === "CREATE" && tx.contractName && tx.contractAddress,
  );
}

export function onlyCreate(creates: CreateTx[], name: string): Address {
  const values = creates.filter((tx) => tx.contractName === name).map((tx) => tx.contractAddress!);
  if (values.length !== 1) throw new Error(`esperaba un CREATE ${name}; encontrados ${values.length}`);
  return values[0]!;
}

export function orderedCreates(creates: CreateTx[], name: string, count: number): Address[] {
  const values = creates.filter((tx) => tx.contractName === name).map((tx) => tx.contractAddress!);
  if (values.length !== count) throw new Error(`esperaba ${count} CREATE ${name}; encontrados ${values.length}`);
  return values;
}

export async function runForge(
  script: string,
  rpcTarget: string,
  deployerPk: Hex,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const timeoutMs = Number(process.env.FORGE_SCRIPT_TIMEOUT_MS ?? "600000");
  const child = spawn(
    "forge",
    [
      "script",
      script,
      "--rpc-url",
      rpcTarget,
      "--broadcast",
      "--slow",
      "--non-interactive",
      "--timeout",
      "120",
      "--color",
      "never",
    ],
    {
      cwd: contractsDir,
      env: { ...process.env, DEPLOYER_PK: deployerPk, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  }).finally(() => clearTimeout(timer));

  if (timedOut) throw new Error(`forge ${script} excedió ${timeoutMs} ms`);
  if (code !== 0) throw new Error(`forge ${script} terminó con exit code ${code}`);
  return output;
}

export interface AssetManifest {
  implementation: Address;
  accessRegistry: Address;
  usdg: Address;
  usdgFeed: Address;
  tsla: Address;
  tslaFeed: Address;
  nvda: Address;
  nvdaFeed: Address;
  aapl: Address;
  aaplFeed: Address;
  msft: Address;
  msftFeed: Address;
  spy: Address;
  spyFeed: Address;
  venue: Address;
  adapter: Address;
}

export function readAssetManifest(chainId: number): AssetManifest {
  const creates = broadcastCreates("DeployTestnetAssets.s.sol", chainId);
  const stocks = orderedCreates(creates, "TestnetStockToken", 5);
  const feeds = orderedCreates(creates, "TestnetPriceFeed", 6);
  return {
    implementation: onlyCreate(creates, "TestnetStockImplementationMarker"),
    accessRegistry: onlyCreate(creates, "TestnetAccessRegistry"),
    usdg: onlyCreate(creates, "TestnetUSDG"),
    usdgFeed: feeds[0]!,
    tsla: stocks[0]!,
    tslaFeed: feeds[1]!,
    nvda: stocks[1]!,
    nvdaFeed: feeds[2]!,
    aapl: stocks[2]!,
    aaplFeed: feeds[3]!,
    msft: stocks[3]!,
    msftFeed: feeds[4]!,
    spy: stocks[4]!,
    spyFeed: feeds[5]!,
    venue: onlyCreate(creates, "TestnetLiquidityVenue"),
    adapter: onlyCreate(creates, "TestnetTradeAdapter"),
  };
}

export function assetEnv(a: AssetManifest): Record<string, string> {
  return {
    TESTNET_IMPLEMENTATION: a.implementation,
    TESTNET_ACCESS_REGISTRY: a.accessRegistry,
    TEST_USDG: a.usdg,
    TEST_USDG_FEED: a.usdgFeed,
    TEST_TSLA: a.tsla,
    TEST_TSLA_FEED: a.tslaFeed,
    TEST_NVDA: a.nvda,
    TEST_NVDA_FEED: a.nvdaFeed,
    TEST_AAPL: a.aapl,
    TEST_AAPL_FEED: a.aaplFeed,
    TEST_MSFT: a.msft,
    TEST_MSFT_FEED: a.msftFeed,
    TEST_SPY: a.spy,
    TEST_SPY_FEED: a.spyFeed,
    TEST_LIQUIDITY_VENUE: a.venue,
    TEST_TRADE_ADAPTER: a.adapter,
  };
}

export interface ProtocolManifest {
  tokenRegistry: Address;
  adapterRegistry: Address;
  eligibilityGate: Address;
  guardian: Address;
  fundRegistry: Address;
}

export function readProtocolManifest(chainId: number): ProtocolManifest {
  const creates = broadcastCreates("DeployTestnetProtocol.s.sol", chainId);
  return {
    tokenRegistry: onlyCreate(creates, "TokenRegistry"),
    adapterRegistry: onlyCreate(creates, "AdapterRegistry"),
    eligibilityGate: onlyCreate(creates, "OpenEligibilityGate"),
    guardian: onlyCreate(creates, "Guardian"),
    fundRegistry: onlyCreate(creates, "FundRegistry"),
  };
}

export function protocolEnv(p: ProtocolManifest): Record<string, string> {
  return {
    TOKEN_REGISTRY: p.tokenRegistry,
    ADAPTER_REGISTRY: p.adapterRegistry,
    ELIGIBILITY_GATE: p.eligibilityGate,
    GUARDIAN: p.guardian,
    FUND_REGISTRY: p.fundRegistry,
  };
}

/**
 * E2E del indexer: anvil forkeando mainnet → protocolo desplegado con los scripts REALES →
 * ciclo de vida LP completo (depósito → settlement 30d → retiro) → `ponder start` indexa el
 * historial → asserts sobre la API GraphQL que consumirá el frontend.
 *
 * Mismo harness que el E2E del keeper (la única pieza mock: el feed USDG, porque un fork no
 * publica rondas nuevas y el forward pricing exige ronda posterior a cada solicitud).
 *
 * Correr:  pnpm test:e2e   (necesita RH_RPC_MAINNET en el .env raíz + foundry en PATH)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  numberToHex,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(here, "../../../.env");
try {
  for (const raw of readFileSync(rootEnvPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    if (process.env[k] === undefined) process.env[k] = line.slice(eq + 1).trim();
  }
} catch {
  /* sin .env raíz */
}

const RUN = process.env.INDEXER_E2E === "1" && !!process.env.RH_RPC_MAINNET;

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;

const PK = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0 deployer
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1 compliance signer
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 2 keeper
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // 3 manager
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // 4 LP
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // 5 treasury
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // 6 multisig
] as const;
const acct = PK.map((pk) => privateKeyToAccount(pk as Hex));

const contractsDir = resolve(here, "../../contracts");
const indexerDir = resolve(here, "..");
const ANVIL_PORT = 8545 + ((process.pid + 321) % 1000);
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const PONDER_PORT = 42100 + (process.pid % 500);
const PONDER_URL = `http://127.0.0.1:${PONDER_PORT}`;

const fundAbi = parseAbi([
  "function share() view returns (address)",
  "function stakeEscrow() view returns (address)",
  "function requestDeposit(uint256 amount6) returns (uint256)",
  "function requestWithdraw(uint256 shares_, bool inKind) returns (uint256)",
  "function executeBatch(uint256 grossClaimsWad)",
  "function settlementDue() view returns (uint48)",
]);
const registryViewAbi = parseAbi([
  "function funds(uint256) view returns (address)",
  "function setUsdgFeed(address feed, uint48 maxStaleness, int256 minAnswer, int256 maxAnswer)",
]);
const gateAbi = parseAbi([
  "function nonceOf(address) view returns (uint256)",
  "function attest(address account, uint48 expiry, uint256 nonce, bytes signature)",
]);
const shareAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const stakeAbi = parseAbi(["function addStake(uint256 amount)"]);
const mockFeedAbi = [
  { type: "constructor", stateMutability: "nonpayable", inputs: [{ name: "a", type: "int256" }] },
  {
    type: "function",
    name: "set",
    stateMutability: "nonpayable",
    inputs: [
      { name: "a", type: "int256" },
      { name: "ts", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

let anvil: ChildProcess | null = null;
let ponderProc: ChildProcess | null = null;
let ponderLog = "";
let pgliteDir = "";
let chain: Chain;
let pub: PublicClient;
let testClient: TestClient;
let wallets: WalletClient[];
let addrs: Record<string, Address>;
let fundAddr: Address;
let shareAddr: Address;
let mockFeed: Address;
let startBlock = 0n;

function forge(script: string, extraEnv: Record<string, string>): void {
  const res = spawnSync(
    "forge",
    ["script", script, "--rpc-url", ANVIL_URL, "--broadcast", "--private-key", PK[0]],
    { cwd: contractsDir, env: { ...process.env, ...extraEnv }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.status !== 0) throw new Error(`forge ${script} falló:\n${res.stdout}\n${res.stderr}`);
}

function parseBroadcast(script: string, chainId: number): Record<string, Address> {
  const p = resolve(contractsDir, `broadcast/${script}/${chainId}/run-latest.json`);
  const j = JSON.parse(readFileSync(p, "utf8")) as {
    transactions: { transactionType: string; contractName?: string; contractAddress?: string }[];
  };
  const out: Record<string, Address> = {};
  for (const tx of j.transactions) {
    if (tx.transactionType === "CREATE" && tx.contractName && tx.contractAddress) {
      out[tx.contractName] = tx.contractAddress as Address;
    }
  }
  return out;
}

async function dealErc20(token: Address, to: Address, amount: bigint): Promise<void> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [to] });
  const res = (await pub.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "eth_createAccessList" as any,
    params: [{ to: token, data }, "latest"] as never,
  })) as { accessList: { address: Address; storageKeys: Hex[] }[] };
  const keys = res.accessList
    .filter((e) => e.address.toLowerCase() === token.toLowerCase())
    .flatMap((e) => e.storageKeys);
  for (const key of keys) {
    const prev = await pub.getStorageAt({ address: token, slot: key });
    await testClient.setStorageAt({ address: token, index: key, value: numberToHex(amount, { size: 32 }) });
    let bal: bigint | null = null;
    try {
      bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [to] });
    } catch {
      bal = null;
    }
    if (bal === amount) return;
    await testClient.setStorageAt({ address: token, index: key, value: (prev ?? numberToHex(0, { size: 32 })) as Hex });
  }
  throw new Error("no encontré el slot de balances de USDG");
}

async function write(who: number, address: Address, abi: unknown, functionName: string, args: unknown[]): Promise<void> {
  const w = wallets[who]!;
  const hash = await w.writeContract({ address, abi, functionName, args, account: w.account!, chain } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} revirtió`);
}

async function now(): Promise<bigint> {
  return (await pub.getBlock()).timestamp;
}

async function feedRoundAndWarp(feedTs: bigint, target: bigint): Promise<void> {
  await write(0, mockFeed, mockFeedAbi, "set", [100000000n, feedTs]);
  await testClient.setNextBlockTimestamp({ timestamp: target });
  await testClient.mine({ blocks: 1 });
}

async function gql(query: string): Promise<any> {
  const res = await fetch(`${PONDER_URL}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = (await res.json()) as { data?: unknown; errors?: unknown };
  if (j.errors) throw new Error(`GraphQL: ${JSON.stringify(j.errors)}`);
  return j.data;
}

beforeAll(async () => {
  if (!RUN) return;

  // ---- anvil fork + protocolo (mismo harness que el E2E del keeper) ----
  anvil = spawn("anvil", ["--fork-url", process.env.RH_RPC_MAINNET!, "--port", String(ANVIL_PORT)], {
    stdio: "ignore",
  });
  const probe = createPublicClient({ transport: http(ANVIL_URL) });
  let chainId = 0;
  for (let i = 0; i < 120; i++) {
    try {
      chainId = await probe.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!chainId) throw new Error("anvil no arrancó");

  chain = defineChain({
    id: chainId,
    name: "rh-anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_URL] } },
  });
  pub = createPublicClient({ chain, transport: http(ANVIL_URL) });
  testClient = createTestClient({ mode: "anvil", chain, transport: http(ANVIL_URL) });
  wallets = acct.map((a) => createWalletClient({ account: a, chain, transport: http(ANVIL_URL) }));

  startBlock = await pub.getBlockNumber();
  forge("script/Deploy.s.sol", {
    COMPLIANCE_SIGNER: acct[1]!.address,
    GUARDIAN_MULTISIG: acct[6]!.address,
    KEEPER: acct[2]!.address,
    PROTOCOL_TREASURY: acct[5]!.address,
  });
  addrs = parseBroadcast("Deploy.s.sol", chainId);

  // feed USDG → mock (fork estático: sin rondas nuevas no hay forward pricing)
  const artifact = JSON.parse(
    readFileSync(resolve(contractsDir, "out/Mocks.sol/MockFeed.json"), "utf8"),
  ) as { bytecode: { object: Hex } };
  const deployHash = await wallets[0]!.deployContract({
    abi: mockFeedAbi,
    bytecode: artifact.bytecode.object,
    args: [100000000n],
    account: acct[0]!,
    chain,
  });
  mockFeed = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;
  await write(0, addrs.TokenRegistry!, registryViewAbi, "setUsdgFeed", [mockFeed, 90000, 90000000n, 110000000n]);

  // atestaciones manager + LP
  const expiry = Number((await now()) + BigInt(85 * 24 * 3600));
  for (const who of [acct[3]!, acct[4]!]) {
    const nonce = await pub.readContract({
      address: addrs.EligibilityGate!,
      abi: gateAbi,
      functionName: "nonceOf",
      args: [who.address],
    });
    const signature = await acct[1]!.signTypedData({
      domain: { name: "RobinFund EligibilityGate", version: "1", chainId, verifyingContract: addrs.EligibilityGate! },
      types: {
        Attestation: [
          { name: "account", type: "address" },
          { name: "expiry", type: "uint48" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "Attestation",
      message: { account: who.address, expiry, nonce },
    });
    await write(0, addrs.EligibilityGate!, gateAbi, "attest", [who.address, expiry, nonce, signature]);
  }

  forge("script/CreateFund.s.sol", {
    TOKEN_REGISTRY: addrs.TokenRegistry!,
    ADAPTER_REGISTRY: addrs.AdapterRegistry!,
    ELIGIBILITY_GATE: addrs.EligibilityGate!,
    FUND_REGISTRY: addrs.FundRegistry!,
    GUARDIAN: addrs.Guardian!,
    FUND_MANAGER: acct[3]!.address,
    KEEPER: acct[2]!.address,
    PROTOCOL_TREASURY: acct[5]!.address,
    FUND_NAME: "Fondo E2E Indexer",
    FUND_SYMBOL: "IDX",
  });
  fundAddr = (await pub.readContract({
    address: addrs.FundRegistry!,
    abi: registryViewAbi,
    functionName: "funds",
    args: [0n],
  })) as Address;
  shareAddr = (await pub.readContract({ address: fundAddr, abi: fundAbi, functionName: "share" })) as Address;
  const stakeEscrowAddr = (await pub.readContract({
    address: fundAddr,
    abi: fundAbi,
    functionName: "stakeEscrow",
  })) as Address;

  // ---- ciclo de vida completo: depósito → settlement → retiro ----
  await dealErc20(USDG, acct[3]!.address, 20_000_000000n);
  await dealErc20(USDG, acct[4]!.address, 10_000_000000n);
  await write(3, USDG, erc20Abi, "approve", [stakeEscrowAddr, 5_000_000000n]);
  await write(3, stakeEscrowAddr, stakeAbi, "addStake", [5_000_000000n]);

  await write(4, USDG, erc20Abi, "approve", [fundAddr, 10_000_000000n]);
  await write(4, fundAddr, fundAbi, "requestDeposit", [1_000_000000n]);
  const t1 = await now();
  await feedRoundAndWarp(t1 + 900n, t1 + 1300n);
  await write(2, fundAddr, fundAbi, "executeBatch", [0n]);

  const due = BigInt(
    (await pub.readContract({ address: fundAddr, abi: fundAbi, functionName: "settlementDue" })) as bigint | number,
  );
  await feedRoundAndWarp(due + 1800n, due + 3600n);
  await write(2, fundAddr, fundAbi, "executeBatch", [0n]);

  const shares = (await pub.readContract({
    address: shareAddr,
    abi: shareAbi,
    functionName: "balanceOf",
    args: [acct[4]!.address],
  })) as bigint;
  await write(4, fundAddr, fundAbi, "requestWithdraw", [shares, false]);
  const t2 = await now();
  await feedRoundAndWarp(t2 + 86400n + 600n, t2 + 86400n + 1200n);
  await write(2, fundAddr, fundAbi, "executeBatch", [0n]);

  // enterrar los eventos bajo la ventana de finality de Ponder: el backfill histórico solo cubre
  // bloques finalizados, y todo nuestro ciclo vive en los últimos ~40 bloques del fork
  await testClient.mine({ blocks: 256 });

  // ---- ponder start: backfill del historial completo ----
  pgliteDir = mkdtempSync(join(tmpdir(), "ponder-e2e-"));
  ponderProc = spawn(
    "node",
    [
      "node_modules/ponder/dist/esm/bin/ponder.js",
      "start",
      "--schema",
      "public",
      "--port",
      String(PONDER_PORT),
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: indexerDir,
      env: {
        ...process.env,
        INDEXER_RPC_URL: ANVIL_URL,
        INDEXER_CHAIN_ID: String(chainId),
        FUND_REGISTRY: addrs.FundRegistry!,
        ELIGIBILITY_GATE: addrs.EligibilityGate!,
        INDEXER_START_BLOCK: String(startBlock),
        PONDER_PGLITE_DIR: pgliteDir,
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  ponderProc.stdout!.on("data", (d: Buffer) => (ponderLog = (ponderLog + d.toString()).slice(-8000)));
  ponderProc.stderr!.on("data", (d: Buffer) => (ponderLog = (ponderLog + d.toString()).slice(-8000)));

  let ready = false;
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(`${PONDER_URL}/ready`);
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* aún no */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error(`ponder no llegó a /ready:\n${ponderLog}`);

  // esperar a que el fondo esté visible (por si parte del rango cayó al indexado realtime)
  let indexed = false;
  for (let i = 0; i < 120; i++) {
    try {
      const data = await gql(`{ funds { items { address } } }`);
      if (data.funds.items.length > 0) {
        indexed = true;
        break;
      }
    } catch {
      /* aún migrando */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!indexed) throw new Error(`ponder ready pero sin datos indexados:\n${ponderLog}`);
}, 420_000);

afterAll(() => {
  ponderProc?.kill();
  anvil?.kill();
  if (pgliteDir) rmSync(pgliteDir, { recursive: true, force: true });
});

describe.skipIf(!RUN)("E2E: indexer Ponder sobre el protocolo real", () => {
  it("el fondo está indexado con metadatos y agregados correctos", async () => {
    const data = await gql(`{ funds { items {
      address manager name symbol state frozen currentPeriod totalShares lpCount
      lifetimeDeposited6 lifetimeWithdrawn6 lastPeWad lastPePostFeeWad feeSplitter
    } } }`);
    expect(data.funds.items).toHaveLength(1);
    const f = data.funds.items[0];
    expect(f.address.toLowerCase()).toBe(fundAddr.toLowerCase());
    expect(f.manager.toLowerCase()).toBe(acct[3]!.address.toLowerCase());
    expect(f.name).toBe("Fondo E2E Indexer");
    expect(f.symbol).toBe("IDX");
    expect(f.state).toBe(0);
    expect(f.frozen).toBe(false);
    expect(BigInt(f.currentPeriod)).toBe(2n); // un settlement ejecutado
    expect(BigInt(f.lifetimeDeposited6)).toBe(1_000_000000n);
    expect(BigInt(f.lifetimeWithdrawn6)).toBeGreaterThan(990_000000n);
    expect(f.lpCount).toBe(0); // el LP salió entero
    expect(f.lastPeWad).not.toBeNull();
    // el precio para TVL (post perf fee) existe y no supera al de la marca
    expect(f.lastPePostFeeWad).not.toBeNull();
    expect(BigInt(f.lastPePostFeeWad)).toBeLessThanOrEqual(BigInt(f.lastPeWad));
    expect(f.feeSplitter).toMatch(/^0x/);
  });

  it("depósito: requested → executed con shares, fee y la tx de ejecución enlazada", async () => {
    const data = await gql(`{ deposits { items { orderId lp amount6 status sharesMinted fee6 txHash executedTxHash } } }`);
    expect(data.deposits.items).toHaveLength(1);
    const d = data.deposits.items[0];
    expect(d.status).toBe("executed");
    expect(d.lp.toLowerCase()).toBe(acct[4]!.address.toLowerCase());
    expect(BigInt(d.amount6)).toBe(1_000_000000n);
    expect(BigInt(d.sharesMinted)).toBeGreaterThan(0n);
    expect(d.executedTxHash).toMatch(/^0x/);
    expect(d.executedTxHash).not.toBe(d.txHash); // solicitud y batch son tx distintas
  });

  it("retiro: executed con el cash pagado", async () => {
    const data = await gql(`{ withdrawals { items { lp shares inKind status paid6 } } }`);
    expect(data.withdrawals.items).toHaveLength(1);
    const w = data.withdrawals.items[0];
    expect(w.status).toBe("executed");
    expect(w.inKind).toBe(false);
    expect(BigInt(w.paid6)).toBeGreaterThan(990_000000n);
  });

  it("settlement: la serie de precios tiene el período con Pe > 0 y funding 0 (sin pérdida)", async () => {
    const data = await gql(`{ settlements { items { period peWad fundingWad lambdaWad degraded } } }`);
    expect(data.settlements.items).toHaveLength(1);
    const s = data.settlements.items[0];
    expect(BigInt(s.period)).toBe(1n);
    expect(BigInt(s.peWad)).toBeGreaterThan(0n);
    expect(BigInt(s.fundingWad)).toBe(0n);
    expect(s.degraded).toBe(false);
  });

  it("posición del LP: shares 0 tras salir, con deposited/withdrawn acumulados", async () => {
    const data = await gql(`{ lpPositions { items { lp shares deposited6 withdrawn6 } } }`);
    expect(data.lpPositions.items).toHaveLength(1);
    const p = data.lpPositions.items[0];
    expect(p.lp.toLowerCase()).toBe(acct[4]!.address.toLowerCase());
    expect(BigInt(p.shares)).toBe(0n);
    expect(BigInt(p.deposited6)).toBe(1_000_000000n);
    expect(BigInt(p.withdrawn6)).toBeGreaterThan(990_000000n);
  });

  it("atestaciones del gate indexadas (manager + LP activas)", async () => {
    const data = await gql(`{ attestations { items { account revokedAt } } }`);
    const accounts = data.attestations.items.map((a: any) => a.account.toLowerCase());
    expect(accounts).toContain(acct[3]!.address.toLowerCase());
    expect(accounts).toContain(acct[4]!.address.toLowerCase());
    for (const a of data.attestations.items) expect(BigInt(a.revokedAt)).toBe(0n);
  });

  it("el feed de actividad tiene el ciclo completo en orden", async () => {
    const data = await gql(`{ activitys(orderBy: "timestamp", orderDirection: "asc") { items { kind } } }`);
    const kinds = data.activitys.items.map((a: any) => a.kind);
    for (const k of ["deposit_requested", "deposit_executed", "settled", "withdraw_requested", "withdraw_executed"]) {
      expect(kinds).toContain(k);
    }
    expect(kinds.indexOf("deposit_requested")).toBeLessThan(kinds.indexOf("deposit_executed"));
    expect(kinds.indexOf("deposit_executed")).toBeLessThan(kinds.indexOf("settled"));
    expect(kinds.indexOf("settled")).toBeLessThan(kinds.indexOf("withdraw_executed"));
  });
});

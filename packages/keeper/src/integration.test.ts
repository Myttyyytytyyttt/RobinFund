/**
 * Test de integración END-TO-END contra un anvil que forkea mainnet 4663:
 *
 *   anvil (fork) → forge script Deploy.s.sol → CreateFund.s.sol → LP deposita →
 *   runner del keeper ejecuta el batch → warp 30d → runner settlea →
 *   LP retira → runner ejecuta el retiro.
 *
 * Es el cierre del bucle: los MISMOS scripts de deploy que irán a mainnet + el MISMO runner
 * que operará en producción, contra el estado real de la chain (USDG real, access registry real).
 *
 * Única pieza sustituida: el feed USDG/USD se apunta a un MockFeed vía la API pública
 * (`setUsdgFeed`, el deployer aún es owner — la transferencia al Guardian es two-step). En un fork
 * los feeds Chainlink son ESTÁTICOS: sin rondas nuevas, el forward pricing (§5) no ejecutaría
 * ninguna orden jamás. El mock nos deja publicar rondas frescas al warpear el tiempo.
 *
 * Correr:  pnpm test:e2e   (necesita RH_RPC_MAINNET en el .env raíz + foundry en PATH)
 * Gateado con KEEPER_E2E=1 para no colarse en el `pnpm test` rápido.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadRootEnv } from "./env.js";
import { fundAbi, shareAbi, stakeEscrowAbi, fundRegistryAbi } from "./abi.js";
import { runTick, type KeeperConfig, type FundReport } from "./runner.js";
import { assessFund } from "./settlement.js";
import { checkFundBlocked } from "./monitors.js";

loadRootEnv();
const RUN = process.env.KEEPER_E2E === "1" && !!process.env.RH_RPC_MAINNET;

// ---------- direcciones reales (AddressBook.sol) ----------
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const ACCESS_REGISTRY = "0xe10b6f6B275de231345c20D14Ab812db62151b00" as Address;

// ---------- cuentas anvil (mnemonic de test estándar) ----------
const PK = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0 deployer/operador
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1 auxiliar
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 2 keeper
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // 3 manager
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // 4 LP
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // 5 treasury
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // 6 multisig
] as const;
const acct = PK.map((pk) => privateKeyToAccount(pk as Hex));

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, "../../contracts");
const PORT = 8545 + (process.pid % 1000);
const ANVIL_URL = `http://127.0.0.1:${PORT}`;

// ABI solo-test: funciones de LP/manager que el keeper nunca llama
const lpAbi = [
  {
    type: "function",
    name: "requestDeposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount6", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "requestWithdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares_", type: "uint256" },
      { name: "inKind", type: "bool" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

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

const registryAbi = [
  {
    type: "function",
    name: "setUsdgFeed",
    stateMutability: "nonpayable",
    inputs: [
      { name: "feed", type: "address" },
      { name: "maxStaleness", type: "uint48" },
      { name: "minAnswer", type: "int256" },
      { name: "maxAnswer", type: "int256" },
    ],
    outputs: [],
  },
] as const;

// ---------- estado compartido entre pasos ----------
let anvil: ChildProcess | null = null;
let anvilLog = "";
let chain: Chain;
let pub: PublicClient;
let test: TestClient;
let wallets: WalletClient[];
let addrs: Record<string, Address>; // contratos del Deploy
let fund: Address;
let stakeEscrowAddr: Address;
let shareAddr: Address;
let mockFeed: Address;
let protocolDeployBlock = 0n;
let cfg: KeeperConfig;

const keeperWallet = (): WalletClient => wallets[2]!;

// ---------- helpers ----------

function forge(script: string, extraEnv: Record<string, string>): void {
  const args = [
    "script",
    script,
    "--rpc-url",
    ANVIL_URL,
    "--broadcast",
    "--slow",
    "--non-interactive",
    "--timeout",
    "120",
    "--color",
    "never",
  ];
  const res = spawnSync("forge", args, {
    cwd: contractsDir,
    env: { ...process.env, DEPLOYER_PK: PK[0], ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`forge ${args[0]} falló (${res.status}):\n${res.stdout}\n${res.stderr}`);
  }
}

/** Parsea el broadcast run-latest.json → { contractName: address } de las tx CREATE. */
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

/**
 * Deal de un ERC-20 en anvil: eth_createAccessList sobre balanceOf(to) revela los slots que la
 * lectura toca (funciona con proxies y cualquier layout); probamos cada uno hasta que balanceOf
 * devuelva el valor, restaurando los que no eran.
 */
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
    await test.setStorageAt({ address: token, index: key, value: numberToHex(amount, { size: 32 }) });
    // si tocamos un slot estructural (p.ej. el de implementación del proxy), balanceOf puede
    // romperse por completo — tratar cualquier error como "no era este" y RESTAURAR SIEMPRE
    let bal: bigint | null = null;
    try {
      bal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [to] });
    } catch {
      bal = null;
    }
    if (bal === amount) return;
    await test.setStorageAt({ address: token, index: key, value: (prev ?? numberToHex(0, { size: 32 })) as Hex });
  }
  throw new Error(`no encontré el slot de balances de ${token} (accessList: ${keys.length} keys)`);
}

async function now(): Promise<bigint> {
  return (await pub.getBlock()).timestamp;
}

/** Publica ronda fresca del feed y avanza el reloj de la chain a `target`. */
async function feedRoundAndWarp(feedTs: bigint, target: bigint): Promise<void> {
  await write(0, mockFeed, mockFeedAbi, "set", [100000000n, feedTs]);
  await test.setNextBlockTimestamp({ timestamp: target });
  await test.mine({ blocks: 1 });
}

async function write(
  who: number,
  address: Address,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abi: any,
  functionName: string,
  args: unknown[],
): Promise<void> {
  const w = wallets[who]!;
  const hash = await w.writeContract({
    address,
    abi,
    functionName,
    args,
    account: w.account!,
    chain,
  } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} revirtió (${hash})`);
}

async function tick(): Promise<FundReport> {
  const reports = await runTick(pub, keeperWallet(), cfg);
  expect(reports).toHaveLength(1);
  return reports[0]!;
}

// ---------- setup ----------

beforeAll(async () => {
  if (!RUN) return;

  // 1. anvil forkeando mainnet
  anvil = spawn("anvil", ["--fork-url", process.env.RH_RPC_MAINNET!, "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  anvil.stdout!.on("data", (d: Buffer) => (anvilLog = (anvilLog + d.toString()).slice(-4000)));
  anvil.stderr!.on("data", (d: Buffer) => (anvilLog = (anvilLog + d.toString()).slice(-4000)));

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
  if (!chainId) throw new Error(`anvil no arrancó en ${ANVIL_URL}:\n${anvilLog}`);

  chain = defineChain({
    id: chainId,
    name: "rh-anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_URL] } },
  });
  pub = createPublicClient({ chain, transport: http(ANVIL_URL) });
  test = createTestClient({ mode: "anvil", chain, transport: http(ANVIL_URL) });
  wallets = acct.map((a) => createWalletClient({ account: a, chain, transport: http(ANVIL_URL) }));

  // 2. deploy del protocolo con el script REAL
  protocolDeployBlock = await pub.getBlockNumber();
  forge(
    "script/Deploy.s.sol",
    {
      GUARDIAN_MULTISIG: acct[6]!.address,
    },
  );
  addrs = parseBroadcast("Deploy.s.sol", chainId);
  for (const name of ["TokenRegistry", "AdapterRegistry", "OpenEligibilityGate", "Guardian", "FundRegistry"]) {
    if (!addrs[name]) throw new Error(`el broadcast del Deploy no contiene ${name}`);
  }

  // 3. feed USDG → MockFeed (los feeds de un fork no publican rondas; ver cabecera).
  //    El deployer AÚN es owner del TokenRegistry (transferencia al Guardian es two-step).
  const artifact = JSON.parse(
    readFileSync(resolve(contractsDir, "out/Mocks.sol/MockFeed.json"), "utf8"),
  ) as { bytecode: { object: Hex } };
  const deployHash = await wallets[0]!.deployContract({
    abi: mockFeedAbi,
    bytecode: artifact.bytecode.object,
    args: [100000000n], // $1.00000000
    account: acct[0]!,
    chain,
  });
  const rec = await pub.waitForTransactionReceipt({ hash: deployHash });
  mockFeed = rec.contractAddress!;
  await write(0, addrs.TokenRegistry!, registryAbi, "setUsdgFeed", [mockFeed, 90000, 90000000n, 110000000n]);

  // 4. crear el fondo con el script REAL del operador. Manager y LP entran sin onboarding.
  forge(
    "script/CreateFund.s.sol",
    {
      TOKEN_REGISTRY: addrs.TokenRegistry!,
      ADAPTER_REGISTRY: addrs.AdapterRegistry!,
      ELIGIBILITY_GATE: addrs.OpenEligibilityGate!,
      FUND_REGISTRY: addrs.FundRegistry!,
      GUARDIAN: addrs.Guardian!,
      FUND_MANAGER: acct[3]!.address,
      KEEPER: acct[2]!.address,
      PROTOCOL_TREASURY: acct[5]!.address,
      FUND_NAME: "Fondo E2E",
      FUND_SYMBOL: "E2E",
    },
  );
  fund = (await pub.readContract({
    address: addrs.FundRegistry!,
    abi: fundRegistryAbi,
    functionName: "funds",
    args: [0n],
  })) as Address;
  shareAddr = (await pub.readContract({ address: fund, abi: fundAbi, functionName: "share" })) as Address;
  stakeEscrowAddr = (await pub.readContract({ address: fund, abi: fundAbi, functionName: "stakeEscrow" })) as Address;

  // 6. USDG para manager y LP + stake del manager
  await dealErc20(USDG, acct[3]!.address, 20_000_000000n);
  await dealErc20(USDG, acct[4]!.address, 10_000_000000n);
  await write(3, USDG, erc20Abi, "approve", [stakeEscrowAddr, 5_000_000000n]);
  await write(3, stakeEscrowAddr, stakeEscrowAbi, "addStake", [5_000_000000n]);

  cfg = {
    fundRegistry: addrs.FundRegistry!,
    accessRegistry: ACCESS_REGISTRY,
    fromBlock: protocolDeployBlock,
    send: true,
  };
}, 300_000);

afterAll(() => {
  anvil?.kill();
});

// ---------- el ciclo de vida completo ----------

describe.skipIf(!RUN)("E2E contra anvil: protocolo desplegado + runner del keeper", () => {
  it(
    "el LP deposita y el runner ejecuta el batch (forward pricing)",
    async () => {
      await write(4, USDG, erc20Abi, "approve", [fund, 10_000_000000n]);
      await write(4, fund, lpAbi, "requestDeposit", [1_000_000000n]);
      const t1 = await now();

      // aún sin ronda posterior: el runner ve la cola pero el batch no ejecuta nada útil todavía;
      // publicamos ronda fresca (t1+15min) y pasamos la latencia mínima de cola (10min)
      await feedRoundAndWarp(t1 + 900n, t1 + 1300n);

      const report = await tick();
      expect(report.error).toBeUndefined();
      expect(report.intents.map((i) => i.fn)).toContain("executeBatch");
      expect(report.sent.every((s) => s.status === "success")).toBe(true);

      const shares = (await pub.readContract({
        address: shareAddr,
        abi: shareAbi,
        functionName: "balanceOf",
        args: [acct[4]!.address],
      })) as bigint;
      expect(shares).toBeGreaterThan(0n);

      const [dep] = (await pub.readContract({
        address: fund,
        abi: fundAbi,
        functionName: "queueLengths",
      })) as readonly [bigint, bigint];
      expect(dep).toBe(0n);
    },
    120_000,
  );

  it(
    "a los 30 días el runner settlea (grossClaims 0 con precio plano)",
    async () => {
      const periodBefore = (await pub.readContract({
        address: fund,
        abi: fundAbi,
        functionName: "currentPeriod",
      })) as bigint;
      const due = BigInt(
        (await pub.readContract({ address: fund, abi: fundAbi, functionName: "settlementDue" })) as bigint | number,
      );

      await feedRoundAndWarp(due + 1800n, due + 3600n);

      // el grossClaims computado off-chain debe ser 0: nadie está en pérdida con precio plano
      const assess = await assessFund(pub, fund, protocolDeployBlock);
      expect(assess.grossClaimsWad).toBe(0n);
      expect(assess.action.kind).toBe("settle");

      const report = await tick();
      expect(report.error).toBeUndefined();
      expect(report.sent.every((s) => s.status === "success")).toBe(true);

      const periodAfter = (await pub.readContract({
        address: fund,
        abi: fundAbi,
        functionName: "currentPeriod",
      })) as bigint;
      expect(periodAfter).toBe(periodBefore + 1n);
    },
    120_000,
  );

  it(
    "el LP retira cash y el runner ejecuta el batch tras el cooldown",
    async () => {
      const shares = (await pub.readContract({
        address: shareAddr,
        abi: shareAbi,
        functionName: "balanceOf",
        args: [acct[4]!.address],
      })) as bigint;
      await write(4, fund, lpAbi, "requestWithdraw", [shares, false]);
      const t2 = await now();

      // cooldown 24h + ronda fresca posterior a la solicitud
      await feedRoundAndWarp(t2 + 86400n + 600n, t2 + 86400n + 1200n);

      const report = await tick();
      expect(report.error).toBeUndefined();
      expect(report.sent.every((s) => s.status === "success")).toBe(true);

      const balance = (await pub.readContract({
        address: USDG,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [acct[4]!.address],
      })) as bigint;
      // 10_000 iniciales − 1_000 depositados + ~999.x de vuelta (entry fee mínima con u≈0.8%)
      expect(balance).toBeGreaterThan(9_950_000000n);

      const [, wd] = (await pub.readContract({
        address: fund,
        abi: fundAbi,
        functionName: "queueLengths",
      })) as readonly [bigint, bigint];
      expect(wd).toBe(0n);
    },
    120_000,
  );

  it("los monitores leen el estado real: el fondo no está bloqueado por RHJ", async () => {
    expect(await checkFundBlocked(pub, ACCESS_REGISTRY, fund)).toBeNull();
  });
});

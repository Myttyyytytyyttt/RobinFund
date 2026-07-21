import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bytesToHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { runTick, type KeeperConfig } from "../../keeper/src/runner.js";
import {
  assetEnv,
  contractsDir,
  readAssetManifest,
  readProtocolManifest,
  runForge,
  protocolEnv,
  rootDir,
  type AssetManifest,
  type ProtocolManifest,
} from "./common.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const accounts = Array.from({ length: 7 }, (_, i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }));
const [deployer, auxiliary, keeper, manager, lp, treasury, guardian] = accounts as [
  HDAccount,
  HDAccount,
  HDAccount,
  HDAccount,
  HDAccount,
  HDAccount,
  HDAccount,
];
const privateBytes = deployer.getHdKey().privateKey;
if (!privateBytes) throw new Error("la cuenta HD local no contiene private key");
const deployerPk = bytesToHex(privateBytes);

const port = Number(process.env.TESTNET_E2E_ANVIL_PORT ?? 18_550 + (process.pid % 400));
const ponderPort = Number(process.env.TESTNET_E2E_PONDER_PORT ?? 42_500 + (process.pid % 400));
const rpcUrl = `http://127.0.0.1:${port}`;
const ponderUrl = `http://127.0.0.1:${ponderPort}`;

const fundRegistryAbi = parseAbi([
  "function funds(uint256) view returns (address)",
  "function fundCount() view returns (uint256)",
]);
const fundAbi = parseAbi([
  "function share() view returns (address)",
  "function stakeEscrow() view returns (address)",
  "function FEE_SPLITTER() view returns (address)",
  "function GATE() view returns (address)",
  "function requestDeposit(uint256 amount6) returns (uint256)",
  "function requestWithdraw(uint256 shares, bool inKind) returns (uint256)",
  "function execute(uint256 adapterId, address tokenIn, address tokenOut, uint256 amountIn, bytes data)",
  "function requestWinding()",
  "function close()",
  "function finalizeClosure(uint64[] periodsToSweep)",
  "function state() view returns (uint8)",
  "function currentPeriod() view returns (uint64)",
  "function settlementDue() view returns (uint48)",
  "function assetCount() view returns (uint256)",
  "function queueLengths() view returns (uint256 deposits, uint256 withdrawals)",
]);
const stakeAbi = parseAbi([
  "function addStake(uint256 amount)",
  "function stakeAvailable() view returns (uint256)",
]);
const shareAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const feedAbi = parseAbi([
  "function poke()",
  "function setAnswer(int256 value)",
]);
const feeSplitterAbi = parseAbi([
  "function redeem(bool inKind) returns (uint256)",
  "function distributeToken(address token)",
]);
const gateAbi = parseAbi(["function isEligible(address) view returns (bool)"]);
const accessAbi = parseAbi([
  "function setImplementation(address)",
  "function setBlocked(address,bool)",
  "function setPaused(bool)",
]);
const tokenRegistryAbi = parseAbi([
  "function isActive(address) view returns (bool)",
  "function suspendOnBeaconDrift(address)",
]);

let anvil: ChildProcess | null = null;
let ponder: ChildProcess | null = null;
let pgliteDir = "";
let anvilLog = "";
let ponderLog = "";
let chain: Chain;
let publicClient: PublicClient;
let testClient: TestClient;
let wallets: WalletClient[];

async function waitForRpc(): Promise<void> {
  const probe = createPublicClient({ transport: http(rpcUrl) });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await probe.getChainId()) === 46_630) return;
    } catch {
      // Anvil todavía arrancando.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Anvil no arrancó en ${rpcUrl}:\n${anvilLog}`);
}

async function write(
  who: number,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): Promise<Hex> {
  const wallet = wallets[who]!;
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args,
    account: wallet.account!,
    chain,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} revirtió: ${hash}`);
  return hash;
}

async function advance(seconds: number): Promise<void> {
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}

async function pokeFeeds(assets: AssetManifest): Promise<void> {
  for (const feed of [assets.usdgFeed, assets.tslaFeed]) {
    await write(1, feed, feedAbi, "poke");
  }
}

async function keeperTick(protocol: ProtocolManifest, assets: AssetManifest, fromBlock: bigint): Promise<string[]> {
  const cfg: KeeperConfig = {
    fundRegistry: protocol.fundRegistry,
    accessRegistry: assets.accessRegistry,
    fromBlock,
    send: true,
  };
  const reports = await runTick(publicClient, wallets[2]!, cfg);
  if (reports.length !== 1) throw new Error(`keeper esperaba 1 fondo; observó ${reports.length}`);
  const report = reports[0]!;
  if (report.error) throw new Error(`keeper: ${report.error}`);
  if (report.sent.some((tx) => tx.status !== "success")) throw new Error("keeper envió una tx revertida");
  return report.sent.map((tx) => tx.fn);
}

async function gql(query: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${ponderUrl}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown };
  if (json.errors || !json.data) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function startIndexer(protocol: ProtocolManifest, fromBlock: bigint): Promise<void> {
  pgliteDir = mkdtempSync(join(tmpdir(), "nuvem-testnet-e2e-"));
  const indexerDir = resolve(rootDir, "packages/indexer");
  ponder = spawn(
    "node",
    [
      "node_modules/ponder/dist/esm/bin/ponder.js",
      "start",
      "--schema",
      "public",
      "--port",
      String(ponderPort),
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: indexerDir,
      env: {
        ...process.env,
        INDEXER_RPC_URL: rpcUrl,
        INDEXER_CHAIN_ID: "46630",
        FUND_REGISTRY: protocol.fundRegistry,
        INDEXER_START_BLOCK: fromBlock.toString(),
        PONDER_PGLITE_DIR: pgliteDir,
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  ponder.stdout!.on("data", (chunk: Buffer) => (ponderLog = (ponderLog + chunk.toString()).slice(-12_000)));
  ponder.stderr!.on("data", (chunk: Buffer) => (ponderLog = (ponderLog + chunk.toString()).slice(-12_000)));

  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${ponderUrl}/ready`)).status === 200) break;
    } catch {
      // Ponder todavía arrancando.
    }
    if (i === 239) throw new Error(`Ponder no llegó a /ready:\n${ponderLog}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  for (let i = 0; i < 180; i++) {
    try {
      const data = await gql("{ funds { items { address } } }") as {
        funds: { items: Array<{ address: Address }> };
      };
      if (data.funds.items.length === 1) return;
    } catch {
      // Backfill en curso.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Ponder quedó ready sin completar el backfill:\n${ponderLog}`);
}

async function main(): Promise<void> {
  anvil = spawn("anvil", ["--port", String(port), "--chain-id", "46630", "--silent"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  anvil.stdout!.on("data", (chunk: Buffer) => (anvilLog = (anvilLog + chunk.toString()).slice(-8_000)));
  anvil.stderr!.on("data", (chunk: Buffer) => (anvilLog = (anvilLog + chunk.toString()).slice(-8_000)));
  await waitForRpc();

  chain = defineChain({
    id: 46_630,
    name: "NuvemFund local testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  testClient = createTestClient({ mode: "anvil", chain, transport: http(rpcUrl) });
  wallets = accounts.map((account) => createWalletClient({ account, chain, transport: http(rpcUrl) }));
  const startBlock = await publicClient.getBlockNumber();

  console.log("[1/8] deploy TestnetAssetPack");
  await runForge("script/DeployTestnetAssets.s.sol", rpcUrl, deployerPk);
  const assets = readAssetManifest(46_630);

  console.log("[2/8] deploy protocolo permissionless");
  await runForge("script/DeployTestnetProtocol.s.sol", rpcUrl, deployerPk, {
    ...assetEnv(assets),
    GUARDIAN_MULTISIG: guardian.address,
  });
  const protocol = readProtocolManifest(46_630);

  console.log("[3/8] crear fondo canario");
  await runForge("script/CreateFund.s.sol", rpcUrl, deployerPk, {
    ...protocolEnv(protocol),
    FUND_MANAGER: manager.address,
    KEEPER: keeper.address,
    PROTOCOL_TREASURY: treasury.address,
    FUND_NAME: "NuvemFund Testnet Canary",
    FUND_SYMBOL: "NVT",
    PERIOD: String(7 * 24 * 60 * 60),
    COOLDOWN: String(60 * 60),
  });
  const fund = (await publicClient.readContract({
    address: protocol.fundRegistry,
    abi: fundRegistryAbi,
    functionName: "funds",
    args: [0n],
  })) as Address;
  const share = (await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "share" })) as Address;
  const stake = (await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "stakeEscrow" })) as Address;
  const feeSplitter = (await publicClient.readContract({
    address: fund,
    abi: fundAbi,
    functionName: "FEE_SPLITTER",
  })) as Address;

  if (!(await publicClient.readContract({
    address: protocol.eligibilityGate,
    abi: gateAbi,
    functionName: "isEligible",
    args: [lp.address],
  }))) throw new Error("OpenEligibilityGate no aceptó al LP");

  console.log("[4/8] faucet, stake y depósito forward-priced");
  await write(3, assets.usdg, parseAbi(["function faucet() returns (uint256)"]), "faucet");
  await write(4, assets.usdg, parseAbi(["function faucet() returns (uint256)"]), "faucet");
  await write(3, assets.usdg, erc20Abi, "approve", [stake, 10_000e6]);
  await write(3, stake, stakeAbi, "addStake", [10_000e6]);
  await write(4, assets.usdg, erc20Abi, "approve", [fund, 8_000e6]);
  await write(4, fund, fundAbi, "requestDeposit", [8_000e6]);
  await advance(1);
  await pokeFeeds(assets);
  await advance(601);
  const depositActions = await keeperTick(protocol, assets, startBlock);
  if (!depositActions.includes("executeBatch")) throw new Error("keeper no ejecutó el depósito");

  const sharesAfterDeposit = (await publicClient.readContract({
    address: share,
    abi: shareAbi,
    functionName: "balanceOf",
    args: [lp.address],
  })) as bigint;
  if (sharesAfterDeposit <= 0n) throw new Error("el LP no recibió shares");

  console.log("[5/8] compra/venta, ganancia, pérdida y first-loss");
  await write(3, fund, fundAbi, "execute", [0n, assets.usdg, assets.tsla, 1_500e6, "0x"]);
  const stockInFund = (await publicClient.readContract({
    address: assets.tsla,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [fund],
  })) as bigint;
  if (stockInFund <= 0n) throw new Error("el trade no entregó tTSLA al Fund");
  await write(0, assets.tslaFeed, feedAbi, "setAnswer", [330_00000000n]);

  const due = BigInt(await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "settlementDue" }));
  const now = (await publicClient.getBlock()).timestamp;
  await advance(Number(due - now + 1n));
  await pokeFeeds(assets);
  const settlementActions = await keeperTick(protocol, assets, startBlock);
  if (!settlementActions.includes("executeBatch")) throw new Error("keeper no ejecutó el settlement");
  const period = BigInt(await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "currentPeriod" }));
  if (period !== 1n) throw new Error(`currentPeriod inesperado: ${period}`);

  // Venta determinista a $330; el adapter tampoco conserva residuos en la dirección inversa.
  await write(3, fund, fundAbi, "execute", [0n, assets.tsla, assets.usdg, 1e18, "0x"]);
  await write(0, assets.tslaFeed, feedAbi, "setAnswer", [180_00000000n]);
  const stakeBeforeLoss = (await publicClient.readContract({
    address: stake,
    abi: stakeAbi,
    functionName: "stakeAvailable",
  })) as bigint;
  const lossDue = BigInt(await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "settlementDue" }));
  const beforeLoss = (await publicClient.getBlock()).timestamp;
  await advance(Number(lossDue - beforeLoss + 1n));
  await pokeFeeds(assets);
  await keeperTick(protocol, assets, startBlock);
  const stakeAfterLoss = (await publicClient.readContract({
    address: stake,
    abi: stakeAbi,
    functionName: "stakeAvailable",
  })) as bigint;
  if (stakeAfterLoss >= stakeBeforeLoss) throw new Error("la pérdida no activó el first-loss del manager");

  console.log("[6/8] retiro cash y retiro in-kind con slices valorados");
  const lpUsdgBeforeCash = (await publicClient.readContract({
    address: assets.usdg,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [lp.address],
  })) as bigint;
  await write(4, fund, fundAbi, "requestWithdraw", [sharesAfterDeposit / 4n, false]);
  await advance(1);
  await pokeFeeds(assets);
  await advance(3_601);
  const cashActions = await keeperTick(protocol, assets, startBlock);
  if (!cashActions.includes("executeBatch")) throw new Error("keeper no ejecutó el retiro cash");
  const lpUsdgAfterCash = (await publicClient.readContract({
    address: assets.usdg,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [lp.address],
  })) as bigint;
  if (lpUsdgAfterCash <= lpUsdgBeforeCash) throw new Error("el LP no recibió el retiro cash/claim");

  await write(4, fund, fundAbi, "requestWithdraw", [sharesAfterDeposit / 4n, true]);
  await advance(1);
  await pokeFeeds(assets);
  await advance(3_601);
  const inKindActions = await keeperTick(protocol, assets, startBlock);
  if (!inKindActions.includes("executeBatch")) throw new Error("keeper no ejecutó el retiro in-kind");
  const lpStock = (await publicClient.readContract({
    address: assets.tsla,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [lp.address],
  })) as bigint;
  if (lpStock <= 0n) throw new Error("el LP no recibió su slice tTSLA");

  console.log("[7/8] winding, salida total, cierre, pausas y beacon drift");
  await write(3, fund, fundAbi, "requestWinding");
  await pokeFeeds(assets);
  await keeperTick(protocol, assets, startBlock);
  if (Number(await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "state" })) !== 2) {
    throw new Error("el fondo no entró en Winding");
  }

  await write(1, feeSplitter, feeSplitterAbi, "redeem", [true]);
  const lpRemaining = (await publicClient.readContract({
    address: share,
    abi: shareAbi,
    functionName: "balanceOf",
    args: [lp.address],
  })) as bigint;
  await write(4, fund, fundAbi, "requestWithdraw", [lpRemaining, true]);
  await advance(1);
  await pokeFeeds(assets);
  await keeperTick(protocol, assets, startBlock);

  const finalSupply = (await publicClient.readContract({ address: share, abi: shareAbi, functionName: "totalSupply" })) as bigint;
  if (finalSupply !== 0n) throw new Error(`quedaron shares tras la salida total: ${finalSupply}`);
  await write(3, fund, fundAbi, "close");
  await advance(30 * 24 * 60 * 60 + 1);
  await write(1, fund, fundAbi, "finalizeClosure", [[]]);
  const stakeRemaining = (await publicClient.readContract({ address: stake, abi: stakeAbi, functionName: "stakeAvailable" })) as bigint;
  if (stakeRemaining !== 0n) throw new Error("el stake no fue liberado al finalizar");

  await write(0, assets.accessRegistry, accessAbi, "setBlocked", [lp.address, true]);
  let blacklistBlockedTransfer = false;
  try {
    await publicClient.simulateContract({
      address: assets.tsla,
      abi: erc20Abi,
      functionName: "transfer",
      args: [auxiliary.address, 1n],
      account: lp.address,
    });
  } catch {
    blacklistBlockedTransfer = true;
  }
  if (!blacklistBlockedTransfer) throw new Error("la blacklist no bloqueó el transfer de tTSLA");
  await write(0, assets.accessRegistry, accessAbi, "setBlocked", [lp.address, false]);

  await write(0, assets.accessRegistry, accessAbi, "setPaused", [true]);
  let pauseBlockedTransfer = false;
  try {
    await publicClient.simulateContract({
      address: assets.tsla,
      abi: erc20Abi,
      functionName: "transfer",
      args: [auxiliary.address, 1n],
      account: lp.address,
    });
  } catch {
    pauseBlockedTransfer = true;
  }
  if (!pauseBlockedTransfer) throw new Error("la pausa global no bloqueó el transfer de tTSLA");
  await write(0, assets.accessRegistry, accessAbi, "setPaused", [false]);

  await write(0, assets.accessRegistry, accessAbi, "setImplementation", [protocol.guardian]);
  await write(1, protocol.tokenRegistry, tokenRegistryAbi, "suspendOnBeaconDrift", [assets.tsla]);
  if (await publicClient.readContract({
    address: protocol.tokenRegistry,
    abi: tokenRegistryAbi,
    functionName: "isActive",
    args: [assets.tsla],
  })) throw new Error("el beacon drift no suspendió tTSLA");

  console.log("[8/8] reconstrucción completa desde Ponder");
  await testClient.mine({ blocks: 256 });
  await startIndexer(protocol, startBlock);
  const indexed = await gql(`{ funds { items { address state currentPeriod lifetimeDeposited6 } }
    trades { items { tokenIn tokenOut spent received } }
    withdrawals { items { inKind status paid6 inKindValueWad } }
    inKindSlices { items { token amount valueWad } }
    lpPositions { items { lp shares deposited6 withdrawn6 } } }`) as {
      funds: { items: Array<{ address: Address; state: number; currentPeriod: string; lifetimeDeposited6: string }> };
      trades: { items: unknown[] };
      withdrawals: { items: Array<{ inKind: boolean; status: string }> };
      inKindSlices: { items: Array<{ token: Address; amount: string; valueWad: string }> };
      lpPositions: { items: Array<{ lp: Address; shares: string }> };
    };

  if (indexed.funds.items.length !== 1 || indexed.funds.items[0]!.address.toLowerCase() !== fund.toLowerCase()) {
    throw new Error("Ponder no reconstruyó el fondo canario");
  }
  if (indexed.funds.items[0]!.state !== 3) throw new Error("Ponder no reconstruyó el estado Closed");
  if (indexed.trades.items.length !== 2) throw new Error("Ponder no reconstruyó compra y venta");
  if (indexed.inKindSlices.items.length < 2) throw new Error("Ponder no reconstruyó los slices in-kind");
  if (!indexed.withdrawals.items.every((item) => item.status === "executed")) {
    throw new Error("Ponder no reconstruyó todos los retiros ejecutados");
  }
  if (!indexed.withdrawals.items.some((item) => !item.inKind)) {
    throw new Error("Ponder no reconstruyó el retiro cash");
  }
  if (!indexed.withdrawals.items.some((item) => item.inKind)) {
    throw new Error("Ponder no reconstruyó los retiros in-kind");
  }
  const lpPosition = indexed.lpPositions.items.find((item) => item.lp.toLowerCase() === lp.address.toLowerCase());
  if (!lpPosition || BigInt(lpPosition.shares) !== 0n) throw new Error("la posición final del LP no quedó a cero");

  const deployBlock = startBlock + 1n;
  console.log(JSON.stringify({
    ok: true,
    chainId: 46_630,
    rpcUrl,
    ponderUrl,
    deployBlock: deployBlock.toString(),
    assets,
    protocol,
    fund,
    checks: {
      openEligibility: true,
      keeperExecutedDeposit: true,
      deterministicBuyAndSell: true,
      performanceSettlement: true,
      firstLossSettlement: true,
      cashWithdrawal: true,
      inKindSlices: indexed.inKindSlices.items.length,
      closure: true,
      blacklist: true,
      globalPause: true,
      beaconDrift: true,
      indexedState: "Closed",
    },
  }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    ponder?.kill();
    anvil?.kill();
    if (pgliteDir) {
      const tempRoot = resolve(tmpdir());
      const target = resolve(pgliteDir);
      if (!target.startsWith(`${tempRoot}\\`) || !target.includes("nuvem-testnet-e2e-")) {
        throw new Error(`rechazo borrar temp inesperado: ${target}`);
      }
      rmSync(target, { recursive: true, force: true });
    }
  });

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatEther,
  http,
  keccak256,
  parseAbi,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runTick, type KeeperConfig } from "../../keeper/src/runner.js";
import {
  contractsDir,
  loadRootEnv,
  readAssetManifest,
  readProtocolManifest,
  requirePrivateKey,
  rootDir,
} from "./common.js";

const MANAGER_STAKE_6 = 10_000_000_000n;
const LP_DEPOSIT_6 = 8_000_000_000n;
const ROUND_TRIP_USDG_6 = 300_000_000n;
const chain = defineChain({
  id: 46_630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});

const fundRegistryAbi = parseAbi([
  "function funds(uint256) view returns (address)",
  "function fundCount() view returns (uint256)",
]);
const fundAbi = parseAbi([
  "function share() view returns (address)",
  "function stakeEscrow() view returns (address)",
  "function GATE() view returns (address)",
  "function MANAGER() view returns (address)",
  "function requestDeposit(uint256 amount6) returns (uint256)",
  "function execute(uint256 adapterId,address tokenIn,address tokenOut,uint256 amountIn,bytes data)",
  "function state() view returns (uint8)",
  "function assetCount() view returns (uint256)",
  "function pendingOrders(address) view returns (uint8)",
  "function depositHead() view returns (uint256)",
  "function depositQueue(uint256) view returns (address lp,uint96 amount6,uint48 requestTime,bool cancelled)",
]);
const stakeAbi = parseAbi([
  "function addStake(uint256 amount)",
  "function stakeAvailable() view returns (uint256)",
]);
const shareAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const gateAbi = parseAbi(["function isEligible(address) view returns (bool)"]);
const faucetAbi = parseAbi([
  "function faucet() returns (uint256)",
  "function nextFaucetAt(address) view returns (uint256)",
  "function mint(address,uint256)",
]);
const feedAbi = parseAbi([
  "function poke()",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const accessAbi = parseAbi([
  "function implementation() view returns (address)",
  "function isBlocked(address) view returns (bool)",
  "function paused() view returns (bool)",
  "function setImplementation(address)",
  "function setBlocked(address,bool)",
  "function setPaused(bool)",
]);
const registryAbi = parseAbi([
  "function isActive(address) view returns (bool)",
  "function suspendOnBeaconDrift(address)",
  "function reapprove(address,address)",
]);

interface ReceiptRow { blockNumber: string }
interface BroadcastFile { receipts: ReceiptRow[] }
interface TxRecord { fn: string; hash: Hex }

const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  attempts = 30,
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (accept(last)) return last;
    await sleep(2_000);
  }
  throw new Error(`${label}: el RPC no reflejó el estado esperado tras ${attempts * 2}s (${String(last)})`);
}

function deploymentStartBlock(): bigint {
  const scripts = ["DeployTestnetAssets.s.sol", "DeployTestnetProtocol.s.sol", "CreateFund.s.sol"];
  const blocks: bigint[] = [];
  for (const script of scripts) {
    const path = resolve(contractsDir, `broadcast/${script}/46630/run-latest.json`);
    const file = JSON.parse(readFileSync(path, "utf8")) as BroadcastFile;
    for (const receipt of file.receipts) blocks.push(BigInt(receipt.blockNumber));
  }
  if (blocks.length === 0) throw new Error("los broadcasts públicos no contienen receipts");
  return blocks.reduce((min, value) => value < min ? value : min);
}

async function waitForTimestamp(client: PublicClient, target: bigint, label: string): Promise<void> {
  let lastNotice = 0;
  for (;;) {
    const now = (await client.getBlock()).timestamp;
    if (now >= target) return;
    if (Date.now() - lastNotice >= 30_000) {
      console.log(`[wait] ${label}: faltan ${target - now}s de tiempo on-chain`);
      lastNotice = Date.now();
    }
    await sleep(10_000);
  }
}

async function main(): Promise<void> {
  loadRootEnv();
  const rpcUrl = process.env.RH_RPC_TESTNET;
  if (!rpcUrl) throw new Error("falta RH_RPC_TESTNET en el .env raíz");
  const deployerPk = requirePrivateKey(
    process.env.TESTNET_DEPLOYER_PK ?? process.env.DEPLOYER_PK,
    "TESTNET_DEPLOYER_PK/DEPLOYER_PK",
  );
  const deployer = privateKeyToAccount(deployerPk);
  const lpPk = keccak256(concatHex([deployerPk, stringToHex("NuvemFund public smoke LP v1")]));
  const lp = privateKeyToAccount(lpPk);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const managerWallet = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  const lpWallet = createWalletClient({ account: lp, chain, transport: http(rpcUrl) });
  const startBlock = deploymentStartBlock();
  const assets = readAssetManifest(46_630);
  const protocol = readProtocolManifest(46_630);
  const fund = (await publicClient.readContract({
    address: protocol.fundRegistry,
    abi: fundRegistryAbi,
    functionName: "funds",
    args: [0n],
  })) as Address;
  const share = (await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "share" })) as Address;
  const stake = (await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "stakeEscrow" })) as Address;
  const txs: TxRecord[] = [];
  const balanceBefore = await publicClient.getBalance({ address: deployer.address });

  async function write(
    wallet: WalletClient,
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<Hex> {
    if (!wallet.account) throw new Error(`${functionName}: wallet sin account`);
    const hash = await wallet.writeContract({
      address,
      abi,
      functionName,
      args,
      account: wallet.account,
      chain,
    } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`${functionName} revirtió: ${hash}`);
    txs.push({ fn: functionName, hash });
    return hash;
  }

  console.log("[1/6] verificar wiring y preparar dos usuarios");
  const [chainId, fundCount, gate, manager, eligible] = await Promise.all([
    publicClient.getChainId(),
    publicClient.readContract({ address: protocol.fundRegistry, abi: fundRegistryAbi, functionName: "fundCount" }),
    publicClient.readContract({ address: fund, abi: fundAbi, functionName: "GATE" }),
    publicClient.readContract({ address: fund, abi: fundAbi, functionName: "MANAGER" }),
    publicClient.readContract({
      address: protocol.eligibilityGate,
      abi: gateAbi,
      functionName: "isEligible",
      args: [lp.address],
    }),
  ]);
  if (chainId !== 46_630 || fundCount !== 1n) throw new Error("chain o FundRegistry inesperado");
  if ((gate as Address).toLowerCase() !== protocol.eligibilityGate.toLowerCase()) throw new Error("Fund.GATE incorrecto");
  if ((manager as Address).toLowerCase() !== deployer.address.toLowerCase()) throw new Error("Fund.MANAGER incorrecto");
  if (!eligible) throw new Error("el LP separado no es elegible en el gate abierto");

  const lpNative = await publicClient.getBalance({ address: lp.address });
  if (lpNative < parseEther("0.00005")) {
    const hash = await managerWallet.sendTransaction({
      account: deployer,
      chain,
      to: lp.address,
      value: parseEther("0.0001"),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("falló la provisión de gas del LP");
    txs.push({ fn: "fundLpGas", hash });
  }

  console.log("[2/6] faucet tUSDG, stake del manager y solicitud de depósito del LP");
  const managerUsdg = (await publicClient.readContract({
    address: assets.usdg,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [deployer.address],
  })) as bigint;
  if (managerUsdg < MANAGER_STAKE_6) await write(managerWallet, assets.usdg, faucetAbi, "faucet");
  const lpUsdg = (await publicClient.readContract({
    address: assets.usdg,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [lp.address],
  })) as bigint;
  if (lpUsdg < LP_DEPOSIT_6) await write(lpWallet, assets.usdg, faucetAbi, "faucet");

  const stakeAvailable = (await publicClient.readContract({
    address: stake,
    abi: stakeAbi,
    functionName: "stakeAvailable",
  })) as bigint;
  if (stakeAvailable < MANAGER_STAKE_6) {
    const delta = MANAGER_STAKE_6 - stakeAvailable;
    await write(managerWallet, assets.usdg, erc20Abi, "approve", [stake, delta]);
    await write(managerWallet, stake, stakeAbi, "addStake", [delta]);
  }

  let lpShares = (await publicClient.readContract({
    address: share,
    abi: shareAbi,
    functionName: "balanceOf",
    args: [lp.address],
  })) as bigint;
  let requestTime = 0n;
  if (lpShares === 0n) {
    const pending = Number(await publicClient.readContract({
      address: fund,
      abi: fundAbi,
      functionName: "pendingOrders",
      args: [lp.address],
    }));
    if (pending === 0) {
      await write(lpWallet, assets.usdg, erc20Abi, "approve", [fund, LP_DEPOSIT_6]);
      await write(lpWallet, fund, fundAbi, "requestDeposit", [LP_DEPOSIT_6]);
    }
    const head = (await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "depositHead" })) as bigint;
    const order = (await publicClient.readContract({
      address: fund,
      abi: fundAbi,
      functionName: "depositQueue",
      args: [head],
    })) as readonly [Address, bigint, number | bigint, boolean];
    requestTime = BigInt(order[2]);
    const feed = (await publicClient.readContract({
      address: assets.usdgFeed,
      abi: feedAbi,
      functionName: "latestRoundData",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    if (BigInt(feed[3]) <= requestTime) {
      await waitForTimestamp(publicClient, requestTime + 1n, "ronda forward-priced");
      await write(managerWallet, assets.usdgFeed, feedAbi, "poke");
    }

    console.log("[3/6] esperar latencia canónica y ejecutar el keeper real");
    await waitForTimestamp(publicClient, requestTime + 601n, "depósito ejecutable");
    const cfg: KeeperConfig = {
      fundRegistry: protocol.fundRegistry,
      accessRegistry: assets.accessRegistry,
      fromBlock: startBlock,
      send: true,
    };
    const reports = await runTick(publicClient, managerWallet, cfg);
    if (reports.length !== 1 || reports[0]!.error) {
      throw new Error(`keeper público: ${reports[0]?.error ?? "reporte inesperado"}`);
    }
    for (const sent of reports[0]!.sent) txs.push({ fn: sent.fn, hash: sent.hash });
    if (!reports[0]!.sent.some((sent) => sent.fn === "executeBatch" && sent.status === "success")) {
      throw new Error("el keeper no ejecutó el depósito público");
    }
    lpShares = await eventually(
      async () => (await publicClient.readContract({
        address: share,
        abi: shareAbi,
        functionName: "balanceOf",
        args: [lp.address],
      })) as bigint,
      (value) => value > 0n,
      "shares del LP tras executeBatch",
    );
  }
  if (lpShares === 0n) throw new Error("el LP no recibió shares");

  console.log("[4/6] buy/sell real mediante el TestnetTradeAdapter");
  const fundUsdgBefore = (await publicClient.readContract({
    address: assets.usdg,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [fund],
  })) as bigint;
  await write(managerWallet, fund, fundAbi, "execute", [0n, assets.usdg, assets.tsla, ROUND_TRIP_USDG_6, "0x"]);
  await write(managerWallet, fund, fundAbi, "execute", [0n, assets.tsla, assets.usdg, 1e18, "0x"]);
  await eventually(
    async () => (await publicClient.readContract({ address: fund, abi: fundAbi, functionName: "assetCount" })) as bigint,
    (value) => value > 0n,
    "registro del asset tras el trade",
  );
  const [fundUsdgAfter, adapterUsdg, adapterTsla] = await Promise.all([
    publicClient.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [fund] }),
    publicClient.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [assets.adapter] }),
    publicClient.readContract({ address: assets.tsla, abi: erc20Abi, functionName: "balanceOf", args: [assets.adapter] }),
  ]) as [bigint, bigint, bigint];
  if (fundUsdgAfter !== fundUsdgBefore || adapterUsdg !== 0n || adapterTsla !== 0n) {
    throw new Error("el round-trip no fue determinista o el adapter conservó residuos");
  }

  console.log("[5/6] blacklist, pausa global y beacon drift con restauración");
  await write(managerWallet, assets.tsla, faucetAbi, "mint", [lp.address, 1e18]);
  await write(managerWallet, assets.accessRegistry, accessAbi, "setBlocked", [lp.address, true]);
  await eventually(
    async () => Boolean(await publicClient.readContract({
      address: assets.accessRegistry,
      abi: accessAbi,
      functionName: "isBlocked",
      args: [lp.address],
    })),
    Boolean,
    "blacklist activa",
  );
  let blacklistRejected = false;
  try {
    await publicClient.simulateContract({
      address: assets.tsla,
      abi: erc20Abi,
      functionName: "transfer",
      args: [deployer.address, 1n],
      account: lp.address,
    });
  } catch { blacklistRejected = true; }
  await write(managerWallet, assets.accessRegistry, accessAbi, "setBlocked", [lp.address, false]);
  await eventually(
    async () => Boolean(await publicClient.readContract({
      address: assets.accessRegistry,
      abi: accessAbi,
      functionName: "isBlocked",
      args: [lp.address],
    })),
    (value) => !value,
    "blacklist restaurada",
  );
  if (!blacklistRejected) throw new Error("la blacklist no rechazó el transfer");

  await write(managerWallet, assets.accessRegistry, accessAbi, "setPaused", [true]);
  await eventually(
    async () => Boolean(await publicClient.readContract({
      address: assets.accessRegistry,
      abi: accessAbi,
      functionName: "paused",
    })),
    Boolean,
    "pausa global activa",
  );
  let pauseRejected = false;
  try {
    await publicClient.simulateContract({
      address: assets.tsla,
      abi: erc20Abi,
      functionName: "transfer",
      args: [deployer.address, 1n],
      account: lp.address,
    });
  } catch { pauseRejected = true; }
  await write(managerWallet, assets.accessRegistry, accessAbi, "setPaused", [false]);
  await eventually(
    async () => Boolean(await publicClient.readContract({
      address: assets.accessRegistry,
      abi: accessAbi,
      functionName: "paused",
    })),
    (value) => !value,
    "pausa global restaurada",
  );
  if (!pauseRejected) throw new Error("la pausa global no rechazó el transfer");

  const originalImplementation = (await publicClient.readContract({
    address: assets.accessRegistry,
    abi: accessAbi,
    functionName: "implementation",
  })) as Address;
  await write(managerWallet, assets.accessRegistry, accessAbi, "setImplementation", [protocol.guardian]);
  await eventually(
    async () => (await publicClient.readContract({
      address: assets.accessRegistry,
      abi: accessAbi,
      functionName: "implementation",
    })) as Address,
    (value) => value.toLowerCase() === protocol.guardian.toLowerCase(),
    "drift del beacon visible",
  );
  await write(lpWallet, protocol.tokenRegistry, registryAbi, "suspendOnBeaconDrift", [assets.tsla]);
  const suspended = !(await eventually(
    async () => Boolean(await publicClient.readContract({
      address: protocol.tokenRegistry,
      abi: registryAbi,
      functionName: "isActive",
      args: [assets.tsla],
    })),
    (value) => !value,
    "suspensión por beacon drift",
  ));
  await write(managerWallet, assets.accessRegistry, accessAbi, "setImplementation", [originalImplementation]);
  await eventually(
    async () => (await publicClient.readContract({
      address: assets.accessRegistry,
      abi: accessAbi,
      functionName: "implementation",
    })) as Address,
    (value) => value.toLowerCase() === originalImplementation.toLowerCase(),
    "implementación del beacon restaurada",
  );
  await write(managerWallet, protocol.tokenRegistry, registryAbi, "reapprove", [assets.tsla, originalImplementation]);
  const restored = await eventually(
    async () => Boolean(await publicClient.readContract({
      address: protocol.tokenRegistry,
      abi: registryAbi,
      functionName: "isActive",
      args: [assets.tsla],
    })),
    Boolean,
    "asset re-aprobado tras restaurar beacon",
  );
  if (!suspended || !restored) throw new Error("beacon drift no suspendió/restauró correctamente");

  console.log("[6/6] backfill del indexer real sobre los eventos públicos");
  const indexed = await verifyIndexer(rpcUrl, protocol.fundRegistry, startBlock, fund, lp.address);
  const balanceAfter = await publicClient.getBalance({ address: deployer.address });
  console.log(JSON.stringify({
    ok: true,
    chainId,
    startBlock: startBlock.toString(),
    endBlock: (await publicClient.getBlockNumber()).toString(),
    deployer: deployer.address,
    lp: lp.address,
    balanceBeforeEth: formatEther(balanceBefore),
    balanceAfterEth: formatEther(balanceAfter),
    assets,
    protocol,
    fund,
    txs,
    checks: {
      openEligibility: true,
      managerStake6: "10000000000",
      lpShares: lpShares.toString(),
      keeperExecutedDeposit: true,
      deterministicBuyAndSell: true,
      adapterResidueZero: true,
      blacklistRejected,
      globalPauseRejected: pauseRejected,
      beaconDriftSuspendedAndRestored: true,
      indexedFund: indexed.fund,
      indexedTrades: indexed.trades,
      indexedLpShares: indexed.lpShares,
    },
    deferredByProtocolTime: ["settlement: 7 days", "withdrawal: 1 hour", "guardian acceptance: 2 days"],
  }, null, 2));
}

async function verifyIndexer(
  rpcUrl: string,
  fundRegistry: Address,
  startBlock: bigint,
  fund: Address,
  lp: Address,
): Promise<{ fund: boolean; trades: number; lpShares: string }> {
  const indexerDir = resolve(rootDir, "packages/indexer");
  const port = 43_500 + (process.pid % 300);
  const url = `http://127.0.0.1:${port}`;
  const pgliteDir = mkdtempSync(resolve(tmpdir(), "nuvem-public-smoke-"));
  let child: ChildProcess | null = null;
  let logs = "";
  try {
    const childEnv = { ...process.env };
    delete childEnv.DEPLOYER_PK;
    delete childEnv.TESTNET_DEPLOYER_PK;
    delete childEnv.RH_RPC_TESTNET;
    Object.assign(childEnv, {
      INDEXER_RPC_URL: rpcUrl,
      INDEXER_CHAIN_ID: "46630",
      FUND_REGISTRY: fundRegistry,
      INDEXER_START_BLOCK: startBlock.toString(),
      PONDER_PGLITE_DIR: pgliteDir,
      DATABASE_URL: "",
    });
    child = spawn(
      "node",
      ["node_modules/ponder/dist/esm/bin/ponder.js", "start", "--schema", "public", "--port", String(port), "--hostname", "127.0.0.1"],
      { cwd: indexerDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    child.stdout!.on("data", (chunk: Buffer) => (logs = (logs + chunk.toString()).slice(-16_000)));
    child.stderr!.on("data", (chunk: Buffer) => (logs = (logs + chunk.toString()).slice(-16_000)));

    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${url}/ready`)).status === 200) break;
      } catch { /* arrancando */ }
      if (i === 119) throw new Error("Ponder no llegó a /ready");
      await sleep(1_000);
    }

    for (let i = 0; i < 120; i++) {
      const response = await fetch(`${url}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ funds { items { address } } trades { items { fund } } lpPositions { items { fund lp shares } } }" }),
      });
      const json = (await response.json()) as {
        data?: {
          funds: { items: Array<{ address: Address }> };
          trades: { items: Array<{ fund: Address }> };
          lpPositions: { items: Array<{ fund: Address; lp: Address; shares: string }> };
        };
      };
      const data = json.data;
      if (data) {
        const indexedFund = data.funds.items.some((item) => item.address.toLowerCase() === fund.toLowerCase());
        const trades = data.trades.items.filter((item) => item.fund.toLowerCase() === fund.toLowerCase()).length;
        const position = data.lpPositions.items.find(
          (item) => item.fund.toLowerCase() === fund.toLowerCase() && item.lp.toLowerCase() === lp.toLowerCase(),
        );
        if (indexedFund && trades >= 2 && position && BigInt(position.shares) > 0n) {
          return { fund: true, trades, lpShares: position.shares };
        }
      }
      await sleep(2_000);
    }
    throw new Error("Ponder no terminó el backfill público a tiempo");
  } catch (error) {
    const safeLogs = logs.replaceAll(rpcUrl, "[REDACTED_RPC]");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${safeLogs}`);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    const resolvedDir = resolve(pgliteDir);
    const resolvedTmp = resolve(tmpdir());
    if (!resolvedDir.startsWith(`${resolvedTmp}${sep}`) || !basename(resolvedDir).startsWith("nuvem-public-smoke-")) {
      throw new Error(`ruta temporal inesperada; no se elimina: ${resolvedDir}`);
    }
    rmSync(resolvedDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

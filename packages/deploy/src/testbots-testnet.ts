import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatEther,
  formatUnits,
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
import { tickFund, type KeeperConfig } from "../../keeper/src/runner.js";
import {
  contractsDir,
  loadRootEnv,
  protocolEnv,
  readAssetManifest,
  readProtocolManifest,
  requirePrivateKey,
  runForge,
} from "./common.js";

const CHAIN_ID = 46_630;
const BOT_COUNT = 3;
const BOT_DEPOSIT_6 = 2_000_000_000n;
const MANAGER_STAKE_6 = 5_000_000_000n;
const ENTRY_FEE_BPS = 200;
const MANAGER_ENTRY_SHARE_BPS = 5_000;
const PROTOCOL_ENTRY_BPS = 2_000n;
const NVDA_TRADE_6 = 500_000_000n;
const TSLA_TRADE_6 = 3_000_000_000n;
const TSLA_BASE_PRICE_8 = 300_00000000n;
const MIN_BOT_GAS = parseEther("0.00002");
const BOT_GAS_TOPUP = parseEther("0.00005");
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});

const fundRegistryAbi = parseAbi([
  "function owner() view returns (address)",
  "function fundCount() view returns (uint256)",
  "function funds(uint256) view returns (address)",
  "event FundRegistered(address indexed fund,address indexed manager)",
]);
const fundAbi = parseAbi([
  "function share() view returns (address)",
  "function queue() view returns (address)",
  "function stakeEscrow() view returns (address)",
  "function reserve() view returns (address)",
  "function FEE_SPLITTER() view returns (address)",
  "function MANAGER() view returns (address)",
  "function KEEPER() view returns (address)",
  "function PROTOCOL_TREASURY() view returns (address)",
  "function config() view returns (uint16 perfFeeBps,uint16 feeMinBps,uint16 feeMaxBps,uint16 managerEntryShareBps,uint16 kFactor,uint32 period,uint32 withdrawCooldown)",
  "function state() view returns (uint8)",
  "function pendingOrders(address) view returns (uint8)",
  "function requestDeposit(uint256 amount6) returns (uint256)",
  "function requestWithdraw(uint256 shares,bool inKind) returns (uint256)",
  "function execute(uint256 adapterId,address tokenIn,address tokenOut,uint256 amountIn,bytes data)",
  "function settle(uint256 grossClaimsWad)",
  "function executeBatch(uint256 grossClaimsWad)",
  "function declareFrozen()",
  "function executeInKindWithdrawals()",
  "function requestWinding()",
  "function close()",
  "event DepositExecuted(uint256 indexed orderId,address indexed lp,uint256 amount6,uint256 sharesMinted)",
  "event EntryFeeCharged(uint256 indexed orderId,uint256 fee6,uint256 toManager6,uint256 toProtocol6)",
  "event Traded(uint256 indexed adapterId,address tokenIn,address tokenOut,uint256 spent,uint256 received,uint256 adverseWad)",
  "event PerfFeeCrystallized(uint64 indexed period,uint256 feeWad,uint256 sharesMinted)",
  "event WithdrawExecuted(uint256 indexed orderId,address indexed lp,uint256 shares,uint256 paid6,bool inKind)",
  "event StateChanged(uint8 newState)",
]);
const shareAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const stakeAbi = parseAbi([
  "function addStake(uint256 amount)",
  "function stakeAvailable() view returns (uint256)",
]);
const splitterAbi = parseAbi([
  "function redeem(bool inKind) returns (uint256)",
  "function distribute()",
  "event Distributed(uint256 toManager,uint256 toProtocol)",
]);
const faucetAbi = parseAbi([
  "function faucet() returns (uint256)",
  "function nextFaucetAt(address) view returns (uint256)",
]);
const feedAbi = parseAbi([
  "function poke()",
  "function setAnswer(int256 value)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);

interface ReceiptRow { blockNumber: string }
interface BroadcastFile { receipts: ReceiptRow[] }
interface TxRecord { actor: string; fn: string; hash: Hex }
interface EventRow {
  blockNumber: bigint;
  transactionHash: Hex;
  args: {
    fund?: Address;
    lp?: Address;
    fee6?: bigint;
    toManager6?: bigint;
    toProtocol6?: bigint;
    feeWad?: bigint;
    sharesMinted?: bigint;
    toManager?: bigint;
    toProtocol?: bigint;
    inKind?: boolean;
  };
}
interface IndexedState {
  fund: { address: string; state: number; totalShares: string; lpCount: number } | null;
  trades: number;
  positions: Array<{ lp: string; shares: string; deposited6: string; withdrawn6: string }>;
}

const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const lower = (value: string) => value.toLowerCase();

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  attempts = 60,
  intervalMs = 2_000,
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (accept(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`${label}: estado no observado tras ${(attempts * intervalMs) / 1000}s (${String(last)})`);
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

async function readContractEvents(
  client: PublicClient,
  address: Address,
  abi: readonly unknown[],
  eventName: string,
  fromBlock: bigint,
): Promise<EventRow[]> {
  const latest = await client.getBlockNumber();
  const rows: EventRow[] = [];
  for (let start = fromBlock; start <= latest; start += 10_000n) {
    const toBlock = start + 9_999n < latest ? start + 9_999n : latest;
    const batch = await client.getContractEvents({
      address,
      abi,
      eventName,
      fromBlock: start,
      toBlock,
    } as never);
    rows.push(...(batch as unknown as EventRow[]));
  }
  return rows;
}

function deploymentStartBlock(): bigint {
  const blocks: bigint[] = [];
  for (const script of ["DeployTestnetAssets.s.sol", "DeployTestnetProtocol.s.sol"]) {
    const path = resolve(contractsDir, `broadcast/${script}/${CHAIN_ID}/run-latest.json`);
    const file = JSON.parse(readFileSync(path, "utf8")) as BroadcastFile;
    for (const receipt of file.receipts) blocks.push(BigInt(receipt.blockNumber));
  }
  if (blocks.length === 0) throw new Error("broadcast base sin receipts");
  return blocks.reduce((min, value) => value < min ? value : min);
}

async function findFund(
  client: PublicClient,
  registry: Address,
  name: string,
  symbol: string,
): Promise<Address | null> {
  const count = (await client.readContract({
    address: registry,
    abi: fundRegistryAbi,
    functionName: "fundCount",
  })) as bigint;
  for (let i = 0n; i < count; i++) {
    const fund = (await client.readContract({
      address: registry,
      abi: fundRegistryAbi,
      functionName: "funds",
      args: [i],
    })) as Address;
    const share = (await client.readContract({ address: fund, abi: fundAbi, functionName: "share" })) as Address;
    const [candidateName, candidateSymbol] = await Promise.all([
      client.readContract({ address: share, abi: shareAbi, functionName: "name" }),
      client.readContract({ address: share, abi: shareAbi, functionName: "symbol" }),
    ]);
    if (candidateName === name && candidateSymbol === symbol) return fund;
  }
  return null;
}

async function indexedState(fund: Address, bots: Address[]): Promise<IndexedState> {
  const response = await fetch("http://127.0.0.1:42070/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{
        funds { items { address state totalShares lpCount } }
        trades { items { fund } }
        lpPositions { items { fund lp shares deposited6 withdrawn6 } }
      }`,
    }),
  });
  if (!response.ok) throw new Error(`Ponder HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: {
      funds: { items: Array<{ address: string; state: number; totalShares: string; lpCount: number }> };
      trades: { items: Array<{ fund: string }> };
      lpPositions: { items: Array<{ fund: string; lp: string; shares: string; deposited6: string; withdrawn6: string }> };
    };
  };
  if (!payload.data) throw new Error("Ponder sin data");
  const key = lower(fund);
  const botSet = new Set(bots.map(lower));
  return {
    fund: payload.data.funds.items.find((item) => lower(item.address) === key) ?? null,
    trades: payload.data.trades.items.filter((item) => lower(item.fund) === key).length,
    positions: payload.data.lpPositions.items.filter(
      (item) => lower(item.fund) === key && botSet.has(lower(item.lp)),
    ),
  };
}

async function main(): Promise<void> {
  loadRootEnv();
  const rpcUrl = process.env.RH_RPC_TESTNET;
  if (!rpcUrl) throw new Error("falta RH_RPC_TESTNET en el .env raíz");
  if (process.env.ALLOW_TESTNET_BROADCAST !== "1") {
    throw new Error("falta ALLOW_TESTNET_BROADCAST=1 para autorizar las tx públicas de TestBots");
  }
  const deployerPk = requirePrivateKey(
    process.env.TESTNET_DEPLOYER_PK ?? process.env.DEPLOYER_PK,
    "TESTNET_DEPLOYER_PK/DEPLOYER_PK",
  );
  const manager = privateKeyToAccount(deployerPk);
  const treasuryPk = keccak256(concatHex([deployerPk, stringToHex("NuvemFund TestBots treasury v1")]));
  const treasury = privateKeyToAccount(treasuryPk);
  const bots = Array.from({ length: BOT_COUNT }, (_, index) => {
    const pk = keccak256(concatHex([deployerPk, stringToHex(`NuvemFund TestBots bot ${index + 1} v1`)]));
    return privateKeyToAccount(pk);
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const managerWallet = createWalletClient({ account: manager, chain, transport: http(rpcUrl) });
  const botWallets = bots.map((bot) => createWalletClient({ account: bot, chain, transport: http(rpcUrl) }));
  const assets = readAssetManifest(CHAIN_ID);
  const protocol = readProtocolManifest(CHAIN_ID);
  const fromBlock = deploymentStartBlock();
  const txs: TxRecord[] = [];
  const balanceBeforeEth = await client.getBalance({ address: manager.address });

  async function write(
    wallet: WalletClient,
    actor: string,
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<Hex> {
    if (!wallet.account) throw new Error(`${functionName}: wallet sin account`);
    const request = {
      address,
      abi,
      functionName,
      args,
      account: wallet.account,
    };
    const estimatedGas = await client.estimateContractGas(request as never);
    const hash = await wallet.writeContract({
      ...request,
      chain,
      gas: estimatedGas * 3n / 2n + 100_000n,
    } as never);
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`${functionName} revirtió: ${hash}`);
    txs.push({ actor, fn: functionName, hash });
    return hash;
  }

  async function tickTestBots(fund: Address, cfg: KeeperConfig): Promise<void> {
    const report = await tickFund(client, null, fund, { ...cfg, send: false });
    for (const intent of report.intents) {
      await write(managerWallet, "keeper", fund, fundAbi, intent.fn, intent.args);
    }
  }

  console.log("[1/8] preflight, wallets bot y deployment reanudable");
  const [chainId, registryOwner] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: protocol.fundRegistry, abi: fundRegistryAbi, functionName: "owner" }),
  ]);
  if (chainId !== CHAIN_ID) throw new Error(`RPC equivocado: ${chainId}`);
  if (lower(registryOwner as Address) !== lower(manager.address)) throw new Error("el deployer ya no es owner del FundRegistry");

  for (let i = 0; i < bots.length; i++) {
    const native = await client.getBalance({ address: bots[i]!.address });
    if (native < MIN_BOT_GAS) {
      const hash = await managerWallet.sendTransaction({
        account: manager,
        chain,
        to: bots[i]!.address,
        value: BOT_GAS_TOPUP,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`falló gas bot ${i + 1}`);
      txs.push({ actor: "manager", fn: `fundBot${i + 1}Gas`, hash });
    }
  }

  let fund = await findFund(client, protocol.fundRegistry, "TestBots", "TBOT");
  if (!fund) {
    await runForge("script/CreateFund.s.sol", "robinhood_testnet", deployerPk, {
      ...protocolEnv(protocol),
      FUND_MANAGER: manager.address,
      KEEPER: manager.address,
      PROTOCOL_TREASURY: treasury.address,
      FUND_NAME: "TestBots",
      FUND_SYMBOL: "TBOT",
      PERF_FEE_BPS: "2000",
      FEE_MIN_BPS: ENTRY_FEE_BPS.toString(),
      FEE_MAX_BPS: ENTRY_FEE_BPS.toString(),
      MGR_ENTRY_BPS: MANAGER_ENTRY_SHARE_BPS.toString(),
      K_FACTOR: "25",
      PERIOD: String(7 * 24 * 60 * 60),
      COOLDOWN: String(60 * 60),
    });
    fund = await eventually(
      () => findFund(client, protocol.fundRegistry, "TestBots", "TBOT"),
      (value) => value !== null,
      "registro de TestBots",
    ) as Address;
  }
  const registrations = await readContractEvents(
    client,
    protocol.fundRegistry,
    fundRegistryAbi,
    "FundRegistered",
    fromBlock,
  );
  const registration = registrations.find((event) => event.args.fund && lower(event.args.fund) === lower(fund));
  if (!registration) throw new Error("no se encontro FundRegistered de TestBots");
  const fundFromBlock = registration.blockNumber;

  const [share, queue, stake, reserve, splitter, managerOnchain, keeperOnchain, treasuryOnchain, config] = await Promise.all([
    client.readContract({ address: fund, abi: fundAbi, functionName: "share" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "queue" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "stakeEscrow" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "reserve" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "FEE_SPLITTER" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "MANAGER" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "KEEPER" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "PROTOCOL_TREASURY" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "config" }),
  ]);
  const cfg = config as readonly [number, number, number, number, number, number, number];
  if (lower(managerOnchain) !== lower(manager.address) || lower(keeperOnchain) !== lower(manager.address)) {
    throw new Error("roles TestBots incorrectos");
  }
  if (lower(treasuryOnchain) !== lower(treasury.address)) throw new Error("treasury TestBots incorrecta");
  if (cfg[0] !== 2000 || cfg[1] !== 200 || cfg[2] !== 200 || cfg[3] !== 5000 || cfg[4] !== 25 || cfg[5] !== 604800 || cfg[6] !== 3600) {
    throw new Error(`config TestBots inesperada: ${cfg.join(",")}`);
  }

  console.log("[2/8] stake manager, faucet bots y depósitos");
  let stakeAvailable = (await client.readContract({ address: stake, abi: stakeAbi, functionName: "stakeAvailable" })) as bigint;
  if (stakeAvailable < MANAGER_STAKE_6) {
    const delta = MANAGER_STAKE_6 - stakeAvailable;
    const managerUsdg = (await client.readContract({
      address: assets.usdg,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [manager.address],
    })) as bigint;
    if (managerUsdg < delta) throw new Error("manager sin tUSDG suficiente para el stake TestBots");
    await write(managerWallet, "manager", assets.usdg, erc20Abi, "approve", [stake, delta]);
    await write(managerWallet, "manager", stake, stakeAbi, "addStake", [delta]);
    stakeAvailable = (await client.readContract({ address: stake, abi: stakeAbi, functionName: "stakeAvailable" })) as bigint;
  }
  if (stakeAvailable !== MANAGER_STAKE_6) throw new Error(`stake inesperado: ${stakeAvailable}`);

  const entryEventsBefore = await readContractEvents(client, fund, fundAbi, "EntryFeeCharged", fundFromBlock);
  const depositEventsBefore = await readContractEvents(client, fund, fundAbi, "DepositExecuted", fundFromBlock);
  const botsWithExecutedDeposit = new Set(
    depositEventsBefore.flatMap((event) => event.args.lp ? [lower(event.args.lp)] : []),
  );
  const allBotDepositsExecuted = bots.every((bot) => botsWithExecutedDeposit.has(lower(bot.address)));
  const managerFeeBefore = entryEventsBefore.reduce((sum, event) => sum + BigInt(event.args.toManager6 ?? 0n), 0n);
  const protocolFeeBefore = entryEventsBefore.reduce((sum, event) => sum + BigInt(event.args.toProtocol6 ?? 0n), 0n);
  const [managerBalanceAfterStake, treasuryBalanceBeforeEntry] = await Promise.all([
    client.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [manager.address] }) as Promise<bigint>,
    client.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] }) as Promise<bigint>,
  ]);

  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i]!;
    const wallet = botWallets[i]!;
    const [usdgBalance, shares, pending] = await Promise.all([
      client.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [bot.address] }) as Promise<bigint>,
      client.readContract({ address: share, abi: shareAbi, functionName: "balanceOf", args: [bot.address] }) as Promise<bigint>,
      client.readContract({ address: fund, abi: fundAbi, functionName: "pendingOrders", args: [bot.address] }) as Promise<number>,
    ]);
    const hasExecutedDeposit = botsWithExecutedDeposit.has(lower(bot.address));
    if (!hasExecutedDeposit && usdgBalance < BOT_DEPOSIT_6 && shares === 0n && Number(pending) === 0) {
      await write(wallet, `bot${i + 1}`, assets.usdg, faucetAbi, "faucet");
    }
    if (!hasExecutedDeposit && shares === 0n && Number(pending) === 0) {
      await write(wallet, `bot${i + 1}`, assets.usdg, erc20Abi, "approve", [fund, BOT_DEPOSIT_6]);
      await write(wallet, `bot${i + 1}`, fund, fundAbi, "requestDeposit", [BOT_DEPOSIT_6]);
    }
  }

  let botShares = await Promise.all(bots.map((bot) => client.readContract({
    address: share,
    abi: shareAbi,
    functionName: "balanceOf",
    args: [bot.address],
  }) as Promise<bigint>));
  if (!allBotDepositsExecuted && botShares.some((value) => value === 0n)) {
    const afterRequests = (await client.getBlock()).timestamp;
    await waitForTimestamp(client, afterRequests + 1n, "ronda posterior a depósitos");
    await write(managerWallet, "manager", assets.usdgFeed, feedAbi, "poke");
    await waitForTimestamp(client, afterRequests + 601n, "latencia de depósitos TestBots");
    const keeperCfg: KeeperConfig = {
      fundRegistry: protocol.fundRegistry,
      accessRegistry: assets.accessRegistry,
      fromBlock: fundFromBlock,
      send: true,
    };
    await tickTestBots(fund, keeperCfg);
    botShares = await eventually(
      () => Promise.all(bots.map((bot) => client.readContract({
        address: share,
        abi: shareAbi,
        functionName: "balanceOf",
        args: [bot.address],
      }) as Promise<bigint>)),
      (values) => values.every((value) => value > 0n),
      "shares de los tres bots",
    );
  }

  const entryEvents = await readContractEvents(client, fund, fundAbi, "EntryFeeCharged", fundFromBlock);
  const managerEntryFee6 = entryEvents.reduce((sum, event) => sum + BigInt(event.args.toManager6 ?? 0n), 0n);
  const protocolEntryFee6 = entryEvents.reduce((sum, event) => sum + BigInt(event.args.toProtocol6 ?? 0n), 0n);
  const totalEntryFee6 = entryEvents.reduce((sum, event) => sum + BigInt(event.args.fee6 ?? 0n), 0n);
  const expectedFeePerBot = BOT_DEPOSIT_6 * BigInt(ENTRY_FEE_BPS) / 10_000n;
  if (entryEvents.length !== BOT_COUNT || totalEntryFee6 !== expectedFeePerBot * BigInt(BOT_COUNT)) {
    throw new Error("eventos de entry fee TestBots incorrectos");
  }
  const [managerAfterEntry, treasuryAfterEntry] = await Promise.all([
    client.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [manager.address] }) as Promise<bigint>,
    client.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [treasury.address] }) as Promise<bigint>,
  ]);
  if (managerAfterEntry - managerBalanceAfterStake !== managerEntryFee6 - managerFeeBefore) {
    throw new Error("el balance del manager no refleja la entry fee");
  }
  if (treasuryAfterEntry - treasuryBalanceBeforeEntry !== protocolEntryFee6 - protocolFeeBefore) {
    throw new Error("el balance de treasury no refleja la entry fee de protocolo");
  }

  console.log("[3/8] cuatro trades y ganancia realizada controlada");
  let tradeEvents = await readContractEvents(client, fund, fundAbi, "Traded", fundFromBlock);
  let state = Number(await client.readContract({ address: fund, abi: fundAbi, functionName: "state" }));
  if (state === 0 && tradeEvents.length === 0) {
    await write(managerWallet, "manager", assets.usdgFeed, feedAbi, "poke");
    await write(managerWallet, "manager", assets.nvdaFeed, feedAbi, "poke");
    await write(managerWallet, "manager", fund, fundAbi, "execute", [0n, assets.usdg, assets.nvda, NVDA_TRADE_6, "0x"]);
    const nvdaBalance = (await client.readContract({
      address: assets.nvda,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [fund],
    })) as bigint;
    await write(managerWallet, "manager", fund, fundAbi, "execute", [0n, assets.nvda, assets.usdg, nvdaBalance, "0x"]);

    const tslaRound = (await client.readContract({
      address: assets.tslaFeed,
      abi: feedAbi,
      functionName: "latestRoundData",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const originalTslaPrice = tslaRound[1];
    const profitTslaPrice = originalTslaPrice * 110n / 100n;
    await write(managerWallet, "manager", assets.tslaFeed, feedAbi, "poke");
    await write(managerWallet, "manager", fund, fundAbi, "execute", [0n, assets.usdg, assets.tsla, TSLA_TRADE_6, "0x"]);
    await write(managerWallet, "manager", assets.tslaFeed, feedAbi, "setAnswer", [profitTslaPrice]);
    const tslaBalance = (await client.readContract({
      address: assets.tsla,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [fund],
    })) as bigint;
    await write(managerWallet, "manager", fund, fundAbi, "execute", [0n, assets.tsla, assets.usdg, tslaBalance, "0x"]);
    await write(managerWallet, "manager", assets.tslaFeed, feedAbi, "setAnswer", [originalTslaPrice]);
    tradeEvents = await readContractEvents(client, fund, fundAbi, "Traded", fundFromBlock);
  }
  if (tradeEvents.length !== 4) throw new Error(`TestBots esperaba 4 trades; observados ${tradeEvents.length}`);
  const tslaRoundAfterTrades = (await client.readContract({
    address: assets.tslaFeed,
    abi: feedAbi,
    functionName: "latestRoundData",
  })) as readonly [bigint, bigint, bigint, bigint, bigint];
  if (tslaRoundAfterTrades[1] !== TSLA_BASE_PRICE_8) {
    await write(managerWallet, "manager", assets.tslaFeed, feedAbi, "setAnswer", [TSLA_BASE_PRICE_8]);
  }
  const [fundTsla, fundNvda] = await Promise.all([
    client.readContract({ address: assets.tsla, abi: erc20Abi, functionName: "balanceOf", args: [fund] }) as Promise<bigint>,
    client.readContract({ address: assets.nvda, abi: erc20Abi, functionName: "balanceOf", args: [fund] }) as Promise<bigint>,
  ]);
  if (fundTsla !== 0n || fundNvda !== 0n) throw new Error("el Fund no quedó liquidado a tUSDG");

  console.log("[4/8] winding ad-hoc y cristalización de performance fee");
  state = Number(await client.readContract({ address: fund, abi: fundAbi, functionName: "state" }));
  if (state === 0) await write(managerWallet, "manager", fund, fundAbi, "requestWinding");
  state = Number(await client.readContract({ address: fund, abi: fundAbi, functionName: "state" }));
  if (state === 1) {
    const windingRequestTime = (await client.getBlock()).timestamp;
    await waitForTimestamp(client, windingRequestTime + 1n, "rondas posteriores al winding");
    await write(managerWallet, "manager", assets.usdgFeed, feedAbi, "poke");
    await write(managerWallet, "manager", assets.tslaFeed, feedAbi, "poke");
    await write(managerWallet, "manager", assets.nvdaFeed, feedAbi, "poke");
    const keeperCfg: KeeperConfig = {
      fundRegistry: protocol.fundRegistry,
      accessRegistry: assets.accessRegistry,
      fromBlock: fundFromBlock,
      send: true,
    };
    await tickTestBots(fund, keeperCfg);
    state = await eventually(
      async () => Number(await client.readContract({ address: fund, abi: fundAbi, functionName: "state" })),
      (value) => value === 2,
      "TestBots en Winding",
    );
  }
  if (state !== 2 && state !== 3) throw new Error(`estado TestBots inesperado tras winding: ${state}`);
  const perfEvents = await readContractEvents(client, fund, fundAbi, "PerfFeeCrystallized", fundFromBlock);
  const perfFeeWad = perfEvents.reduce((sum, event) => sum + BigInt(event.args.feeWad ?? 0n), 0n);
  const perfShares = perfEvents.reduce((sum, event) => sum + BigInt(event.args.sharesMinted ?? 0n), 0n);
  if (perfEvents.length !== 1 || perfFeeWad === 0n || perfShares === 0n) {
    throw new Error("la performance fee no cristalizó");
  }

  console.log("[5/8] encolar todos los retiros bot y la fee del manager");
  for (let i = 0; i < bots.length; i++) {
    const [shares, pending] = await Promise.all([
      client.readContract({ address: share, abi: shareAbi, functionName: "balanceOf", args: [bots[i]!.address] }) as Promise<bigint>,
      client.readContract({ address: fund, abi: fundAbi, functionName: "pendingOrders", args: [bots[i]!.address] }) as Promise<number>,
    ]);
    if (shares > 0n && Number(pending) === 0) {
      await write(botWallets[i]!, `bot${i + 1}`, fund, fundAbi, "requestWithdraw", [shares, false]);
    }
  }
  const [splitterShares, splitterPending] = await Promise.all([
    client.readContract({ address: share, abi: shareAbi, functionName: "balanceOf", args: [splitter] }) as Promise<bigint>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "pendingOrders", args: [splitter] }) as Promise<number>,
  ]);
  if (splitterShares > 0n && Number(splitterPending) === 0) {
    await write(managerWallet, "manager", splitter, splitterAbi, "redeem", [false]);
  }

  const withdrawalRequestTime = (await client.getBlock()).timestamp;
  await waitForTimestamp(client, withdrawalRequestTime + 1n, "rondas posteriores a retiros");
  await write(managerWallet, "manager", assets.usdgFeed, feedAbi, "poke");
  await write(managerWallet, "manager", assets.tslaFeed, feedAbi, "poke");
  await write(managerWallet, "manager", assets.nvdaFeed, feedAbi, "poke");

  console.log("[6/8] ejecutar retiros cash y distribuir performance fee 90/10");
  const keeperCfg: KeeperConfig = {
    fundRegistry: protocol.fundRegistry,
    accessRegistry: assets.accessRegistry,
    fromBlock: fundFromBlock,
    send: true,
  };
  await tickTestBots(fund, keeperCfg);
  await eventually(
    () => Promise.all([
      ...bots.map((bot) => client.readContract({ address: share, abi: shareAbi, functionName: "balanceOf", args: [bot.address] }) as Promise<bigint>),
      client.readContract({ address: share, abi: shareAbi, functionName: "balanceOf", args: [splitter] }) as Promise<bigint>,
    ]),
    (values) => values.every((value) => value === 0n),
    "quema de todas las shares bot y fee",
  );
  const splitterUsdg = (await client.readContract({
    address: assets.usdg,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [splitter],
  })) as bigint;
  let distributedEvents = await readContractEvents(client, splitter, splitterAbi, "Distributed", fundFromBlock);
  if (splitterUsdg > 0n) {
    await write(managerWallet, "manager", splitter, splitterAbi, "distribute");
    distributedEvents = await readContractEvents(client, splitter, splitterAbi, "Distributed", fundFromBlock);
  }
  const perfToManager6 = distributedEvents.reduce((sum, event) => sum + BigInt(event.args.toManager ?? 0n), 0n);
  const perfToProtocol6 = distributedEvents.reduce((sum, event) => sum + BigInt(event.args.toProtocol ?? 0n), 0n);
  if (perfToManager6 === 0n || perfToProtocol6 === 0n) throw new Error("split 90/10 no emitido");
  const distributedTotal6 = perfToManager6 + perfToProtocol6;
  if (perfToManager6 !== distributedTotal6 * 9_000n / 10_000n
    || perfToProtocol6 !== distributedTotal6 - perfToManager6) {
    throw new Error("el evento Distributed no respeta el split 90/10");
  }

  const totalSupply = (await client.readContract({ address: share, abi: shareAbi, functionName: "totalSupply" })) as bigint;
  if (totalSupply !== 0n) throw new Error(`quedan shares TestBots: ${totalSupply}`);
  state = Number(await client.readContract({ address: fund, abi: fundAbi, functionName: "state" }));
  if (state === 2) await write(managerWallet, "manager", fund, fundAbi, "close");
  state = Number(await client.readContract({ address: fund, abi: fundAbi, functionName: "state" }));
  if (state !== 3) throw new Error(`TestBots no cerró: ${state}`);

  console.log("[7/8] balances finales de bots y reconstrucción Ponder");
  const withdrawals = await readContractEvents(client, fund, fundAbi, "WithdrawExecuted", fundFromBlock);
  const botSet = new Set(bots.map((bot) => lower(bot.address)));
  const botWithdrawals = withdrawals.filter((event) => botSet.has(lower(event.args.lp as Address)));
  if (botWithdrawals.length !== BOT_COUNT || botWithdrawals.some((event) => Boolean(event.args.inKind))) {
    throw new Error("retiros cash de bots incompletos");
  }
  const botResults = await Promise.all(bots.map(async (bot, index) => ({
    bot: index + 1,
    address: bot.address,
    nativeEth: formatEther(await client.getBalance({ address: bot.address })),
    usdg: formatUnits((await client.readContract({
      address: assets.usdg,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [bot.address],
    })) as bigint, 6),
    shares: formatUnits((await client.readContract({
      address: share,
      abi: shareAbi,
      functionName: "balanceOf",
      args: [bot.address],
    })) as bigint, 18),
  })));
  const indexed = await eventually(
    () => indexedState(fund, bots.map((bot) => bot.address)),
    (value) => value.fund?.state === 3 && value.trades === 4
      && value.positions.length === BOT_COUNT && value.positions.every((position) => BigInt(position.shares) === 0n),
    "Ponder TestBots cerrado",
    90,
    2_000,
  );

  console.log("[8/8] resumen final");
  const balanceAfterEth = await client.getBalance({ address: manager.address });
  console.log(JSON.stringify({
    ok: true,
    chainId,
    name: "TestBots",
    symbol: "TBOT",
    addresses: {
      fund,
      share,
      queue,
      stakeEscrow: stake,
      compensationReserve: reserve,
      feeSplitter: splitter,
      manager: manager.address,
      protocolTreasury: treasury.address,
      bots: bots.map((bot) => bot.address),
    },
    config: {
      performanceFeeBps: cfg[0],
      entryFeeMinBps: cfg[1],
      entryFeeMaxBps: cfg[2],
      managerEntryShareBps: cfg[3],
      kFactor: cfg[4],
      periodSeconds: cfg[5],
      withdrawalCooldownSeconds: cfg[6],
      initialStake6: MANAGER_STAKE_6.toString(),
      depositPerBot6: BOT_DEPOSIT_6.toString(),
    },
    fees: {
      totalEntryFee6: totalEntryFee6.toString(),
      entryToManager6: managerEntryFee6.toString(),
      entryToProtocol6: protocolEntryFee6.toString(),
      performanceFeeWad: perfFeeWad.toString(),
      performanceShares: perfShares.toString(),
      performanceToManager6: perfToManager6.toString(),
      performanceToProtocol6: perfToProtocol6.toString(),
    },
    checks: {
      bots: botResults,
      allBotWithdrawalsCash: true,
      allSharesBurned: true,
      finalStateClosed: true,
      indexed,
    },
    evidenceTransactions: {
      entryFees: [...new Set(entryEvents.map((event) => event.transactionHash))],
      trades: [...new Set(tradeEvents.map((event) => event.transactionHash))],
      performanceFee: [...new Set(perfEvents.map((event) => event.transactionHash))],
      withdrawals: [...new Set(withdrawals.map((event) => event.transactionHash))],
      distribution: [...new Set(distributedEvents.map((event) => event.transactionHash))],
    },
    managerGas: {
      balanceBeforeEth: formatEther(balanceBeforeEth),
      balanceAfterEth: formatEther(balanceAfterEth),
      spentEth: formatEther(balanceBeforeEth - balanceAfterEth),
    },
    transactions: txs,
  }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
}

main().catch((error: unknown) => {
  const rpcUrl = process.env.RH_RPC_TESTNET;
  const message = error instanceof Error ? error.message : String(error);
  console.error(rpcUrl ? message.replaceAll(rpcUrl, "[REDACTED_RPC]") : message);
  process.exit(1);
});

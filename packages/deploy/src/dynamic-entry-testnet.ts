import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
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
const NAME = "Dynamic Entry Test";
const SYMBOL = "DYN";
const WAD = 10n ** 18n;
const USDG_TO_WAD = 10n ** 12n;
const BOT_COUNT = 3;
const DEPOSIT_6 = 2_000_000_000n;
const STAKE_6 = 1_000_000_000n;
const FEE_MIN_BPS = 0n;
const FEE_MAX_BPS = 500n;
const MANAGER_ENTRY_SHARE_BPS = 5_000n;
const PROTOCOL_ENTRY_BPS = 2_000n;
const K_FACTOR = 10n;
const CAP_WAD = K_FACTOR * STAKE_6 * USDG_TO_WAD;
const MIN_BOT_GAS = parseEther("0.00001");
const BOT_GAS_TOPUP = parseEther("0.00002");

const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
});

const registryAbi = parseAbi([
  "function fundCount() view returns (uint256)",
  "function funds(uint256) view returns (address)",
  "event FundRegistered(address indexed fund,address indexed manager)",
]);
const fundAbi = parseAbi([
  "function share() view returns (address)",
  "function queue() view returns (address)",
  "function stakeEscrow() view returns (address)",
  "function MANAGER() view returns (address)",
  "function PROTOCOL_TREASURY() view returns (address)",
  "function config() view returns (uint16 perfFeeBps,uint16 feeMinBps,uint16 feeMaxBps,uint16 managerEntryShareBps,uint16 kFactor,uint32 period,uint32 withdrawCooldown)",
  "function aumCapWad() view returns (uint256)",
  "function state() view returns (uint8)",
  "function pendingOrders(address) view returns (uint8)",
  "function requestDeposit(uint256 amount6) returns (uint256)",
  "function executeBatch(uint256 grossClaimsWad)",
  "event EntryFeeCharged(uint256 indexed orderId,uint256 fee6,uint256 toManager6,uint256 toProtocol6)",
  "event DepositExecuted(uint256 indexed orderId,address indexed lp,uint256 amount6,uint256 sharesMinted)",
]);
const shareAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const stakeAbi = parseAbi([
  "function addStake(uint256 amount)",
  "function stakeAvailable() view returns (uint256)",
]);
const feedAbi = parseAbi(["function poke()"]);

interface BroadcastFile { receipts: Array<{ blockNumber: string }> }
interface TxRecord { actor: string; fn: string; hash: Hex }
interface EventRow {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  args: {
    orderId?: bigint;
    fund?: Address;
    lp?: Address;
    amount6?: bigint;
    sharesMinted?: bigint;
    fee6?: bigint;
    toManager6?: bigint;
    toProtocol6?: bigint;
  };
}
interface ExpectedFee {
  rateBps: bigint;
  fee6: bigint;
  toManager6: bigint;
  toProtocol6: bigint;
  toFund6: bigint;
}
interface IndexedState {
  fund: { address: string; state: number; totalShares: string; lpCount: number } | null;
  positions: Array<{ lp: string; shares: string; deposited6: string }>;
}

const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const lower = (value: string) => value.toLowerCase();

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  attempts = 90,
  intervalMs = 2_000,
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (accept(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`${label}: no observado tras ${(attempts * intervalMs) / 1000}s (${String(last)})`);
}

async function waitForTimestamp(client: PublicClient, target: bigint, label: string): Promise<void> {
  let lastNotice = 0;
  for (;;) {
    const now = (await client.getBlock()).timestamp;
    if (now >= target) return;
    if (Date.now() - lastNotice >= 30_000) {
      console.log(`[wait] ${label}: faltan ${target - now}s on-chain`);
      lastNotice = Date.now();
    }
    await sleep(10_000);
  }
}

function deploymentStartBlock(): bigint {
  const blocks: bigint[] = [];
  for (const script of ["DeployTestnetAssets.s.sol", "DeployTestnetProtocol.s.sol"]) {
    const path = resolve(contractsDir, `broadcast/${script}/${CHAIN_ID}/run-latest.json`);
    const file = JSON.parse(readFileSync(path, "utf8")) as BroadcastFile;
    for (const receipt of file.receipts) blocks.push(BigInt(receipt.blockNumber));
  }
  if (blocks.length === 0) throw new Error("broadcast base sin receipts");
  return blocks.reduce((min, block) => block < min ? block : min);
}

async function readEvents(
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

async function findFund(client: PublicClient, registry: Address): Promise<Address | null> {
  const count = (await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "fundCount",
  })) as bigint;
  for (let i = 0n; i < count; i++) {
    const fund = (await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "funds",
      args: [i],
    })) as Address;
    const share = (await client.readContract({ address: fund, abi: fundAbi, functionName: "share" })) as Address;
    const [name, symbol] = await Promise.all([
      client.readContract({ address: share, abi: shareAbi, functionName: "name" }),
      client.readContract({ address: share, abi: shareAbi, functionName: "symbol" }),
    ]);
    if (name === NAME && symbol === SYMBOL) return fund;
  }
  return null;
}

function expectedFees(): ExpectedFee[] {
  const out: ExpectedFee[] = [];
  let navWad = 0n;
  let supplyExists = false;
  for (let i = 0; i < BOT_COUNT; i++) {
    const depositWad = DEPOSIT_6 * USDG_TO_WAD;
    let utilizationWad = (navWad + depositWad / 2n) * WAD / CAP_WAD;
    if (utilizationWad > WAD) utilizationWad = WAD;
    const rateBps = FEE_MIN_BPS + (FEE_MAX_BPS - FEE_MIN_BPS) * utilizationWad / WAD;
    const fee6 = (DEPOSIT_6 * rateBps + 9_999n) / 10_000n;
    const toManager6 = fee6 * MANAGER_ENTRY_SHARE_BPS / 10_000n;
    const toProtocol6 = fee6 * PROTOCOL_ENTRY_BPS / 10_000n;
    const toFund6 = fee6 - toManager6 - toProtocol6;
    out.push({ rateBps, fee6, toManager6, toProtocol6, toFund6 });
    if (supplyExists) navWad += toFund6 * USDG_TO_WAD;
    navWad += (DEPOSIT_6 - fee6) * USDG_TO_WAD;
    supplyExists = true;
  }
  return out;
}

async function indexedState(fund: Address, bots: Address[]): Promise<IndexedState> {
  const response = await fetch("http://127.0.0.1:42070/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{
        funds { items { address state totalShares lpCount } }
        lpPositions { items { fund lp shares deposited6 } }
      }`,
    }),
  });
  if (!response.ok) throw new Error(`Ponder HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: {
      funds: { items: Array<{ address: string; state: number; totalShares: string; lpCount: number }> };
      lpPositions: { items: Array<{ fund: string; lp: string; shares: string; deposited6: string }> };
    };
  };
  if (!payload.data) throw new Error("Ponder sin data");
  const fundKey = lower(fund);
  const botSet = new Set(bots.map(lower));
  return {
    fund: payload.data.funds.items.find((item) => lower(item.address) === fundKey) ?? null,
    positions: payload.data.lpPositions.items.filter(
      (item) => lower(item.fund) === fundKey && botSet.has(lower(item.lp)),
    ),
  };
}

async function main(): Promise<void> {
  loadRootEnv();
  const rpcUrl = process.env.RH_RPC_TESTNET;
  if (!rpcUrl) throw new Error("falta RH_RPC_TESTNET en el .env raíz");
  if (process.env.ALLOW_TESTNET_BROADCAST !== "1") {
    throw new Error("falta ALLOW_TESTNET_BROADCAST=1 para autorizar Dynamic Entry Test");
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
  const baseFromBlock = deploymentStartBlock();
  const txs: TxRecord[] = [];
  const ethBefore = await client.getBalance({ address: manager.address });

  async function write(
    wallet: WalletClient,
    actor: string,
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<Hex> {
    if (!wallet.account) throw new Error(`${functionName}: wallet sin account`);
    const request = { address, abi, functionName, args, account: wallet.account };
    const estimatedGas = await client.estimateContractGas(request as never);
    const hash = await wallet.writeContract({
      ...request,
      chain,
      gas: estimatedGas * 3n / 2n + 100_000n,
    } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} revirtió: ${hash}`);
    txs.push({ actor, fn: functionName, hash });
    return hash;
  }

  console.log("[1/5] preflight y creación/reanudación del vault dinámico");
  if (await client.getChainId() !== CHAIN_ID) throw new Error("RPC equivocado");
  for (let i = 0; i < bots.length; i++) {
    const gas = await client.getBalance({ address: bots[i]!.address });
    if (gas < MIN_BOT_GAS) {
      const hash = await managerWallet.sendTransaction({
        account: manager,
        chain,
        to: bots[i]!.address,
        value: BOT_GAS_TOPUP,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`topup bot ${i + 1} falló`);
      txs.push({ actor: "manager", fn: `fundBot${i + 1}Gas`, hash });
    }
  }

  let fund = await findFund(client, protocol.fundRegistry);
  if (!fund) {
    await runForge("script/CreateFund.s.sol", "robinhood_testnet", deployerPk, {
      ...protocolEnv(protocol),
      FUND_MANAGER: manager.address,
      KEEPER: manager.address,
      PROTOCOL_TREASURY: treasury.address,
      FUND_NAME: NAME,
      FUND_SYMBOL: SYMBOL,
      PERF_FEE_BPS: "1000",
      FEE_MIN_BPS: FEE_MIN_BPS.toString(),
      FEE_MAX_BPS: FEE_MAX_BPS.toString(),
      MGR_ENTRY_BPS: MANAGER_ENTRY_SHARE_BPS.toString(),
      K_FACTOR: K_FACTOR.toString(),
      PERIOD: String(7 * 24 * 60 * 60),
      COOLDOWN: String(60 * 60),
    });
    fund = await eventually(
      () => findFund(client, protocol.fundRegistry),
      (value) => value !== null,
      "registro de Dynamic Entry Test",
    ) as Address;
  }

  const registrations = await readEvents(
    client,
    protocol.fundRegistry,
    registryAbi,
    "FundRegistered",
    baseFromBlock,
  );
  const registration = registrations.find((event) => event.args.fund && lower(event.args.fund) === lower(fund));
  if (!registration) throw new Error("FundRegistered dinámico no encontrado");
  const fundFromBlock = registration.blockNumber;
  const [share, queue, stake, managerOnchain, treasuryOnchain, config, capWad, state] = await Promise.all([
    client.readContract({ address: fund, abi: fundAbi, functionName: "share" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "queue" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "stakeEscrow" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "MANAGER" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "PROTOCOL_TREASURY" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "config" }),
    client.readContract({ address: fund, abi: fundAbi, functionName: "aumCapWad" }) as Promise<bigint>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "state" }),
  ]);
  const cfg = config as readonly [number, number, number, number, number, number, number];
  if (lower(managerOnchain) !== lower(manager.address) || lower(treasuryOnchain) !== lower(treasury.address)) {
    throw new Error("roles dinámicos incorrectos");
  }
  if (Number(state) !== 0) throw new Error(`vault dinámico no Active: ${state}`);
  if (cfg[1] !== 0 || cfg[2] !== 500 || cfg[3] !== 5000 || cfg[4] !== 10) {
    throw new Error(`config dinámica incorrecta: ${cfg.join(",")}`);
  }

  console.log("[2/5] stake y tres órdenes FIFO");
  let stakeAvailable = (await client.readContract({
    address: stake,
    abi: stakeAbi,
    functionName: "stakeAvailable",
  })) as bigint;
  if (stakeAvailable < STAKE_6) {
    const delta = STAKE_6 - stakeAvailable;
    await write(managerWallet, "manager", assets.usdg, erc20Abi, "approve", [stake, delta]);
    await write(managerWallet, "manager", stake, stakeAbi, "addStake", [delta]);
    stakeAvailable = (await client.readContract({ address: stake, abi: stakeAbi, functionName: "stakeAvailable" })) as bigint;
  }
  if (stakeAvailable !== STAKE_6) throw new Error(`stake dinámico inesperado: ${stakeAvailable}`);
  const capAfterStake = (await client.readContract({ address: fund, abi: fundAbi, functionName: "aumCapWad" })) as bigint;
  if (capAfterStake !== CAP_WAD || (capWad !== 0n && capWad !== CAP_WAD)) {
    throw new Error(`cap dinámico inesperado: ${capAfterStake}`);
  }

  let depositEvents = await readEvents(client, fund, fundAbi, "DepositExecuted", fundFromBlock);
  const executed = new Set(depositEvents.flatMap((event) => event.args.lp ? [lower(event.args.lp)] : []));
  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i]!;
    if (executed.has(lower(bot.address))) continue;
    const [usdg, pending] = await Promise.all([
      client.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [bot.address] }) as Promise<bigint>,
      client.readContract({ address: fund, abi: fundAbi, functionName: "pendingOrders", args: [bot.address] }),
    ]);
    if (usdg < DEPOSIT_6) throw new Error(`bot ${i + 1} sin tUSDG suficiente`);
    if (Number(pending) === 0) {
      await write(botWallets[i]!, `bot${i + 1}`, assets.usdg, erc20Abi, "approve", [fund, DEPOSIT_6]);
      await write(botWallets[i]!, `bot${i + 1}`, fund, fundAbi, "requestDeposit", [DEPOSIT_6]);
    }
  }

  depositEvents = await readEvents(client, fund, fundAbi, "DepositExecuted", fundFromBlock);
  const allExecuted = () => {
    const set = new Set(depositEvents.flatMap((event) => event.args.lp ? [lower(event.args.lp)] : []));
    return bots.every((bot) => set.has(lower(bot.address)));
  };
  if (!allExecuted()) {
    const requestTime = (await client.getBlock()).timestamp;
    await waitForTimestamp(client, requestTime + 1n, "ronda posterior a depósitos dinámicos");
    await write(managerWallet, "manager", assets.usdgFeed, feedAbi, "poke");
    await waitForTimestamp(client, requestTime + 601n, "latencia de depósitos dinámicos");
    depositEvents = await readEvents(client, fund, fundAbi, "DepositExecuted", fundFromBlock);
    if (!allExecuted()) await write(managerWallet, "keeper", fund, fundAbi, "executeBatch", [0n]);
    depositEvents = await eventually(
      () => readEvents(client, fund, fundAbi, "DepositExecuted", fundFromBlock),
      (events) => {
        const set = new Set(events.flatMap((event) => event.args.lp ? [lower(event.args.lp)] : []));
        return bots.every((bot) => set.has(lower(bot.address)));
      },
      "tres depósitos dinámicos ejecutados",
    );
  }

  console.log("[3/5] reconciliación exacta de la curva y transferencias");
  const feeEvents = (await readEvents(client, fund, fundAbi, "EntryFeeCharged", fundFromBlock))
    .sort((a, b) => Number((a.args.orderId ?? 0n) - (b.args.orderId ?? 0n)));
  const expected = expectedFees();
  if (feeEvents.length !== BOT_COUNT) throw new Error(`esperaba 3 fees; observadas ${feeEvents.length}`);
  for (let i = 0; i < BOT_COUNT; i++) {
    const event = feeEvents[i]!;
    const exp = expected[i]!;
    if (event.args.fee6 !== exp.fee6 || event.args.toManager6 !== exp.toManager6
      || event.args.toProtocol6 !== exp.toProtocol6) {
      throw new Error(`fee dinámica ${i + 1} no coincide`);
    }
  }
  if (!(expected[0]!.rateBps < expected[1]!.rateBps && expected[1]!.rateBps < expected[2]!.rateBps)) {
    throw new Error("la curva no crece con la utilización");
  }

  const feeTxs = [...new Set(feeEvents.map((event) => event.transactionHash))];
  let transferredToManager6 = 0n;
  let transferredToProtocol6 = 0n;
  for (const hash of feeTxs) {
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`batch de fees revertido: ${hash}`);
    for (const log of receipt.logs) {
      if (lower(log.address) !== lower(assets.usdg)) continue;
      try {
        const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (decoded.eventName !== "Transfer") continue;
        const args = decoded.args as { from: Address; to: Address; value: bigint };
        if (lower(args.from) !== lower(queue)) continue;
        if (lower(args.to) === lower(manager.address)) transferredToManager6 += args.value;
        if (lower(args.to) === lower(treasury.address)) transferredToProtocol6 += args.value;
      } catch { /* otro evento */ }
    }
  }
  const expectedManager6 = expected.reduce((sum, row) => sum + row.toManager6, 0n);
  const expectedProtocol6 = expected.reduce((sum, row) => sum + row.toProtocol6, 0n);
  if (transferredToManager6 !== expectedManager6 || transferredToProtocol6 !== expectedProtocol6) {
    throw new Error("transfers de entry fee no coinciden con los eventos");
  }

  const expectedFundBalance6 = BigInt(BOT_COUNT) * DEPOSIT_6 - expectedManager6 - expectedProtocol6;
  const [fundBalance6, totalSupply, botShares] = await Promise.all([
    eventually(
      () => client.readContract({ address: assets.usdg, abi: erc20Abi, functionName: "balanceOf", args: [fund] }) as Promise<bigint>,
      (value) => value === expectedFundBalance6,
      "balance tUSDG del vault dinámico",
    ),
    client.readContract({ address: share, abi: shareAbi, functionName: "totalSupply" }) as Promise<bigint>,
    Promise.all(bots.map((bot) => client.readContract({
      address: share,
      abi: shareAbi,
      functionName: "balanceOf",
      args: [bot.address],
    }) as Promise<bigint>)),
  ]);
  if (totalSupply === 0n || botShares.some((shares) => shares === 0n)) throw new Error("shares dinámicas no acuñadas");

  console.log("[4/5] reconstrucción Ponder");
  const indexed = await eventually(
    () => indexedState(fund, bots.map((bot) => bot.address)),
    (value) => value.fund?.state === 0 && value.fund.lpCount === BOT_COUNT
      && BigInt(value.fund.totalShares) > 0n && value.positions.length === BOT_COUNT
      && value.positions.every((position) => BigInt(position.deposited6) === DEPOSIT_6 && BigInt(position.shares) > 0n),
    "Ponder Dynamic Entry Test",
  );

  console.log("[5/5] resultado");
  const ethAfter = await client.getBalance({ address: manager.address });
  console.log(JSON.stringify({
    ok: true,
    chainId: CHAIN_ID,
    name: NAME,
    symbol: SYMBOL,
    addresses: {
      fund,
      share,
      queue,
      stakeEscrow: stake,
      manager: manager.address,
      protocolTreasury: treasury.address,
      bots: bots.map((bot) => bot.address),
    },
    config: {
      feeMinBps: cfg[1],
      feeMaxBps: cfg[2],
      managerEntryShareBps: cfg[3],
      kFactor: cfg[4],
      stake6: stakeAvailable.toString(),
      capWad: capAfterStake.toString(),
      depositPerBot6: DEPOSIT_6.toString(),
    },
    curve: expected.map((row, index) => ({
      bot: index + 1,
      rateBps: row.rateBps.toString(),
      ratePercent: `${Number(row.rateBps) / 100}%`,
      fee6: row.fee6.toString(),
      fee: formatUnits(row.fee6, 6),
      toManager6: row.toManager6.toString(),
      toProtocol6: row.toProtocol6.toString(),
      toFund6: row.toFund6.toString(),
    })),
    totals: {
      deposits6: (BigInt(BOT_COUNT) * DEPOSIT_6).toString(),
      entryFees6: expected.reduce((sum, row) => sum + row.fee6, 0n).toString(),
      manager6: expectedManager6.toString(),
      protocol6: expectedProtocol6.toString(),
      retainedInFund6: expected.reduce((sum, row) => sum + row.toFund6, 0n).toString(),
      fundBalance6: fundBalance6.toString(),
      totalSupply: totalSupply.toString(),
    },
    checks: {
      exactFormula: true,
      strictlyIncreasingRates: true,
      canonicalTransfers: true,
      allBotsHaveShares: true,
      fundActive: true,
      indexed,
    },
    evidenceTransactions: { entryBatch: feeTxs },
    managerGas: {
      balanceBeforeEth: formatEther(ethBefore),
      balanceAfterEth: formatEther(ethAfter),
      spentEth: formatEther(ethBefore - ethAfter),
    },
    transactions: txs,
  }, null, 2));
}

main().catch((error: unknown) => {
  const rpcUrl = process.env.RH_RPC_TESTNET;
  const message = error instanceof Error ? error.message : String(error);
  console.error(rpcUrl ? message.replaceAll(rpcUrl, "[REDACTED_RPC]") : message);
  process.exit(1);
});

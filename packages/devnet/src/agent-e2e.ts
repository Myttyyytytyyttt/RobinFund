/**
 * Nuvem Agents local acceptance test.
 *
 * It behaves like an external BYOA process: all connections are outbound to the
 * creator/RPC/GraphQL endpoints and the agent key is generated in memory. The
 * production UniswapApiAdapter is exercised unchanged; only the deterministic
 * approval proxy is replaced by the explicit chain-31337 stand-in deployed by
 * DeployAgents.s.sol.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { acct, DEPLOYER, LP1, LP3, TSLA, USDG } from "./chain.js";

const CREATOR_URL = process.env.CREATOR_URL ?? "http://127.0.0.1:8788";
const GRAPHQL_URL = process.env.INDEXER_GRAPHQL_URL ?? "http://127.0.0.1:42069/graphql";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

type Runtime = {
  ok: boolean;
  mode: string;
  chainId: number;
  rpcUrl: string;
  fundRegistry: Address;
  tokenRegistry: Address;
  agentRegistry: Address;
  uniswapApiAdapter: Address;
  uniswapApiAdapterId: string;
  uniswapApprovalProxy: Address;
  uniswapUniversalRouter: Address;
  agentSwapMode: string;
  defaultAgentAssets: Address[];
  usdg: Address;
  usdgMockFeed: Address;
  tslaMockFeed: Address;
};

type Deployment = {
  agentId: Hex;
  controller: Address;
  fund: Address;
  stakeEscrow: Address;
  agentRegistry: Address;
  uniswapApiAdapter: Address;
  uniswapApiAdapterId: string;
  uniswapApprovalProxy: Address;
  uniswapUniversalRouter: Address;
  initialStake6: string;
  worldBacking: { mode: string; canonical: boolean; active: boolean };
};

type TradeIntent = {
  agentId: Hex;
  fund: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  maxSlippageBps: number;
  policyHash: Hex;
  executionHash: Hex;
  evidenceHash: Hex;
  nonce: bigint;
  validAfter: number;
  deadline: number;
};

const registryAbi = parseAbi([
  "function register(bytes32 agentId,address signer,string metadataURI)",
  "function setController(bytes32 agentId,address controller,bool enabled)",
  "function controllers(bytes32 agentId,address controller) view returns (bool)",
  "function rotateSigner(bytes32 agentId,address newSigner)",
  "function signerOf(bytes32 agentId) view returns (address)",
  "function isActive(bytes32 agentId) view returns (bool)",
]);

const controllerAbi = parseAbi([
  "function bindFund(address fund)",
  "function FUND() view returns (address)",
  "function policyHash() view returns (bytes32)",
  "function nextNonce() view returns (uint256)",
  "function sweepToSponsor(address token)",
  "function executeTrade((bytes32 agentId,address fund,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint16 maxSlippageBps,bytes32 policyHash,bytes32 executionHash,bytes32 evidenceHash,uint256 nonce,uint48 validAfter,uint48 deadline) intent,bytes adapterData,bytes signature)",
  "error TradeTooLarge()",
  "error InvalidNonce()",
  "error AgentInactive()",
]);

const fundAbi = parseAbi([
  "function share() view returns (address)",
  "function requestDeposit(uint256 amount6) returns (uint256)",
  "function executeBatch(uint256 grossClaimsWad)",
  "function nav() view returns (uint256 navWad,bool valid)",
]);
const shareAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const stakeAbi = parseAbi([
  "function addStake(uint256 amount)",
  "function stakeAvailable() view returns (uint256)",
]);
const feedAbi = parseAbi([
  "function answer() view returns (int256)",
  "function set(int256 answer,uint256 timestamp)",
]);
const proxyAbi = parseAbi([
  "function execute(address router,address token,uint256 amount,bytes commands,bytes[] inputs,uint256 deadline)",
]);

const tradeTypes = {
  TradeIntentV1: [
    { name: "agentId", type: "bytes32" },
    { name: "fund", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "policyHash", type: "bytes32" },
    { name: "executionHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "validAfter", type: "uint48" },
    { name: "deadline", type: "uint48" },
  ],
} as const;

let passed = 0;
const failures: string[] = [];
const evidence: Record<string, string> = {};

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mOK\x1b[0m  ${name}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
}

function step(number: number, title: string): void {
  console.log(`\n\x1b[1m${number}. ${title}\x1b[0m`);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

function nestedErrorName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 12 && current && typeof current === "object"; depth++) {
    const value = current as { data?: { errorName?: string }; cause?: unknown };
    if (value.data?.errorName) return value.data.errorName;
    current = value.cause;
  }
  return undefined;
}

async function expectRevert(label: string, expected: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    check(label, false, `expected ${expected}`);
  } catch (error) {
    const actual = nestedErrorName(error);
    check(label, actual === expected, `revert=${actual ?? "unknown"}`);
  }
}

async function waitFor<T>(action: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    try {
      latest = await action();
      if (accept(latest)) return latest;
    } catch {
      // Ponder may still be consuming the discovery block.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (latest !== undefined) return latest;
  throw new Error("timed out without a response");
}

async function main(): Promise<void> {
  console.log("\x1b[1mNuvem Agents — outbound-only BYOA E2E\x1b[0m");
  const runtime = await getJson<Runtime>(`${CREATOR_URL}/config`);
  if (runtime.mode !== "devnet" || runtime.agentSwapMode !== "devnet-mock") {
    throw new Error("The devnet must be restarted with the explicit chain-31337 swap proxy");
  }
  if (runtime.usdg.toLowerCase() !== USDG.toLowerCase() || runtime.defaultAgentAssets[0]?.toLowerCase() !== TSLA.toLowerCase()) {
    throw new Error("Unexpected devnet asset pack");
  }

  const chain = defineChain({
    id: runtime.chainId,
    name: "nuvem-agent-e2e",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [runtime.rpcUrl] } },
  });
  const transport = http(runtime.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const testClient = createTestClient({ mode: "anvil", chain, transport });
  const sponsor = acct[LP3]!;
  const lp = acct[LP1]!;
  const relayer = acct[DEPLOYER]!;
  const sponsorWallet = createWalletClient({ account: sponsor, chain, transport });
  const lpWallet = createWalletClient({ account: lp, chain, transport });
  const relayerWallet = createWalletClient({ account: relayer, chain, transport });
  const agent = privateKeyToAccount(generatePrivateKey());
  const replacementAgent = privateKeyToAccount(generatePrivateKey());
  const agentId = keccak256(encodePacked(
    ["string", "address", "address", "uint256"],
    ["nuvem-agent-e2e-v1", sponsor.address, agent.address, BigInt(Date.now())],
  ));

  const send = async (
    wallet: typeof sponsorWallet,
    address: Address,
    abi: readonly unknown[],
    functionName: string,
    args: readonly unknown[],
  ): Promise<Hex> => {
    const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account!, chain } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  };

  const creation = {
    manager: sponsor.address,
    name: "Agent E2E Vault",
    symbol: "AE2E",
    initialStake: "2000",
    perfFeeBps: 2000,
    feeMinBps: 200,
    feeMaxBps: 200,
    managerEntryShareBps: 5000,
    kFactor: 25,
    periodDays: 30,
    cooldownHours: 24,
    agentId,
    signer: agent.address,
    displayName: "Outbound Test Agent",
    strategySummary: "Local acceptance strategy",
    metadataUri: "ipfs://nuvem-agent-e2e",
    runtimeKind: "external",
    allowedAssets: [TSLA],
    policy: {
      maxTradeBps: 1000,
      maxConcentrationBps: 3500,
      dailyTurnoverBps: 5000,
      maxSlippageBps: 75,
      maxTradesPerDay: 24,
      minTradeInterval: 300,
      maxIntentLifetime: 300,
      allowedAssets: [TSLA],
    },
  };

  step(1, "Managed identity and external agent connect without inbound ports");
  const provisioningKey = crypto.randomUUID();
  const managedBody = JSON.stringify({ sponsor: sponsor.address, provisioningKey });
  const managedFirst = await getJson<{ managedSigner: { agentId: Hex; signer: Address; custody: string } }>(`${CREATOR_URL}/managed-signers`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": provisioningKey }, body: managedBody,
  });
  const managedSecond = await getJson<typeof managedFirst>(`${CREATOR_URL}/managed-signers`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": provisioningKey }, body: managedBody,
  });
  check(
    "Nuvem reference identity is isolated and idempotent",
    managedFirst.managedSigner.agentId === managedSecond.managedSigner.agentId
      && managedFirst.managedSigner.signer === managedSecond.managedSigner.signer
      && managedFirst.managedSigner.signer.toLowerCase() !== sponsor.address.toLowerCase(),
  );
  check(
    "managed signer response contains public identity only",
    !/(private.?key|seed|secret)/i.test(JSON.stringify(managedFirst)),
  );
  await getJson(`${CREATOR_URL}/agent-vaults/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(creation),
  });
  const registerTx = await send(sponsorWallet, runtime.agentRegistry, registryAbi, "register", [agentId, agent.address, creation.metadataUri]);
  check("agent signer remains local and only its address is registered", registerTx.startsWith("0x"));
  evidence.registerTx = registerTx;

  step(2, "World-backed activation and AI vault deployment");
  const deployed = await getJson<Deployment>(`${CREATOR_URL}/agent-vaults`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(creation),
  });
  check("local World backing is explicit and never presented as canonical", deployed.worldBacking.mode === "devnet-mock" && !deployed.worldBacking.canonical);
  check("controller and Fund are separate deployed contracts", deployed.controller !== ZERO && deployed.fund !== ZERO && deployed.controller.toLowerCase() !== deployed.fund.toLowerCase());
  evidence.controller = deployed.controller;
  evidence.fund = deployed.fund;

  step(3, "Sponsor binds authority and first-loss stake");
  evidence.controllerTx = await send(sponsorWallet, runtime.agentRegistry, registryAbi, "setController", [agentId, deployed.controller, true]);
  evidence.bindTx = await send(sponsorWallet, deployed.controller, controllerAbi, "bindFund", [deployed.fund]);
  await send(sponsorWallet, USDG, erc20Abi, "approve", [deployed.stakeEscrow, 2_000_000000n]);
  evidence.stakeTx = await send(sponsorWallet, deployed.stakeEscrow, stakeAbi, "addStake", [2_000_000000n]);
  const [active, boundFund, stakeAvailable] = await Promise.all([
    publicClient.readContract({ address: runtime.agentRegistry, abi: registryAbi, functionName: "isActive", args: [agentId] }),
    publicClient.readContract({ address: deployed.controller, abi: controllerAbi, functionName: "FUND" }),
    publicClient.readContract({ address: deployed.stakeEscrow, abi: stakeAbi, functionName: "stakeAvailable" }),
  ]);
  check("World status, controller binding and stake are all active", active && boundFund.toLowerCase() === deployed.fund.toLowerCase() && stakeAvailable === 2_000_000000n);

  step(4, "Permissionless LP deposits without KYC");
  const deposit6 = 1_000_000000n;
  const controllerFeeBefore = await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [deployed.controller] });
  await send(lpWallet as typeof sponsorWallet, USDG, erc20Abi, "approve", [deployed.fund, deposit6]);
  evidence.depositRequestTx = await send(lpWallet as typeof sponsorWallet, deployed.fund, fundAbi, "requestDeposit", [deposit6]);
  await testClient.increaseTime({ seconds: 700 });
  await testClient.mine({ blocks: 1 });
  const currentBlock = await publicClient.getBlock();
  const tslaPrice = await publicClient.readContract({ address: runtime.tslaMockFeed, abi: feedAbi, functionName: "answer" });
  await send(relayerWallet as typeof sponsorWallet, runtime.usdgMockFeed, feedAbi, "set", [100000000n, currentBlock.timestamp]);
  await send(relayerWallet as typeof sponsorWallet, runtime.tslaMockFeed, feedAbi, "set", [tslaPrice, currentBlock.timestamp]);
  try {
    evidence.depositBatchTx = await send(relayerWallet as typeof sponsorWallet, deployed.fund, fundAbi, "executeBatch", [0n]);
  } catch {
    // The live keeper can win the race after feeds are refreshed.
    evidence.depositBatchTx = "keeper-executed";
  }
  const share = await publicClient.readContract({ address: deployed.fund, abi: fundAbi, functionName: "share" });
  const lpShares = await waitFor(
    () => publicClient.readContract({ address: share, abi: shareAbi, functionName: "balanceOf", args: [lp.address] }),
    (balance) => balance > 0n,
  );
  check("LP received NAV shares with no KYC/World call", lpShares > 0n, `${formatUnits(lpShares, 18)} shares`);

  step(5, "Entry fee reaches the controller and is swept to sponsor");
  const controllerFeeAfter = await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [deployed.controller] });
  const managerFee6 = controllerFeeAfter - controllerFeeBefore;
  const sponsorBeforeSweep = await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [sponsor.address] });
  evidence.feeSweepTx = await send(relayerWallet as typeof sponsorWallet, deployed.controller, controllerAbi, "sweepToSponsor", [USDG]);
  const [sponsorAfterSweep, controllerAfterSweep] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [sponsor.address] }),
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [deployed.controller] }),
  ]);
  check("fixed 2% entry fee generated the configured manager share", managerFee6 === 10_000000n, `${formatUnits(managerFee6, 6)} USDG`);
  check("permissionless sweep has a fixed sponsor recipient", sponsorAfterSweep - sponsorBeforeSweep === managerFee6 && controllerAfterSweep === 0n);

  const makeExecution = (amountIn: bigint, nonce: bigint, label: string, blockTimestamp: bigint) => {
    const quotedOut = amountIn * 10n ** 20n / tslaPrice;
    const amountOut = quotedOut * 9_970n / 10_000n;
    const validAfter = Number(blockTimestamp > 0n ? blockTimestamp - 1n : 0n);
    const deadline = Number(blockTimestamp + 240n);
    const route = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }],
      [TSLA, deployed.fund, amountOut],
    );
    const callData = encodeFunctionData({
      abi: proxyAbi,
      functionName: "execute",
      args: [deployed.uniswapUniversalRouter, USDG, amountIn, route, [], BigInt(deadline)],
    });
    const adapterData = encodeAbiParameters(
      [{
        type: "tuple",
        components: [
          { name: "minAmountOut", type: "uint256" },
          { name: "deadline", type: "uint48" },
          { name: "callData", type: "bytes" },
        ],
      }],
      [{ minAmountOut: amountOut, deadline, callData }],
    );
    const executionHash = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes" }],
      [BigInt(deployed.uniswapApiAdapterId), adapterData],
    ));
    return { amountOut, adapterData, executionHash, validAfter, deadline, evidenceHash: keccak256(toHex(label)) };
  };

  const policyHash = await publicClient.readContract({ address: deployed.controller, abi: controllerAbi, functionName: "policyHash" });
  const nonce = await publicClient.readContract({ address: deployed.controller, abi: controllerAbi, functionName: "nextNonce" });
  const tradeBlock = await publicClient.getBlock();

  const signedIntent = async (amountIn: bigint, label: string): Promise<{ intent: TradeIntent; adapterData: Hex; signature: Hex; amountOut: bigint }> => {
    const execution = makeExecution(amountIn, nonce, label, tradeBlock.timestamp);
    const intent: TradeIntent = {
      agentId,
      fund: deployed.fund,
      tokenIn: USDG,
      tokenOut: TSLA,
      amountIn,
      minAmountOut: execution.amountOut,
      maxSlippageBps: 75,
      policyHash,
      executionHash: execution.executionHash,
      evidenceHash: execution.evidenceHash,
      nonce,
      validAfter: execution.validAfter,
      deadline: execution.deadline,
    };
    const signature = await agent.signTypedData({
      domain: { name: "Nuvem AgentVaultController", version: "1", chainId: runtime.chainId, verifyingContract: deployed.controller },
      types: tradeTypes,
      primaryType: "TradeIntentV1",
      message: intent,
    });
    return { intent, adapterData: execution.adapterData, signature, amountOut: execution.amountOut };
  };

  step(6, "On-chain policy rejects an oversized signed trade");
  const rejected = await signedIntent(200_000000n, "oversized-policy-rejection");
  await expectRevert("trade above 10% NAV is rejected before swap", "TradeTooLarge", async () => {
    await publicClient.simulateContract({
      address: deployed.controller,
      abi: controllerAbi,
      functionName: "executeTrade",
      args: [rejected.intent, rejected.adapterData, rejected.signature],
      account: relayer.address,
    });
  });
  check("rejected trade did not consume the agent nonce", await publicClient.readContract({ address: deployed.controller, abi: controllerAbi, functionName: "nextNonce" }) === nonce);

  step(7, "Valid evidence-bound intent executes through the API adapter path");
  const valid = await signedIntent(50_000000n, "evidence-bound-local-uniswap-plan");
  const [fundUsdgBefore, fundTslaBefore] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [deployed.fund] }),
    publicClient.readContract({ address: TSLA, abi: erc20Abi, functionName: "balanceOf", args: [deployed.fund] }),
  ]);
  const tradeTx = await send(relayerWallet as typeof sponsorWallet, deployed.controller, controllerAbi, "executeTrade", [valid.intent, valid.adapterData, valid.signature]);
  evidence.tradeTx = tradeTx;
  const [fundUsdgAfter, fundTslaAfter, nonceAfter] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [deployed.fund] }),
    publicClient.readContract({ address: TSLA, abi: erc20Abi, functionName: "balanceOf", args: [deployed.fund] }),
    publicClient.readContract({ address: deployed.controller, abi: controllerAbi, functionName: "nextNonce" }),
  ]);
  check("adapter spent exactly the signed amount", fundUsdgBefore - fundUsdgAfter === valid.intent.amountIn);
  check("Fund received at least signed minOut atomically", fundTslaAfter - fundTslaBefore >= valid.intent.minAmountOut);
  check("successful trade consumed exactly one nonce", nonceAfter === nonce + 1n);

  step(8, "Agent restart/rebroadcast cannot duplicate the trade");
  await expectRevert("same signed bytes are rejected after restart", "InvalidNonce", async () => {
    await publicClient.simulateContract({
      address: deployed.controller,
      abi: controllerAbi,
      functionName: "executeTrade",
      args: [valid.intent, valid.adapterData, valid.signature],
      account: relayer.address,
    });
  });
  const [fundUsdgReplay, fundTslaReplay] = await Promise.all([
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [deployed.fund] }),
    publicClient.readContract({ address: TSLA, abi: erc20Abi, functionName: "balanceOf", args: [deployed.fund] }),
  ]);
  check("replay leaves both Fund balances unchanged", fundUsdgReplay === fundUsdgAfter && fundTslaReplay === fundTslaAfter);

  step(9, "Ponder exposes the Fund, deposit and trade to the frontend");
  const indexed = await waitFor(
    async () => {
      const response = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ funds { items { address manager lifetimeDeposited6 } } trades { items { fund adapterId txHash spent received } } activitys { items { fund kind txHash } } }" }),
      });
      const json = await response.json() as { data?: { funds: { items: Array<{ address: string }> }; trades: { items: Array<{ fund: string; txHash: string }> }; activitys: { items: Array<{ fund: string; kind: string }> } }; errors?: unknown };
      if (!response.ok || json.errors || !json.data) throw new Error(`GraphQL failed: ${JSON.stringify(json.errors)}`);
      return json.data;
    },
    (data) => data.funds.items.some((item) => item.address.toLowerCase() === deployed.fund.toLowerCase())
      && data.trades.items.some((item) => item.txHash.toLowerCase() === tradeTx.toLowerCase())
      && data.activitys.items.some((item) => item.fund.toLowerCase() === deployed.fund.toLowerCase() && item.kind === "deposit_executed"),
    90_000,
  );
  check("dynamic Fund discovery reached Ponder", indexed.funds.items.some((item) => item.address.toLowerCase() === deployed.fund.toLowerCase()));
  check("the exact trade transaction is queryable", indexed.trades.items.some((item) => item.txHash.toLowerCase() === tradeTx.toLowerCase()));

  step(10, "Sponsor rotation invalidates the old agent immediately");
  evidence.rotateTx = await send(sponsorWallet, runtime.agentRegistry, registryAbi, "rotateSigner", [agentId, replacementAgent.address]);
  const [activeAfterRotation, signerAfterRotation] = await Promise.all([
    publicClient.readContract({ address: runtime.agentRegistry, abi: registryAbi, functionName: "isActive", args: [agentId] }),
    publicClient.readContract({ address: runtime.agentRegistry, abi: registryAbi, functionName: "signerOf", args: [agentId] }),
  ]);
  check("rotation returns the agent to PendingBacking", !activeAfterRotation && signerAfterRotation.toLowerCase() === replacementAgent.address.toLowerCase());
  const postRotationBlock = await publicClient.getBlock();
  const postRotationExecution = makeExecution(20_000000n, nonceAfter, "old-key-after-rotation", postRotationBlock.timestamp);
  const oldIntent: TradeIntent = {
    ...valid.intent,
    amountIn: 20_000000n,
    minAmountOut: postRotationExecution.amountOut,
    executionHash: postRotationExecution.executionHash,
    evidenceHash: postRotationExecution.evidenceHash,
    nonce: nonceAfter,
    validAfter: postRotationExecution.validAfter,
    deadline: postRotationExecution.deadline,
  };
  const oldSignature = await agent.signTypedData({
    domain: { name: "Nuvem AgentVaultController", version: "1", chainId: runtime.chainId, verifyingContract: deployed.controller },
    types: tradeTypes,
    primaryType: "TradeIntentV1",
    message: oldIntent,
  });
  await expectRevert("old key cannot trade after sponsor rotation", "AgentInactive", async () => {
    await publicClient.simulateContract({
      address: deployed.controller,
      abi: controllerAbi,
      functionName: "executeTrade",
      args: [oldIntent, postRotationExecution.adapterData, oldSignature],
      account: relayer.address,
    });
  });

  const [navWad, navValid] = await publicClient.readContract({ address: deployed.fund, abi: fundAbi, functionName: "nav" });
  check("final Fund NAV remains valid", navValid && navWad > 0n, `$${formatUnits(navWad, 18)}`);

  console.log("\n\x1b[1mAcceptance report\x1b[0m");
  console.log(`  ${passed} checks passed; ${failures.length} failed`);
  console.log(`  agent signer address: ${agent.address} (ephemeral key was never printed or persisted)`);
  for (const [key, value] of Object.entries(evidence)) console.log(`  ${key}: ${value}`);
  console.log("  swap mode: devnet-mock proxy + production UniswapApiAdapter bytecode");
  console.log("  World mode: local non-canonical attestation; canonical AgentBook is covered by gateway tests");
  if (failures.length) throw new Error(`Agent E2E failures:\n- ${failures.join("\n- ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

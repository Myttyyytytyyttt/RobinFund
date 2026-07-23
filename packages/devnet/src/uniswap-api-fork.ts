/**
 * Executes calldata returned by the real Uniswap Trading API against a fresh
 * Robinhood Chain 4663 fork. No transaction is broadcast to a public chain.
 *
 * This closes a narrower gate than the normal devnet proxy test: it proves the
 * production UniswapApiAdapter can approve the API-selected proxy, execute its
 * exact CLASSIC calldata, enforce minOut, and finish without allowance/dust.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  bootAnvil,
  contractsDir,
  dealErc20,
  DEPLOYER,
  loadRootEnv,
  MANAGER,
  TSLA,
  USDG,
  write,
  type Devnet,
} from "./chain.js";
import { createFund, deployProtocol, pushFeeds } from "./deploy.js";
import { fundAbi } from "./abis.js";

const CHAIN_ID = 4663;
const AMOUNT_IN = 1_000_000n; // 1 USDG
const STAKE = 100_000_000n; // 100 USDG; keeps the Fund slippage budget economically live
const MAX_SLIPPAGE_BPS = 75n;
const PORT = 9100 + (process.pid % 300);

const adapterRegistryAbi = parseAbi([
  "function count() view returns (uint256)",
  "function add(address adapter) returns (uint256)",
]);
const adapterAbi = parseAbi([
  "function APPROVAL_PROXY() view returns (address)",
  "function UNIVERSAL_ROUTER() view returns (address)",
]);
const stakeAbi = parseAbi(["function addStake(uint256 amount)"]);
const approvalProxyAbi = parseAbi([
  "function execute(address router,address token,uint256 amount,bytes commands,bytes[] inputs,uint256 deadline)",
]);

type Json = Record<string, unknown>;

function object(value: unknown, name: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} missing`);
  return value as Json;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} missing from the gitignored root .env`);
  return value;
}

async function postUniswap(path: string, body: unknown): Promise<Json> {
  const base = process.env.UNISWAP_API_BASE_URL ?? "https://trade-api.gateway.uniswap.org/v1";
  const response = await fetch(new URL(path, `${base.replace(/\/$/, "")}/`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": required("UNISWAP_API_KEY"),
      "x-permit2-disabled": "true",
      "x-universal-router-version": "2.1.1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Uniswap ${path} returned HTTP ${response.status}`);
  return object(await response.json(), `Uniswap ${path} response`);
}

async function deployApiAdapter(d: Devnet, proxy: Address, router: Address): Promise<Address> {
  const artifact = JSON.parse(
    readFileSync(resolve(contractsDir, "out/UniswapApiAdapter.sol/UniswapApiAdapter.json"), "utf8"),
  ) as { abi: Abi; bytecode: { object: Hex } };
  const hash = await d.wallets[DEPLOYER]!.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [proxy, router],
    account: d.wallets[DEPLOYER]!.account!,
    chain: d.chain,
  });
  const receipt = await d.pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress || receipt.status !== "success") throw new Error("adapter deployment failed");
  return receipt.contractAddress;
}

async function main(): Promise<void> {
  loadRootEnv();
  const expectedProxy = getAddress(required("UNISWAP_APPROVAL_PROXY"));
  const expectedRouter = getAddress(required("UNISWAP_UNIVERSAL_ROUTER"));
  console.log("Nuvem Agents — real Uniswap API calldata on a 4663 fork");
  console.log("No public transaction will be sent and no API key will be printed.");

  const d = await bootAnvil(PORT);
  try {
    const [proxyCode, routerCode] = await Promise.all([
      d.pub.getBytecode({ address: expectedProxy }),
      d.pub.getBytecode({ address: expectedRouter }),
    ]);
    if (!proxyCode || proxyCode === "0x") throw new Error("configured approval proxy has no fork bytecode");
    if (!routerCode || routerCode === "0x") throw new Error("configured Universal Router has no fork bytecode");

    const protocol = await deployProtocol(d);
    const fund = await createFund(d, protocol, "Uniswap API Fork Probe", "UAFP");
    const adapter = await deployApiAdapter(d, expectedProxy, expectedRouter);
    const adapterId = await d.pub.readContract({
      address: protocol.adapterRegistry,
      abi: adapterRegistryAbi,
      functionName: "count",
    });
    await write(d, DEPLOYER, protocol.adapterRegistry, adapterRegistryAbi, "add", [adapter]);
    const [configuredProxy, configuredRouter] = await Promise.all([
      d.pub.readContract({ address: adapter, abi: adapterAbi, functionName: "APPROVAL_PROXY" }),
      d.pub.readContract({ address: adapter, abi: adapterAbi, functionName: "UNIVERSAL_ROUTER" }),
    ]);
    if (configuredProxy.toLowerCase() !== expectedProxy.toLowerCase()) throw new Error("adapter proxy drift");
    if (configuredRouter.toLowerCase() !== expectedRouter.toLowerCase()) throw new Error("adapter router drift");

    await dealErc20(d, USDG, fund, 100_000_000n);
    const stakeEscrow = await d.pub.readContract({ address: fund, abi: fundAbi, functionName: "stakeEscrow" });
    await dealErc20(d, USDG, d.wallets[MANAGER]!.account!.address, STAKE);
    await write(d, MANAGER, USDG, erc20Abi, "approve", [stakeEscrow, STAKE]);
    await write(d, MANAGER, stakeEscrow, stakeAbi, "addStake", [STAKE]);
    await pushFeeds(d, protocol);

    const quoteResponse = await postUniswap("quote", {
      type: "EXACT_INPUT",
      amount: AMOUNT_IN.toString(),
      tokenInChainId: CHAIN_ID,
      tokenOutChainId: CHAIN_ID,
      tokenIn: USDG,
      tokenOut: TSLA,
      swapper: adapter,
      recipient: fund,
      slippageTolerance: Number(MAX_SLIPPAGE_BPS) / 100,
      protocols: ["V2", "V3", "V4"],
    });
    const quote = object(quoteResponse.quote, "quote");
    const routing = String(quoteResponse.routing ?? quote.routing ?? "").toUpperCase();
    if (routing !== "CLASSIC" || quoteResponse.permitData != null) throw new Error("quote is not CLASSIC/no-Permit2");
    const output = object(quote.output, "quote.output");
    const quotedOut = BigInt(String(output.amount));
    const minOut = output.minimumAmount == null
      ? quotedOut * (10_000n - MAX_SLIPPAGE_BPS) / 10_000n
      : BigInt(String(output.minimumAmount));
    if (quotedOut <= 0n || minOut <= 0n || minOut > quotedOut) throw new Error("invalid quote amounts");

    const chainTimestamp = Number((await d.pub.getBlock()).timestamp);
    const deadline = Math.max(Math.floor(Date.now() / 1_000), chainTimestamp) + 300;
    const swapResponse = await postUniswap("swap", { quote, simulateTransaction: false, deadline });
    const swap = object(swapResponse.swap, "swap");
    const target = getAddress(String(swap.to));
    const from = getAddress(String(swap.from));
    const value = BigInt(String(swap.value ?? 0));
    const routeCalldata = String(swap.data) as Hex;
    if (target.toLowerCase() !== expectedProxy.toLowerCase()) throw new Error("Trading API proxy target changed");
    if (from.toLowerCase() !== adapter.toLowerCase()) throw new Error("Trading API swapper binding changed");
    if (Number(swap.chainId) !== CHAIN_ID || value !== 0n) throw new Error("Trading API chain/value mismatch");

    const decoded = decodeFunctionData({ abi: approvalProxyAbi, data: routeCalldata });
    const [proxyRouter, proxyTokenIn, proxyAmountIn, , , proxyDeadline] = decoded.args;
    if (
      decoded.functionName !== "execute"
      || proxyRouter.toLowerCase() !== expectedRouter.toLowerCase()
      || proxyTokenIn.toLowerCase() !== USDG.toLowerCase()
      || proxyAmountIn !== AMOUNT_IN
      || proxyDeadline < BigInt(deadline)
    ) {
      throw new Error(
        `approval-proxy calldata binding mismatch: function=${decoded.functionName}`
        + ` router=${proxyRouter} tokenIn=${proxyTokenIn}`
        + ` amountIn=${proxyAmountIn} deadline=${proxyDeadline} requestedDeadline=${deadline}`,
      );
    }

    const adapterData = encodeAbiParameters(
      [{
        type: "tuple",
        components: [
          { name: "minAmountOut", type: "uint256" },
          { name: "deadline", type: "uint48" },
          { name: "callData", type: "bytes" },
        ],
      }],
      [{ minAmountOut: minOut, deadline, callData: routeCalldata }],
    );

    const [outBefore, allowanceBefore] = await Promise.all([
      d.pub.readContract({ address: TSLA, abi: erc20Abi, functionName: "balanceOf", args: [fund] }),
      d.pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [adapter, expectedProxy] }),
    ]);
    if (allowanceBefore !== 0n) throw new Error("adapter began with residual allowance");
    const tradeTx = await write(d, MANAGER, fund, fundAbi, "execute", [adapterId, USDG, TSLA, AMOUNT_IN, adapterData]);
    const [outAfter, allowanceAfter, adapterIn, adapterOut] = await Promise.all([
      d.pub.readContract({ address: TSLA, abi: erc20Abi, functionName: "balanceOf", args: [fund] }),
      d.pub.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [adapter, expectedProxy] }),
      d.pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [adapter] }),
      d.pub.readContract({ address: TSLA, abi: erc20Abi, functionName: "balanceOf", args: [adapter] }),
    ]);
    const received = outAfter - outBefore;
    if (received < minOut) throw new Error("Fund received less than minOut");
    if (allowanceAfter !== 0n || adapterIn !== 0n || adapterOut !== 0n) throw new Error("adapter left allowance or token residue");

    console.log(`PASS routing=${routing}`);
    console.log(`PASS proxy=${expectedProxy}`);
    console.log(`PASS universalRouter=${expectedRouter}`);
    console.log(`PASS adapter=${adapter} adapterId=${adapterId}`);
    console.log(`PASS fund=${fund}`);
    console.log(`PASS stakeEscrow=${stakeEscrow} stake6=${STAKE}`);
    console.log(`PASS quotedOut=${quotedOut} minOut=${minOut} received=${received}`);
    console.log(`PASS allowanceAfter=${allowanceAfter} adapterResidues=${adapterIn}/${adapterOut}`);
    console.log(`PASS tradeTx=${tradeTx}`);
  } finally {
    clearInterval(d.heartbeat);
    d.anvil.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

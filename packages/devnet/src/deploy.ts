/**
 * Deploy del protocolo sobre el fork con los scripts REALES de producción, más las dos piezas
 * devnet-only: feeds USDG/TSLA re-apuntados a MockFeeds controlables (un fork no publica rondas
 * nuevas y el forward pricing las exige), sembrados con los precios reales del momento del fork.
 * El acceso es permissionless mediante OpenEligibilityGate: no hay bootstrap ni signer.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeAbiParameters, parseAbi, type Address, type Hex } from "viem";
import { acct, contractsDir, DEPLOYER, PK, TSLA, TSLA_FEED, USDG, write, type Devnet } from "./chain.js";

export interface Protocol {
  tokenRegistry: Address;
  adapterRegistry: Address;
  eligibilityGate: Address;
  guardian: Address;
  fundRegistry: Address;
  usdgMockFeed: Address;
  tslaMockFeed: Address;
  deployBlock: bigint;
  funds: Address[];
}

const registryAbi = parseAbi([
  "function setUsdgFeed(address feed, uint48 maxStaleness, int256 minAnswer, int256 maxAnswer)",
  "function setFeed(address token, address feed, uint48 maxStaleness, int256 minAnswer, int256 maxAnswer)",
  "function funds(uint256) view returns (address)",
]);
const feedReadAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
export const mockFeedAbi = [
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
  { type: "function", name: "answer", stateMutability: "view", inputs: [], outputs: [{ type: "int256" }] },
] as const;
export function forgeScript(script: string, rpcUrl: string, extraEnv: Record<string, string>): void {
  const res = spawnSync(
    "forge",
    ["script", script, "--rpc-url", rpcUrl, "--broadcast", "--private-key", PK[0]],
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

async function deployMockFeed(d: Devnet, seedAnswer: bigint): Promise<Address> {
  const artifact = JSON.parse(
    readFileSync(resolve(contractsDir, "out/Mocks.sol/MockFeed.json"), "utf8"),
  ) as { bytecode: { object: Hex } };
  const hash = await d.wallets[DEPLOYER]!.deployContract({
    abi: mockFeedAbi,
    bytecode: artifact.bytecode.object,
    args: [seedAnswer],
    account: acct[DEPLOYER]!,
    chain: d.chain,
  });
  const rec = await d.pub.waitForTransactionReceipt({ hash });
  return rec.contractAddress!;
}

/** Precio real del feed en el fork (para sembrar el mock con la verdad del momento). */
async function realAnswer(d: Devnet, feed: Address): Promise<bigint> {
  const [, answer] = (await d.pub.readContract({
    address: feed,
    abi: feedReadAbi,
    functionName: "latestRoundData",
  })) as readonly [bigint, bigint, bigint, bigint, bigint];
  return answer;
}

export async function deployProtocol(d: Devnet): Promise<Protocol> {
  const deployBlock = await d.pub.getBlockNumber();

  forgeScript("script/Deploy.s.sol", d.rpcUrl, {
    GUARDIAN_MULTISIG: acct[8]!.address,
  });
  const a = parseBroadcast("Deploy.s.sol", d.chainId);
  for (const name of ["TokenRegistry", "AdapterRegistry", "OpenEligibilityGate", "Guardian", "FundRegistry"]) {
    if (!a[name]) throw new Error(`el broadcast no contiene ${name}`);
  }

  // feeds → mocks sembrados con los precios REALES del fork (el deployer aún es owner: two-step)
  const usdgPx = await realAnswer(d, "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2" as Address);
  const tslaPx = await realAnswer(d, TSLA_FEED);
  const usdgMockFeed = await deployMockFeed(d, usdgPx);
  const tslaMockFeed = await deployMockFeed(d, tslaPx);
  await write(d, DEPLOYER, a.TokenRegistry!, registryAbi, "setUsdgFeed", [usdgMockFeed, 90000, 90000000n, 110000000n]);
  await write(d, DEPLOYER, a.TokenRegistry!, registryAbi, "setFeed", [
    TSLA,
    tslaMockFeed,
    90000,
    1_00000000n,
    100_000_00000000n,
  ]);

  return {
    tokenRegistry: a.TokenRegistry!,
    adapterRegistry: a.AdapterRegistry!,
    eligibilityGate: a.OpenEligibilityGate!,
    guardian: a.Guardian!,
    fundRegistry: a.FundRegistry!,
    usdgMockFeed,
    tslaMockFeed,
    deployBlock,
    funds: [],
  };
}

export async function createFund(
  d: Devnet,
  p: Protocol,
  name: string,
  symbol: string,
  extra: Record<string, string> = {},
): Promise<Address> {
  forgeScript("script/CreateFund.s.sol", d.rpcUrl, {
    TOKEN_REGISTRY: p.tokenRegistry,
    ADAPTER_REGISTRY: p.adapterRegistry,
    ELIGIBILITY_GATE: p.eligibilityGate,
    FUND_REGISTRY: p.fundRegistry,
    GUARDIAN: p.guardian,
    FUND_MANAGER: acct[3]!.address,
    KEEPER: acct[2]!.address,
    PROTOCOL_TREASURY: acct[7]!.address,
    FUND_NAME: name,
    FUND_SYMBOL: symbol,
    ...extra,
  });
  const fund = (await d.pub.readContract({
    address: p.fundRegistry,
    abi: registryAbi,
    functionName: "funds",
    args: [BigInt(p.funds.length)],
  })) as Address;
  p.funds.push(fund);
  return fund;
}

/** Publica rondas frescas en AMBOS mock feeds con el timestamp actual de la chain. */
export async function pushFeeds(d: Devnet, p: Protocol, tslaAnswer?: bigint): Promise<void> {
  const t = (await d.pub.getBlock()).timestamp;
  await write(d, DEPLOYER, p.usdgMockFeed, mockFeedAbi, "set", [100000000n, t]);
  const tsla =
    tslaAnswer ??
    ((await d.pub.readContract({ address: p.tslaMockFeed, abi: mockFeedAbi, functionName: "answer" })) as bigint);
  await write(d, DEPLOYER, p.tslaMockFeed, mockFeedAbi, "set", [tsla, t]);
}

/** `abi.encode(PoolKey)` TSLA/USDG v4 real (fee 3000, tickSpacing 60, sin hooks) — el data de execute(). */
export function encodePoolKey(): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
    ],
    [{ currency0: TSLA, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" }],
  );
}

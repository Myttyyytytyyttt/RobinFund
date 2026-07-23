import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  encodeAbiParameters,
  formatEther,
  formatGwei,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  broadcastCreates,
  contractsDir,
  loadRootEnv,
  onlyCreate,
  requirePrivateKey,
  runForge,
} from "./common.js";

type BroadcastTx = {
  transactionType: string;
  contractName?: string;
  contractAddress?: Address;
  hash?: Hex;
};

const adapterRegistry = "0xca3ed32482e64c62cc50c72a01493ea5b33a689e" as Address;
const agentRegistry = "0xa27e31af49cea5113fe84f69c2b91b999b48491b" as Address;
const tokens = [
  "0x336c508083e2afe17c594a8ef5b8542efcf672d5",
  "0x3f1a8f0a7d944875e3350b0c78d56d22990a6e2f",
  "0x3b334d58c329f7a98ca3c11a09e45ae3352263ae",
  "0x6fd0d905af9841a2a268ab4784efe24575a48d1c",
  "0x5cc41b676e626c29fa685c1e9057d0264d3c6f05",
  "0x2b41f3c8b61e7188a2c7dbf494ebf6d0beaced22",
] as Address[];

const registryAbi = parseAbi([
  "function owner() view returns (address)",
  "function count() view returns (uint256)",
  "function get(uint256) view returns (address)",
]);
const adapterAbi = parseAbi([
  "function VENUE() view returns (address)",
  "function assets(address) view returns (address feed,uint8 tokenDecimals,bool enabled)",
  "function validateExecution(address,address,uint256,address,uint256,bytes) view returns (bool)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main(): Promise<void> {
  loadRootEnv();
  const rpcUrl = process.env.RH_RPC_TESTNET;
  if (!rpcUrl) throw new Error("falta RH_RPC_TESTNET en el .env raiz");
  const privateKey = requirePrivateKey(
    process.env.TESTNET_DEPLOYER_PK ?? process.env.DEPLOYER_PK,
    "TESTNET_DEPLOYER_PK/DEPLOYER_PK",
  );
  const deployer = privateKeyToAccount(privateKey);
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) });
  const [chainId, startBlock, balance, gasPrice, owner, count] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getBalance({ address: deployer.address }),
    client.getGasPrice(),
    client.readContract({ address: adapterRegistry, abi: registryAbi, functionName: "owner" }),
    client.readContract({ address: adapterRegistry, abi: registryAbi, functionName: "count" }),
  ]);
  if (chainId !== 46_630) throw new Error(`RPC equivocado: ${chainId}`);
  if (owner.toLowerCase() !== deployer.address.toLowerCase() || count !== 1n) {
    throw new Error("AdapterRegistry publico no esta en el estado previo esperado");
  }
  if (balance < 500_000_000_000_000n) throw new Error(`saldo insuficiente: ${formatEther(balance)} ETH`);
  if (process.env.ALLOW_TESTNET_BROADCAST !== "1") {
    throw new Error("preflight correcto; falta ALLOW_TESTNET_BROADCAST=1");
  }

  console.log(JSON.stringify({
    phase: "preflight",
    chainId,
    startBlock: startBlock.toString(),
    deployer: deployer.address,
    adapterCount: count.toString(),
    balanceEth: formatEther(balance),
    gasPriceGwei: formatGwei(gasPrice),
  }));

  await runForge("script/DeployAgentTestnetAdapter.s.sol", "robinhood_testnet", privateKey, {
    ALLOW_TESTNET_BROADCAST: "1",
  });

  const creates = broadcastCreates("DeployAgentTestnetAdapter.s.sol", chainId) as BroadcastTx[];
  const venue = onlyCreate(creates, "TestnetLiquidityVenue");
  const adapter = onlyCreate(creates, "TestnetTradeAdapter");
  const deployment = creates.find((tx) => tx.contractName === "TestnetTradeAdapter");
  if (!deployment?.hash) throw new Error("broadcast sin hash del adapter");
  const receipt = await client.waitForTransactionReceipt({ hash: deployment.hash, confirmations: 2 });
  const deadline = Math.floor(Date.now() / 1_000) + 300;
  const plan = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint48" }],
    [1n, deadline],
  );
  const [registered, venueOnchain, valid, code, endBalance, configs, liquidity] = await Promise.all([
    client.readContract({ address: adapterRegistry, abi: registryAbi, functionName: "get", args: [1n] }),
    client.readContract({ address: adapter, abi: adapterAbi, functionName: "VENUE" }),
    client.readContract({
      address: adapter,
      abi: adapterAbi,
      functionName: "validateExecution",
      args: [tokens[0]!, tokens[1]!, 1_000_000n, agentRegistry, 1n, plan],
    }),
    client.getBytecode({ address: adapter }),
    client.getBalance({ address: deployer.address }),
    Promise.all(tokens.map((token) => client.readContract({ address: adapter, abi: adapterAbi, functionName: "assets", args: [token] }))),
    Promise.all(tokens.map((token) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [venue] }))),
  ]);
  if (
    registered.toLowerCase() !== adapter.toLowerCase()
    || venueOnchain.toLowerCase() !== venue.toLowerCase()
    || !valid || !code
    || configs.some((config) => !config[2])
    || liquidity.some((amount) => amount === 0n)
  ) throw new Error("verificacion publica del adapter agent-compatible fallo");

  const broadcastPath = resolve(contractsDir, `broadcast/DeployAgentTestnetAdapter.s.sol/${chainId}/run-latest.json`);
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8")) as { transactions: Array<{ hash?: Hex }> };
  const hashes = broadcast.transactions.map((tx) => tx.hash).filter(Boolean);
  console.log(JSON.stringify({
    ok: true,
    chainId,
    adapterId: "1",
    venue,
    adapter,
    deployTransactionHash: deployment.hash,
    transactionHashes: hashes,
    blockNumber: receipt.blockNumber.toString(),
    runtimeBytes: (code.length - 2) / 2,
    assetsEnabled: configs.length,
    venueLiquidityChecks: liquidity.length,
    validateExecution: valid,
    costEth: formatEther(balance - endBalance),
    balanceAfterEth: formatEther(endBalance),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

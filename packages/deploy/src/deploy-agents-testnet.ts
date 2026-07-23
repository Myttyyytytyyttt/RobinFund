import {
  createPublicClient,
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

const registryAbi = parseAbi([
  "function WORLD_VERIFIER() view returns (address)",
]);
const adapterRegistryAbi = parseAbi([
  "function get(uint256) view returns (address)",
]);

async function main(): Promise<void> {
  loadRootEnv();
  const rpcUrl = process.env.RH_RPC_TESTNET;
  if (!rpcUrl) throw new Error("falta RH_RPC_TESTNET en el .env raíz");
  const deployerPk = requirePrivateKey(
    process.env.TESTNET_DEPLOYER_PK ?? process.env.DEPLOYER_PK,
    "TESTNET_DEPLOYER_PK/DEPLOYER_PK",
  );
  const verifierPk = requirePrivateKey(
    process.env.WORLD_VERIFIER_PRIVATE_KEY,
    "WORLD_VERIFIER_PRIVATE_KEY",
  );
  const deployer = privateKeyToAccount(deployerPk);
  const verifier = privateKeyToAccount(verifierPk).address;
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) });

  const [chainId, startBlock, balance, gasPrice] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getBalance({ address: deployer.address }),
    client.getGasPrice(),
  ]);
  if (chainId !== 46_630) throw new Error(`RPC equivocado: chain ID ${chainId}, esperaba 46630`);
  if (balance < 500_000_000_000_000n) {
    throw new Error(`saldo insuficiente para el canario Agents: ${formatEther(balance)} ETH`);
  }
  if (process.env.ALLOW_TESTNET_BROADCAST !== "1") {
    throw new Error("preflight correcto, pero falta ALLOW_TESTNET_BROADCAST=1 para autorizar el broadcast");
  }

  const adapterRegistry = "0xca3ed32482e64c62cc50c72a01493ea5b33a689e" as Address;
  const expectedAdapter = "0xb6c1d1017e456427de9e52df3b29392862e80da3" as Address;
  const adapter = await client.readContract({
    address: adapterRegistry,
    abi: adapterRegistryAbi,
    functionName: "get",
    args: [0n],
  });
  if (adapter.toLowerCase() !== expectedAdapter.toLowerCase()) {
    throw new Error(`adapter id 0 inesperado: ${adapter}`);
  }

  console.log(JSON.stringify({
    phase: "preflight",
    chainId,
    startBlock: startBlock.toString(),
    deployer: deployer.address,
    worldVerifier: verifier,
    adapterId: "0",
    adapter,
    balanceEth: formatEther(balance),
    gasPriceGwei: formatGwei(gasPrice),
  }));

  await runForge(
    "script/DeployAgentRegistryTestnet.s.sol",
    "robinhood_testnet",
    deployerPk,
    { WORLD_VERIFIER: verifier },
  );

  const creates = broadcastCreates("DeployAgentRegistryTestnet.s.sol", chainId) as BroadcastTx[];
  const registry = onlyCreate(creates, "AgentRegistry");
  const deployment = creates.find((tx) => tx.contractName === "AgentRegistry");
  if (!deployment?.hash) throw new Error("broadcast sin hash del AgentRegistry");

  const receipt = await client.waitForTransactionReceipt({ hash: deployment.hash, confirmations: 2 });
  const [code, onchainVerifier, endBalance] = await Promise.all([
    client.getBytecode({ address: registry }),
    client.readContract({ address: registry, abi: registryAbi, functionName: "WORLD_VERIFIER" }),
    client.getBalance({ address: deployer.address }),
  ]);
  if (!code || onchainVerifier.toLowerCase() !== verifier.toLowerCase()) {
    throw new Error("verificación pública del AgentRegistry falló");
  }

  console.log(JSON.stringify({
    ok: true,
    chainId,
    agentRegistry: registry,
    worldVerifier: onchainVerifier,
    transactionHash: deployment.hash,
    blockNumber: receipt.blockNumber.toString(),
    runtimeBytes: (code.length - 2) / 2,
    adapterId: "0",
    adapter,
    gasUsed: receipt.gasUsed.toString(),
    costEth: formatEther(balance - endBalance),
    balanceAfterEth: formatEther(endBalance),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

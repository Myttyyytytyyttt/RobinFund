import {
  createPublicClient,
  formatEther,
  formatGwei,
  http,
  isAddress,
  parseAbi,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assetEnv,
  loadRootEnv,
  requiredTestnetBalanceWei,
  protocolEnv,
  readAssetManifest,
  readProtocolManifest,
  requirePrivateKey,
  runForge,
} from "./common.js";

function optionalAddress(name: string, fallback: Address): Address {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!isAddress(value)) throw new Error(`${name} no es una address EVM válida`);
  return value;
}

async function main(): Promise<void> {
  loadRootEnv();
  const rpcUrl = process.env.RH_RPC_TESTNET;
  if (!rpcUrl) throw new Error("falta RH_RPC_TESTNET en el .env raíz");
  const pk = requirePrivateKey(
    process.env.TESTNET_DEPLOYER_PK ?? process.env.DEPLOYER_PK,
    "TESTNET_DEPLOYER_PK/DEPLOYER_PK",
  );
  const account = privateKeyToAccount(pk);
  const client = createPublicClient({ transport: http(rpcUrl) });
  const [chainId, balance, startBlock, gasPrice] = await Promise.all([
    client.getChainId(),
    client.getBalance({ address: account.address }),
    client.getBlockNumber(),
    client.getGasPrice(),
  ]);
  if (chainId !== 46_630) throw new Error(`RPC equivocado: chain ID ${chainId}, esperaba 46630`);
  const requiredBalance = requiredTestnetBalanceWei(gasPrice);
  if (balance < requiredBalance) {
    throw new Error(
      `wallet ${account.address} sin saldo suficiente: ${formatEther(balance)} ETH; ` +
      `mínimo operativo dinámico ${formatEther(requiredBalance)} ETH`,
    );
  }
  if (process.env.ALLOW_TESTNET_BROADCAST !== "1") {
    throw new Error("preflight correcto, pero falta ALLOW_TESTNET_BROADCAST=1 para autorizar el broadcast");
  }

  const guardian = optionalAddress("GUARDIAN_MULTISIG", account.address);
  const manager = optionalAddress("TESTNET_FUND_MANAGER", account.address);
  const keeper = optionalAddress("TESTNET_KEEPER_ADDRESS", account.address);
  const treasury = optionalAddress("TESTNET_PROTOCOL_TREASURY", account.address);

  console.log(JSON.stringify({
    phase: "preflight",
    chainId,
    startBlock: startBlock.toString(),
    deployer: account.address,
    balanceEth: formatEther(balance),
    gasPriceGwei: formatGwei(gasPrice),
    requiredBalanceEth: formatEther(requiredBalance),
  }));

  // Foundry resuelve el alias desde foundry.toml + RH_RPC_TESTNET. La URL privada no aparece
  // en los argumentos del proceso ni en los outputs del deployment.
  const forgeRpcTarget = "robinhood_testnet";

  await runForge("script/DeployTestnetAssets.s.sol", forgeRpcTarget, pk, {
    TESTNET_ASSET_ADMIN: optionalAddress("TESTNET_ASSET_ADMIN", account.address),
  });
  const assets = readAssetManifest(chainId);

  await runForge("script/DeployTestnetProtocol.s.sol", forgeRpcTarget, pk, {
    ...assetEnv(assets),
    GUARDIAN_MULTISIG: guardian,
  });
  const protocol = readProtocolManifest(chainId);

  await runForge("script/CreateFund.s.sol", forgeRpcTarget, pk, {
    ...protocolEnv(protocol),
    FUND_MANAGER: manager,
    KEEPER: keeper,
    PROTOCOL_TREASURY: treasury,
    FUND_NAME: process.env.TESTNET_FUND_NAME?.trim() || "NuvemFund Testnet Canary",
    FUND_SYMBOL: process.env.TESTNET_FUND_SYMBOL?.trim() || "NVT",
    PERIOD: String(7 * 24 * 60 * 60),
    COOLDOWN: String(60 * 60),
  });

  const registryAbi = parseAbi(["function funds(uint256) view returns (address)"]);
  const fundAbi = parseAbi(["function GATE() view returns (address)", "function MANAGER() view returns (address)"]);
  const fund = (await client.readContract({
    address: protocol.fundRegistry,
    abi: registryAbi,
    functionName: "funds",
    args: [0n],
  })) as Address;

  const addresses = [...Object.values(assets), ...Object.values(protocol), fund];
  const code = await Promise.all(addresses.map((address) => client.getBytecode({ address })));
  const missing = addresses.filter((_address, index) => !code[index] || code[index] === "0x");
  if (missing.length > 0) throw new Error(`sin bytecode tras deploy: ${missing.join(", ")}`);

  const [gate, managerOnchain, endBlock, balanceAfter] = await Promise.all([
    client.readContract({ address: fund, abi: fundAbi, functionName: "GATE" }) as Promise<Address>,
    client.readContract({ address: fund, abi: fundAbi, functionName: "MANAGER" }) as Promise<Address>,
    client.getBlockNumber(),
    client.getBalance({ address: account.address }),
  ]);
  if (gate.toLowerCase() !== protocol.eligibilityGate.toLowerCase()) throw new Error("Fund.GATE no coincide");
  if (managerOnchain.toLowerCase() !== manager.toLowerCase()) throw new Error("Fund.MANAGER no coincide");

  console.log(JSON.stringify({
    ok: true,
    environment: "robinhood-chain-testnet",
    chainId,
    startBlock: startBlock.toString(),
    endBlock: endBlock.toString(),
    deployer: account.address,
    balanceBeforeEth: formatEther(balance),
    balanceAfterEth: formatEther(balanceAfter),
    roles: { guardian, manager, keeper, treasury },
    assets,
    protocol,
    fund,
    checks: { allAddressesHaveCode: true, openGateWired: true, managerWired: true },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import { createPublicClient, formatEther, formatGwei, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadRootEnv, requiredTestnetBalanceWei, requirePrivateKey } from "./common.js";

async function main(): Promise<void> {
  loadRootEnv();
  const rpcUrl = process.env.RH_RPC_TESTNET;
  if (!rpcUrl) throw new Error("falta RH_RPC_TESTNET en el .env raíz");
  const pk = requirePrivateKey(process.env.TESTNET_DEPLOYER_PK ?? process.env.DEPLOYER_PK, "TESTNET_DEPLOYER_PK/DEPLOYER_PK");
  const account = privateKeyToAccount(pk);
  const client = createPublicClient({ transport: http(rpcUrl) });
  const [chainId, blockNumber, balance, gasPrice] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getBalance({ address: account.address }),
    client.getGasPrice(),
  ]);
  if (chainId !== 46_630) throw new Error(`RPC equivocado: chain ID ${chainId}, esperaba 46630`);
  const requiredBalance = requiredTestnetBalanceWei(gasPrice);

  console.log(JSON.stringify({
    ok: true,
    chainId,
    blockNumber: blockNumber.toString(),
    deployer: account.address,
    balanceWei: balance.toString(),
    balanceEth: formatEther(balance),
    gasPriceWei: gasPrice.toString(),
    gasPriceGwei: formatGwei(gasPrice),
    requiredBalanceWei: requiredBalance.toString(),
    requiredBalanceEth: formatEther(requiredBalance),
    fundedForDeploy: balance >= requiredBalance,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

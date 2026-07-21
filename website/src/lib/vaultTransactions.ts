import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import { robinhoodChain } from './chains'
import { loadProtocolRuntime } from './protocolRuntime'

const stakeAbi = parseAbi(['function addStake(uint256 amount)'])
const fundAbi = parseAbi(['function requestDeposit(uint256 amount6) returns (uint256)'])

export type BrowserWallet = {
  address: string
  switchChain: (chainId: number) => Promise<void>
  getEthereumProvider: () => Promise<EIP1193Provider>
}

export type VaultCreationInput = {
  manager: Address
  name: string
  symbol: string
  initialStake: string
  perfFeeBps: number
  feeMinBps: number
  feeMaxBps: number
  managerEntryShareBps: number
  kFactor: number
  periodDays: number
  cooldownHours: number
}

export type VaultDeployment = {
  fund: Address
  stakeEscrow: Address
  usdg: Address
  fundRegistry: Address
  chainId: number
  initialStake6: string
}

async function clients(wallet: BrowserWallet) {
  const runtime = await loadProtocolRuntime()
  await wallet.switchChain(runtime.chainId)
  const provider = await wallet.getEthereumProvider()
  const account = wallet.address as Address
  return {
    runtime,
    publicClient: createPublicClient({ chain: robinhoodChain, transport: http(runtime.rpcUrl) }),
    walletClient: createWalletClient({ account, chain: robinhoodChain, transport: custom(provider) }),
    account,
  }
}

async function wait(publicClient: ReturnType<typeof createPublicClient>, hash: Hash): Promise<Hash> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
  return hash
}

export async function deployVault(input: VaultCreationInput): Promise<VaultDeployment> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.creatorEnabled || !runtime.creatorUrl) {
    throw new Error('The vault operator is not running. Start the local devnet and try again.')
  }
  const response = await fetch(`${runtime.creatorUrl}/vaults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = (await response.json()) as VaultDeployment & { error?: string }
  if (!response.ok) throw new Error(payload.error || `Vault operator returned HTTP ${response.status}`)
  return payload
}

export async function addInitialProtection(
  wallet: BrowserWallet,
  deployment: VaultDeployment,
): Promise<{ approveHash: Hash; stakeHash: Hash }> {
  const { publicClient, walletClient, account } = await clients(wallet)
  const amount6 = BigInt(deployment.initialStake6)
  const approveHash = await walletClient.writeContract({
    address: deployment.usdg,
    abi: erc20Abi,
    functionName: 'approve',
    args: [deployment.stakeEscrow, amount6],
    account,
    chain: robinhoodChain,
  })
  await wait(publicClient, approveHash)
  const stakeHash = await walletClient.writeContract({
    address: deployment.stakeEscrow,
    abi: stakeAbi,
    functionName: 'addStake',
    args: [amount6],
    account,
    chain: robinhoodChain,
  })
  await wait(publicClient, stakeHash)
  return { approveHash, stakeHash }
}

export async function queueVaultDeposit(
  wallet: BrowserWallet,
  fund: Address,
  usdg: Address,
  amount: string,
): Promise<{ approveHash: Hash; requestHash: Hash }> {
  const { publicClient, walletClient, account } = await clients(wallet)
  const amount6 = parseUnits(amount, 6)
  const approveHash = await walletClient.writeContract({
    address: usdg,
    abi: erc20Abi,
    functionName: 'approve',
    args: [fund, amount6],
    account,
    chain: robinhoodChain,
  })
  await wait(publicClient, approveHash)
  const requestHash = await walletClient.writeContract({
    address: fund,
    abi: fundAbi,
    functionName: 'requestDeposit',
    args: [amount6],
    account,
    chain: robinhoodChain,
  })
  await wait(publicClient, requestHash)
  return { approveHash, requestHash }
}

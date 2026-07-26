import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem'
import { robinhoodChain } from './chains'
import { loadProtocolRuntime } from './protocolRuntime'

const stakeAbi = parseAbi(['function addStake(uint256 amount)', 'function stakeAvailable() view returns (uint256)'])
const fundAbi = parseAbi(['function requestDeposit(uint256 amount6) returns (uint256)'])
const testnetUsdgAbi = parseAbi([
  'function faucet() returns (uint256)',
  'function nextFaucetAt(address account) view returns (uint256)',
])
const ROBINHOOD_TESTNET_CHAIN_ID = 46_630
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hash

export type InitialProtectionFundingPlan = {
  needsFaucet: boolean
  needsApproval: boolean
  shortfall6: bigint
}

export function planInitialProtectionFunding(input: {
  chainId: number
  balance6: bigint
  allowance6: bigint
  amount6: bigint
  nextFaucetAt?: bigint
  blockTimestamp?: bigint
}): InitialProtectionFundingPlan {
  const shortfall6 = input.balance6 >= input.amount6 ? 0n : input.amount6 - input.balance6
  const faucetReady = (
    input.chainId === ROBINHOOD_TESTNET_CHAIN_ID
    && input.nextFaucetAt !== undefined
    && input.blockTimestamp !== undefined
    && input.nextFaucetAt <= input.blockTimestamp
  )
  return {
    needsFaucet: shortfall6 > 0n && faucetReady,
    needsApproval: input.allowance6 < input.amount6,
    shortfall6,
  }
}

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
  const { runtime, publicClient, walletClient, account } = await clients(wallet)
  const target6 = BigInt(deployment.initialStake6)
  const current6 = await publicClient.readContract({
    address: deployment.stakeEscrow,
    abi: stakeAbi,
    functionName: 'stakeAvailable',
  })
  if (current6 >= target6) {
    return { approveHash: ZERO_HASH, stakeHash: ZERO_HASH }
  }
  const amount6 = target6 - current6
  let [balance6, allowance6] = await Promise.all([
    publicClient.readContract({
      address: deployment.usdg,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
    publicClient.readContract({
      address: deployment.usdg,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account, deployment.stakeEscrow],
    }),
  ])

  let nextFaucetAt: bigint | undefined
  let blockTimestamp: bigint | undefined
  if (runtime.chainId === ROBINHOOD_TESTNET_CHAIN_ID && balance6 < amount6) {
    const [availableAt, block] = await Promise.all([
      publicClient.readContract({
        address: deployment.usdg,
        abi: testnetUsdgAbi,
        functionName: 'nextFaucetAt',
        args: [account],
      }),
      publicClient.getBlock({ blockTag: 'latest' }),
    ])
    nextFaucetAt = availableAt
    blockTimestamp = block.timestamp
  }

  let funding = planInitialProtectionFunding({
    chainId: runtime.chainId,
    balance6,
    allowance6,
    amount6,
    nextFaucetAt,
    blockTimestamp,
  })
  if (funding.needsFaucet) {
    const faucetHash = await walletClient.writeContract({
      address: deployment.usdg,
      abi: testnetUsdgAbi,
      functionName: 'faucet',
      account,
      chain: robinhoodChain,
    })
    await wait(publicClient, faucetHash)
    balance6 = await publicClient.readContract({
      address: deployment.usdg,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    })
    funding = planInitialProtectionFunding({
      chainId: runtime.chainId,
      balance6,
      allowance6,
      amount6,
      nextFaucetAt,
      blockTimestamp,
    })
  }
  if (funding.shortfall6 > 0n) {
    const cooldown = nextFaucetAt && blockTimestamp && nextFaucetAt > blockTimestamp
      ? ` The testnet faucet is available again at ${new Date(Number(nextFaucetAt) * 1_000).toISOString()}.`
      : ''
    throw new Error(
      `Sponsor wallet has ${formatUnits(balance6, 6)} tUSDG but ${formatUnits(amount6, 6)} tUSDG is required for initial protection.${cooldown}`,
    )
  }

  let approveHash = ZERO_HASH
  if (funding.needsApproval) {
    approveHash = await walletClient.writeContract({
      address: deployment.usdg,
      abi: erc20Abi,
      functionName: 'approve',
      args: [deployment.stakeEscrow, amount6],
      account,
      chain: robinhoodChain,
    })
    await wait(publicClient, approveHash)
    allowance6 = amount6
  }
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

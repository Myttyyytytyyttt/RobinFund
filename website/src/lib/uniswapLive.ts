import { createPublicClient, http, type Address, type Hex } from 'viem'
import { loadProtocolRuntime } from './protocolRuntime'
import { getSupabaseClient } from './supabase'

export type UniswapLiveExecution = {
  transactionHash: Hex
  blockNumber: number | null
  tokenIn: Address
  tokenOut: Address
  amountIn: string
  quotedAmountOut: string
  minAmountOut: string
  occurredAt: string
}

export type UniswapLiveSnapshot = {
  checkedAt: string
  chainId: number
  network: string
  latestBlock: bigint | null
  integrationReady: boolean
  verifiedContracts: number
  expectedContracts: number
  executedSwaps: number
  lastExecution: UniswapLiveExecution | null
}

function addressOrNull(value: string | undefined): Address | null {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? value as Address : null
}

async function readExecutionData(chainId: number): Promise<{
  executedSwaps: number
  lastExecution: UniswapLiveExecution | null
}> {
  const supabase = getSupabaseClient()
  if (!supabase) return { executedSwaps: 0, lastExecution: null }
  const { data, count, error } = await supabase
    .from('agent_decisions')
    .select(
      'transaction_hash,block_number,token_in,token_out,amount_in,quoted_amount_out,min_amount_out,occurred_at',
      { count: 'exact' },
    )
    .eq('chain_id', chainId)
    .eq('decision', 'executed')
    .not('transaction_hash', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(1)
  if (error) throw error
  const latest = data?.[0]
  const transactionHash = latest?.transaction_hash
  const tokenIn = addressOrNull(latest?.token_in ?? undefined)
  const tokenOut = addressOrNull(latest?.token_out ?? undefined)
  return {
    executedSwaps: count ?? 0,
    lastExecution: latest && transactionHash && tokenIn && tokenOut
      ? {
          transactionHash: transactionHash as Hex,
          blockNumber: latest.block_number,
          tokenIn,
          tokenOut,
          amountIn: latest.amount_in ?? '0',
          quotedAmountOut: latest.quoted_amount_out ?? '0',
          minAmountOut: latest.min_amount_out ?? '0',
          occurredAt: latest.occurred_at,
        }
      : null,
  }
}

export async function loadUniswapLiveSnapshot(): Promise<UniswapLiveSnapshot> {
  const runtime = await loadProtocolRuntime()
  const client = createPublicClient({ transport: http(runtime.rpcUrl, { timeout: 4_000 }) })
  const contracts = runtime.chainId === 4663
    ? [
        runtime.uniswapApiAdapter,
        runtime.uniswapApprovalProxy,
        runtime.uniswapUniversalRouter,
      ].filter((value): value is Address => Boolean(value))
    : []

  const [blockResult, codeResults, executionResult] = await Promise.all([
    client.getBlockNumber().catch(() => null),
    Promise.all(contracts.map((address) => client.getCode({ address }).catch(() => undefined))),
    runtime.chainId === 4663
      ? readExecutionData(runtime.chainId).catch(() => ({ executedSwaps: 0, lastExecution: null }))
      : Promise.resolve({ executedSwaps: 0, lastExecution: null }),
  ])
  const verifiedContracts = codeResults.filter((code) => code != null && code !== '0x').length

  return {
    checkedAt: new Date().toISOString(),
    chainId: runtime.chainId,
    network: runtime.chainId === 4663
      ? 'Robinhood Chain'
      : runtime.chainId === 46630
        ? 'Robinhood Testnet'
        : runtime.mode === 'devnet'
          ? 'Local devnet'
          : `Chain ${runtime.chainId}`,
    latestBlock: blockResult,
    integrationReady: contracts.length === 3 && verifiedContracts === 3,
    verifiedContracts,
    expectedContracts: 3,
    executedSwaps: executionResult.executedSwaps,
    lastExecution: executionResult.lastExecution,
  }
}

export function uniswapExplorerUrl(snapshot: UniswapLiveSnapshot): string | null {
  if (!snapshot.lastExecution) return null
  if (snapshot.chainId === 4663) {
    return `https://robinhoodchain.blockscout.com/tx/${snapshot.lastExecution.transactionHash}`
  }
  if (snapshot.chainId === 46630) {
    return `https://explorer.testnet.chain.robinhood.com/tx/${snapshot.lastExecution.transactionHash}`
  }
  return null
}

import type { Address } from 'viem'
import { getAddress, isAddress } from 'viem'

export type ProtocolRuntime = {
  rpcUrl: string
  chainId: number
  indexerUrl?: string
  creatorUrl?: string
  fundRegistry?: Address
  usdg?: Address
  agentRegistry?: Address
  uniswapApiAdapter?: Address
  uniswapApiAdapterId?: string
  uniswapApprovalProxy?: Address
  uniswapUniversalRouter?: Address
  agentAssets: Address[]
  agentGatewayUrl?: string
  creatorEnabled: boolean
  mode: 'devnet' | 'network'
}

const creatorDisabled = import.meta.env.VITE_DISABLE_LOCAL_CREATOR === '1'
const localCreatorUrl = creatorDisabled
  ? ''
  : import.meta.env.VITE_VAULT_CREATOR_URL?.trim() ||
    (import.meta.env.DEV ? 'http://127.0.0.1:8788' : '')

let cached: Promise<ProtocolRuntime> | null = null

function configuredAgentAssets(): Address[] {
  const raw = import.meta.env.VITE_AGENT_ASSETS?.trim()
  if (!raw) return []
  const assets = raw.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (assets.some((asset) => !isAddress(asset))) return []
  const normalized = assets.map((asset) => getAddress(asset))
  return new Set(normalized.map((asset) => asset.toLowerCase())).size === normalized.length ? normalized : []
}

async function creatorConfig(url: string): Promise<Partial<ProtocolRuntime> | null> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 1_200)
  try {
    const response = await fetch(`${url}/config`, { signal: controller.signal })
    if (!response.ok) return null
    const data = (await response.json()) as {
      mode?: string
      rpcUrl?: string
      chainId?: number
      fundRegistry?: Address
      usdg?: Address
      agentRegistry?: Address
      uniswapApiAdapter?: Address
      uniswapApiAdapterId?: string
      uniswapApprovalProxy?: Address
      uniswapUniversalRouter?: Address
      defaultAgentAssets?: Address[]
      creatorEnabled?: boolean
    }
    return {
      rpcUrl: data.rpcUrl,
      chainId: data.chainId,
      fundRegistry: data.fundRegistry,
      usdg: data.usdg,
      agentRegistry: data.agentRegistry,
      uniswapApiAdapter: data.uniswapApiAdapter,
      uniswapApiAdapterId: data.uniswapApiAdapterId,
      uniswapApprovalProxy: data.uniswapApprovalProxy,
      uniswapUniversalRouter: data.uniswapUniversalRouter,
      agentAssets: data.defaultAgentAssets,
      creatorEnabled: data.creatorEnabled,
      mode: data.mode === 'devnet' ? 'devnet' : 'network',
    }
  } catch {
    return null
  } finally {
    window.clearTimeout(timeout)
  }
}

export function loadProtocolRuntime(force = false): Promise<ProtocolRuntime> {
  if (force) cached = null
  if (cached) return cached

  cached = (async () => {
    const remote = localCreatorUrl ? await creatorConfig(localCreatorUrl) : null
    const envRegistry = import.meta.env.VITE_FUND_REGISTRY_ADDRESS?.trim() as Address | undefined
    const envUsdg = import.meta.env.VITE_USDG_ADDRESS?.trim() as Address | undefined
    return {
      rpcUrl: remote?.rpcUrl || import.meta.env.VITE_RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: remote?.chainId || Number(import.meta.env.VITE_RH_CHAIN_ID || 4663),
      indexerUrl:
        import.meta.env.VITE_INDEXER_GRAPHQL_URL?.trim() ||
        (import.meta.env.DEV ? 'http://127.0.0.1:42069/graphql' : undefined),
      creatorUrl: localCreatorUrl || undefined,
      fundRegistry: remote?.fundRegistry || envRegistry,
      usdg: remote?.usdg || envUsdg,
      agentRegistry: remote?.agentRegistry || (import.meta.env.VITE_AGENT_REGISTRY_ADDRESS?.trim() as Address | undefined),
      uniswapApiAdapter: remote?.uniswapApiAdapter || (import.meta.env.VITE_UNISWAP_API_ADAPTER_ADDRESS?.trim() as Address | undefined),
      uniswapApiAdapterId: remote?.uniswapApiAdapterId || import.meta.env.VITE_UNISWAP_API_ADAPTER_ID?.trim(),
      uniswapApprovalProxy: remote?.uniswapApprovalProxy || (import.meta.env.VITE_UNISWAP_APPROVAL_PROXY?.trim() as Address | undefined),
      uniswapUniversalRouter: remote?.uniswapUniversalRouter || (import.meta.env.VITE_UNISWAP_UNIVERSAL_ROUTER?.trim() as Address | undefined),
      agentAssets: remote?.agentAssets?.length ? remote.agentAssets : configuredAgentAssets(),
      agentGatewayUrl: import.meta.env.VITE_AGENT_GATEWAY_URL?.trim() || undefined,
      creatorEnabled: Boolean(remote?.creatorEnabled && localCreatorUrl),
      mode: remote?.mode === 'devnet' ? 'devnet' : 'network',
    }
  })()

  return cached
}

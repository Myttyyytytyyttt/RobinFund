import type { Address } from 'viem'

export type ProtocolRuntime = {
  rpcUrl: string
  chainId: number
  indexerUrl?: string
  creatorUrl?: string
  fundRegistry?: Address
  usdg?: Address
  creatorEnabled: boolean
  mode: 'devnet' | 'network'
}

const localCreatorUrl = import.meta.env.VITE_VAULT_CREATOR_URL?.trim() ||
  (import.meta.env.DEV ? 'http://127.0.0.1:8788' : '')

let cached: Promise<ProtocolRuntime> | null = null

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
      creatorEnabled?: boolean
    }
    return {
      rpcUrl: data.rpcUrl,
      chainId: data.chainId,
      fundRegistry: data.fundRegistry,
      usdg: data.usdg,
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
    return {
      rpcUrl: remote?.rpcUrl || import.meta.env.VITE_RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: remote?.chainId || Number(import.meta.env.VITE_RH_CHAIN_ID || 4663),
      indexerUrl:
        import.meta.env.VITE_INDEXER_GRAPHQL_URL?.trim() ||
        (import.meta.env.DEV ? 'http://127.0.0.1:42069/graphql' : undefined),
      creatorUrl: localCreatorUrl || undefined,
      fundRegistry: remote?.fundRegistry || envRegistry,
      usdg: remote?.usdg,
      creatorEnabled: Boolean(remote?.creatorEnabled && localCreatorUrl),
      mode: remote?.mode === 'devnet' ? 'devnet' : 'network',
    }
  })()

  return cached
}

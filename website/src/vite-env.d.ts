/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRIVY_APP_ID: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_INDEXER_GRAPHQL_URL?: string
  readonly VITE_RH_RPC_URL?: string
  readonly VITE_RH_CHAIN_ID?: string
  readonly VITE_FUND_REGISTRY_ADDRESS?: string
  readonly VITE_USDG_ADDRESS?: string
  readonly VITE_VAULT_CREATOR_URL?: string
  readonly VITE_AGENT_GATEWAY_URL?: string
  readonly VITE_AGENT_REGISTRY_ADDRESS?: string
  readonly VITE_AGENT_ASSETS?: string
  readonly VITE_UNISWAP_API_ADAPTER_ADDRESS?: string
  readonly VITE_UNISWAP_API_ADAPTER_ID?: string
  readonly VITE_UNISWAP_APPROVAL_PROXY?: string
  readonly VITE_UNISWAP_UNIVERSAL_ROUTER?: string
  readonly VITE_DISABLE_LOCAL_CREATOR?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

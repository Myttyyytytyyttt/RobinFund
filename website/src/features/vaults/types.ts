export type TradeSide = 'B' | 'S'

export type VaultTrade = {
  side: TradeSide
  ticker: string
  size: string
  ago: string
  note: string
}

export type VaultManager = {
  name: string
  handle: string
  avatar: string
  bio: string
  socials: {
    x?: string
    telegram?: string
    website?: string
  }
}

export type VaultAccess = {
  hasAccess: boolean
  status: 'open' | 'paused' | 'closed'
  minDeposit: number
  maxDeposit: number
  availableCapacity: number
  entryFeeBps: number
  entryFeeMode: 'fixed' | 'dynamic'
  depositWindow: string
  nextBatch: string
  withdrawalCooldown: string
  accessPolicy: string
}

export type VaultThesis = {
  id: string
  title: string
  body: string
  tags: string[]
  updatedAt: string
  pinned?: boolean
}

export type VaultChatMessage = {
  id: string
  user: string
  avatar: string
  time: string
  body: string
  role?: 'manager' | 'member'
}

export type VaultActivity = {
  id: string
  type: 'trade' | 'thesis' | 'settlement' | 'member'
  title: string
  detail: string
  time: string
  tone: 'green' | 'red' | 'blue' | 'neutral'
}

export type PortfolioPoint = {
  label: string
  value: number
}

export type PortfolioEvent = {
  pointIndex: number
  ticker: string
  side: TradeSide
  label: string
}

export type VaultPosition = {
  value: number
  netInvested: number
  pnl: number
  pnlPercent: number
  shares: number
  allocationPercent: number
  history: PortfolioPoint[]
  events: PortfolioEvent[]
}

export type Vault = {
  id: string
  address: `0x${string}`
  name: string
  symbol: string
  description: string
  manager: VaultManager
  perfTotal: string
  perf7d: string
  nav: string
  sharePriceUsd: number
  members: number
  coverK: number
  access: VaultAccess
  trades: VaultTrade[]
  theses: VaultThesis[]
  chat: VaultChatMessage[]
  activity: VaultActivity[]
  position: VaultPosition
  nextSettlement: string
  mandate: string
}

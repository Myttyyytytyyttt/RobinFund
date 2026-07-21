export type TradeSide = 'B' | 'S'

export type VaultTrade = {
  id: string
  side: TradeSide
  ticker: string
  size: string
  ago: string
  note: string
  txHash: `0x${string}`
}

export type VaultManager = {
  address: `0x${string}`
  name: string
  handle?: string
  avatar?: string
  socials: {
    x?: string
  }
}

export type VaultConfig = {
  perfFeeBps: number
  feeMinBps: number
  feeMaxBps: number
  managerEntryShareBps: number
  kFactor: number
  periodSeconds: number
  withdrawCooldownSeconds: number
}

export type VaultAccess = {
  hasAccess: boolean
  status: 'open' | 'paused' | 'closed' | 'setup'
  minDeposit: number
  availableCapacity: number
  currentEntryFeeBps: number
  depositWindow: string
  nextBatch: string
  withdrawalCooldown: string
  accessPolicy: string
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
  history: PortfolioPoint[]
  events: PortfolioEvent[]
  hasHistory: boolean
}

export type VaultActivity = {
  id: string
  type: 'trade' | 'settlement'
  title: string
  detail: string
  time: string
  tone: 'green' | 'red' | 'blue' | 'neutral'
}

export type Vault = {
  id: string
  address: `0x${string}`
  shareAddress: `0x${string}`
  stakeEscrow: `0x${string}`
  name: string
  symbol: string
  manager: VaultManager
  perfTotal: string
  perf7d: string
  nav: string
  navValid: boolean
  navValueUsd: number
  sharePriceUsd: number
  members: number
  coverK: number
  aumCapUsd: number
  access: VaultAccess
  config: VaultConfig
  trades: VaultTrade[]
  activity: VaultActivity[]
  position: VaultPosition
  nextSettlement: string
  createdAt: number
}

export type VaultManagerSummary = {
  address: `0x${string}`
  name: string
  handle?: string
  avatar?: string
  xUrl?: string
  funds: Vault[]
  protectionUsd: number
  performance: string
}

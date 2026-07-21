import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
} from 'viem'
import type {
  PortfolioPoint,
  Vault,
  VaultActivity,
  VaultManagerSummary,
  VaultTrade,
} from '@/features/vaults/types'
import { profileStore } from './profileStore'
import { robinhoodChain } from './chains'
import { loadProtocolRuntime } from './protocolRuntime'

const WAD = 10n ** 18n
const USD6 = 10n ** 6n
const MIN_DEPOSIT_USD = 50

const registryAbi = parseAbi([
  'function fundCount() view returns (uint256)',
  'function funds(uint256) view returns (address)',
])
const fundAbi = parseAbi([
  'function MANAGER() view returns (address)',
  'function share() view returns (address)',
  'function stakeEscrow() view returns (address)',
  'function config() view returns (uint16 perfFeeBps, uint16 feeMinBps, uint16 feeMaxBps, uint16 managerEntryShareBps, uint16 kFactor, uint32 period, uint32 withdrawCooldown)',
  'function nav() view returns (uint256 navWad, bool valid)',
  'function aumCapWad() view returns (uint256)',
  'function settlementDue() view returns (uint48)',
  'function state() view returns (uint8)',
  'function frozen() view returns (bool)',
  'function guardianPaused() view returns (bool)',
])
const shareAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
])
const stakeAbi = parseAbi(['function stakeAvailable() view returns (uint256)'])

type FundRow = {
  address: Address
  manager: Address
  name: string
  symbol: string
  share: Address
  stakeEscrow: Address
  createdAt: string
  state: number
  frozen: boolean
  guardianPaused: boolean
  lastPePostFeeWad: string | null
  totalShares: string
  lpCount: number
}
type TradeRow = {
  id: string
  fund: Address
  tokenIn: Address
  tokenOut: Address
  spent: string
  received: string
  timestamp: string
  txHash: Address
}
type SettlementRow = {
  id: string
  fund: Address
  period: string
  peWad: string
  pePostFeeWad: string | null
  fundingWad: string
  timestamp: string
  txHash: Address
}
type PositionRow = {
  fund: Address
  lp: Address
  shares: string
  deposited6: string
  withdrawn6: string
  claimed6: string
}

type FundListResponse = { funds: { items: FundRow[] } }
type FundDetailResponse = {
  trades: { items: TradeRow[] }
  settlements: { items: SettlementRow[] }
  lpPositions: { items: PositionRow[] }
}

const FUND_LIST_QUERY = `
  query RealVaults {
    funds(limit: 250, orderBy: "createdAt", orderDirection: "desc") {
      items {
        address manager name symbol share stakeEscrow createdAt state frozen guardianPaused
        lastPePostFeeWad totalShares lpCount
      }
    }
  }
`

const FUND_DETAILS_QUERY = `
  query RealVaultDetails($funds: [String!]!, $lp: String!) {
    trades(where: { fund_in: $funds }, orderBy: "timestamp", orderDirection: "desc", limit: 1000) {
      items { id fund tokenIn tokenOut spent received timestamp txHash }
    }
    settlements(where: { fund_in: $funds }, orderBy: "timestamp", orderDirection: "asc", limit: 1000) {
      items { id fund period peWad pePostFeeWad fundingWad timestamp txHash }
    }
    lpPositions(where: { fund_in: $funds, lp: $lp }, limit: 250) {
      items { fund lp shares deposited6 withdrawn6 claimed6 }
    }
  }
`

const TOKEN_SYMBOLS: Record<string, string> = {
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d': 'TSLA',
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': 'NVDA',
  '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9': 'AAPL',
  '0xe93237c50d904957cf27e7b1133b510c669c2e74': 'MSFT',
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': 'SPY',
  // Robinhood Chain testnet asset pack.
  '0x336c508083e2afe17c594a8ef5b8542efcf672d5': 'USDG',
  '0x3f1a8f0a7d944875e3350b0c78d56d22990a6e2f': 'TSLA',
  '0x3b334d58c329f7a98ca3c11a09e45ae3352263ae': 'NVDA',
  '0x6fd0d905af9841a2a268ab4784efe24575a48d1c': 'AAPL',
  '0x5cc41b676e626c29fa685c1e9057d0264d3c6f05': 'MSFT',
  '0x2b41f3c8b61e7188a2c7dbf494ebf6d0beaced22': 'SPY',
}

const normalize = (value: string) => value.toLowerCase()
const decimal = (value: bigint, scale: bigint) => Number(value) / Number(scale)
const shortAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`
const usd = (value: number, digits = value < 10 ? 3 : 0) =>
  `$${value.toLocaleString('en-US', { maximumFractionDigits: digits })}`

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return '—'
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

function until(timestamp: number): string {
  const seconds = timestamp - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'Due now'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`
}

async function gql<T>(endpoint: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) throw new Error(`Indexer returned HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> }
  if (payload.errors?.length) throw new Error(payload.errors.map((item) => item.message || 'GraphQL error').join('; '))
  if (!payload.data) throw new Error('Indexer returned no data')
  return payload.data
}

async function indexedFunds(endpoint?: string): Promise<FundRow[]> {
  if (!endpoint) return []
  return (await gql<FundListResponse>(endpoint, FUND_LIST_QUERY)).funds.items
}

async function registryFunds(client: ReturnType<typeof createPublicClient>, registry?: Address): Promise<Address[]> {
  if (!registry) return []
  const count = (await client.readContract({ address: registry, abi: registryAbi, functionName: 'fundCount' })) as bigint
  return Promise.all(
    Array.from({ length: Number(count) }, (_, index) =>
      client.readContract({ address: registry, abi: registryAbi, functionName: 'funds', args: [BigInt(index)] }) as Promise<Address>,
    ),
  )
}

async function details(endpoint: string | undefined, funds: Address[], lp?: string): Promise<FundDetailResponse> {
  if (!endpoint || funds.length === 0) return { trades: { items: [] }, settlements: { items: [] }, lpPositions: { items: [] } }
  return gql<FundDetailResponse>(endpoint, FUND_DETAILS_QUERY, {
    funds: funds.map(normalize),
    lp: normalize(lp || '0x0000000000000000000000000000000000000000'),
  })
}

function tokenSymbol(address: Address): string {
  return TOKEN_SYMBOLS[normalize(address)] || shortAddress(address)
}

function realTrade(row: TradeRow): VaultTrade {
  const inSymbol = tokenSymbol(row.tokenIn)
  const outSymbol = tokenSymbol(row.tokenOut)
  const buysStock = inSymbol === 'USDG'
  const ticker = buysStock ? outSymbol : inSymbol
  const usdAmount = buysStock ? decimal(BigInt(row.spent), USD6) : decimal(BigInt(row.received), USD6)
  return {
    id: row.id,
    side: buysStock ? 'B' : 'S',
    ticker,
    size: usd(usdAmount),
    ago: relativeTime(Number(row.timestamp)),
    note: `${inSymbol} → ${outSymbol}`,
    txHash: row.txHash,
  }
}

export async function loadVaults(walletAddress?: string): Promise<Vault[]> {
  const runtime = await loadProtocolRuntime()
  const client = createPublicClient({ chain: robinhoodChain, transport: http(runtime.rpcUrl) })

  let rows: FundRow[] = []
  let indexerError: unknown
  try {
    rows = await indexedFunds(runtime.indexerUrl)
  } catch (error) {
    indexerError = error
  }

  const registryAddresses = await registryFunds(client, runtime.fundRegistry).catch(() => [] as Address[])
  const addressSet = new Set([...rows.map((row) => normalize(row.address)), ...registryAddresses.map(normalize)])
  if (addressSet.size === 0 && indexerError) throw indexerError
  const addresses = [...addressSet] as Address[]
  const rowMap = new Map(rows.map((row) => [normalize(row.address), row]))
  const indexed = await details(runtime.indexerUrl, addresses, walletAddress).catch(() => ({
    trades: { items: [] }, settlements: { items: [] }, lpPositions: { items: [] },
  }))
  const tradeMap = new Map<string, TradeRow[]>()
  const settlementMap = new Map<string, SettlementRow[]>()
  for (const trade of indexed.trades.items) {
    const key = normalize(trade.fund)
    tradeMap.set(key, [...(tradeMap.get(key) || []), trade])
  }
  for (const settlement of indexed.settlements.items) {
    const key = normalize(settlement.fund)
    settlementMap.set(key, [...(settlementMap.get(key) || []), settlement])
  }
  const positionMap = new Map(indexed.lpPositions.items.map((row) => [normalize(row.fund), row]))

  return Promise.all(addresses.map(async (address): Promise<Vault> => {
    const key = normalize(address)
    const row = rowMap.get(key)
    const manager = (await client.readContract({ address, abi: fundAbi, functionName: 'MANAGER' })) as Address
    const shareAddress = (await client.readContract({ address, abi: fundAbi, functionName: 'share' })) as Address
    const stakeEscrow = (await client.readContract({ address, abi: fundAbi, functionName: 'stakeEscrow' })) as Address
    const [name, symbol, totalSupply, config, nav, aumCapWad, settlementDue, state, frozen, guardianPaused, stake6] = await Promise.all([
      client.readContract({ address: shareAddress, abi: shareAbi, functionName: 'name' }) as Promise<string>,
      client.readContract({ address: shareAddress, abi: shareAbi, functionName: 'symbol' }) as Promise<string>,
      client.readContract({ address: shareAddress, abi: shareAbi, functionName: 'totalSupply' }) as Promise<bigint>,
      client.readContract({ address, abi: fundAbi, functionName: 'config' }) as Promise<readonly [number, number, number, number, number, number, number]>,
      client.readContract({ address, abi: fundAbi, functionName: 'nav' }) as Promise<readonly [bigint, boolean]>,
      client.readContract({ address, abi: fundAbi, functionName: 'aumCapWad' }) as Promise<bigint>,
      client.readContract({ address, abi: fundAbi, functionName: 'settlementDue' }) as Promise<number>,
      client.readContract({ address, abi: fundAbi, functionName: 'state' }) as Promise<number>,
      client.readContract({ address, abi: fundAbi, functionName: 'frozen' }) as Promise<boolean>,
      client.readContract({ address, abi: fundAbi, functionName: 'guardianPaused' }) as Promise<boolean>,
      client.readContract({ address: stakeEscrow, abi: stakeAbi, functionName: 'stakeAvailable' }) as Promise<bigint>,
    ])

    const [perfFeeBps, feeMinBps, feeMaxBps, managerEntryShareBps, kFactor, periodSeconds, withdrawCooldownSeconds] = config
    const [navWad, navValid] = nav
    const sharePriceWad = ((navWad + 1_000_000n) * WAD) / (totalSupply + 1_000_000n)
    const sharePriceUsd = decimal(sharePriceWad, WAD)
    const navValueUsd = decimal(navWad, WAD)
    const aumCapUsd = decimal(aumCapWad, WAD)
    const availableCapacity = Math.max(0, aumCapUsd - navValueUsd)
    const history = settlementMap.get(key) || []
    const latest = history[history.length - 1]
    const latestPrice = latest ? decimal(BigInt(latest.pePostFeeWad || latest.peWad), WAD) : null
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400
    const baselineCandidates = history.filter((item) => Number(item.timestamp) <= cutoff)
    const baseline7d = baselineCandidates[baselineCandidates.length - 1]
    const baselinePrice = baseline7d ? decimal(BigInt(baseline7d.pePostFeeWad || baseline7d.peWad), WAD) : null
    const performanceTotal = latestPrice === null ? null : (latestPrice - 1) * 100
    const performance7d = latestPrice !== null && baselinePrice ? ((latestPrice / baselinePrice) - 1) * 100 : null
    const profile = await profileStore.load(manager)
    const twitter = profile?.twitter?.replace(/^@/, '')
    const managerName = profile ? `@${profile.username}` : shortAddress(manager)
    const realTrades = (tradeMap.get(key) || []).slice(0, 3).map(realTrade)
    const position = positionMap.get(key)
    const shares = position ? BigInt(position.shares) : 0n
    const positionValue = decimal((shares * sharePriceWad) / WAD, WAD)
    const deposited = position ? decimal(BigInt(position.deposited6), USD6) : 0
    const withdrawn = position ? decimal(BigInt(position.withdrawn6), USD6) : 0
    const claimed = position ? decimal(BigInt(position.claimed6), USD6) : 0
    const pnl = positionValue + withdrawn + claimed - deposited
    const points: PortfolioPoint[] = history.map((item) => ({
      label: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(Number(item.timestamp) * 1000)),
      value: decimal((shares * BigInt(item.pePostFeeWad || item.peWad)) / WAD, WAD),
    }))
    const activity: VaultActivity[] = [
      ...(tradeMap.get(key) || []).map((item) => {
        const trade = realTrade(item)
        return {
          id: trade.id,
          type: 'trade' as const,
          title: `${trade.side === 'B' ? 'Bought' : 'Sold'} ${trade.ticker}`,
          detail: `${trade.size} · ${trade.note}`,
          time: trade.ago,
          tone: trade.side === 'B' ? 'green' as const : 'red' as const,
        }
      }),
      ...history.map((item) => ({
        id: item.id,
        type: 'settlement' as const,
        title: `Period ${item.period} settled`,
        detail: `Share NAV ${usd(decimal(BigInt(item.pePostFeeWad || item.peWad), WAD))}`,
        time: relativeTime(Number(item.timestamp)),
        tone: 'blue' as const,
      })),
    ].slice(0, 12)

    const isManager = Boolean(walletAddress && normalize(walletAddress) === normalize(manager))
    const hasAccess = shares > 0n || isManager
    const currentUtilization = aumCapUsd > 0 ? Math.min(1, (navValueUsd + MIN_DEPOSIT_USD / 2) / aumCapUsd) : 1
    const currentEntryFeeBps = Math.round(feeMinBps + (feeMaxBps - feeMinBps) * currentUtilization)
    const setupIncomplete = stake6 === 0n
    const closed = state === 3
    const paused = frozen || guardianPaused || state !== 0 || !navValid || Date.now() / 1000 + 86400 >= settlementDue
    const status = closed ? 'closed' as const : setupIncomplete ? 'setup' as const : paused ? 'paused' as const : 'open' as const

    return {
      id: key,
      address,
      shareAddress,
      stakeEscrow,
      name: row?.name || name,
      symbol: row?.symbol || symbol,
      manager: {
        address: manager,
        name: managerName,
        handle: twitter ? `@${twitter}` : undefined,
        socials: { x: twitter ? `https://x.com/${twitter}` : undefined },
      },
      perfTotal: pct(performanceTotal),
      perf7d: pct(performance7d),
      nav: usd(sharePriceUsd),
      navValid,
      navValueUsd,
      sharePriceUsd,
      members: row?.lpCount || 0,
      coverK: decimal(stake6, USD6) / 1000,
      aumCapUsd,
      access: {
        hasAccess,
        status,
        minDeposit: MIN_DEPOSIT_USD,
        availableCapacity,
        currentEntryFeeBps,
        depositWindow: status === 'open' ? 'Open · forward-priced queue' : status === 'setup' ? 'Waiting for manager protection' : 'Not accepting deposits',
        nextBatch: status === 'open' ? 'Keeper · after 10 min minimum latency' : '—',
        withdrawalCooldown: `${Math.round(withdrawCooldownSeconds / 3600)} hours`,
        accessPolicy: 'Open to any wallet · no KYC',
      },
      config: { perfFeeBps, feeMinBps, feeMaxBps, managerEntryShareBps, kFactor, periodSeconds, withdrawCooldownSeconds },
      trades: realTrades,
      activity,
      position: {
        value: positionValue,
        netInvested: Math.max(0, deposited - withdrawn),
        pnl,
        pnlPercent: deposited > 0 ? (pnl / deposited) * 100 : 0,
        shares: decimal(shares, WAD),
        history: points,
        events: [],
        hasHistory: points.length > 1,
      },
      nextSettlement: until(settlementDue),
      createdAt: Number(row?.createdAt || 0),
    }
  }))
}

export function groupVaultManagers(vaults: Vault[]): VaultManagerSummary[] {
  const grouped = new Map<string, Vault[]>()
  for (const vault of vaults) {
    const key = normalize(vault.manager.address)
    grouped.set(key, [...(grouped.get(key) || []), vault])
  }
  return [...grouped.entries()].map(([address, funds]) => {
    const manager = funds[0].manager
    const settled = funds.map((fund) => fund.perfTotal).filter((value) => value !== '—')
    return {
      address: address as Address,
      name: manager.name,
      handle: manager.handle,
      avatar: manager.avatar,
      xUrl: manager.socials.x,
      funds,
      protectionUsd: funds.reduce((sum, fund) => sum + fund.coverK * 1000, 0),
      performance: settled.length === 1 ? settled[0] : settled.length > 1 ? `${settled.length} settled funds` : 'No settled history',
    }
  })
}

export function currentEntryFeeBps(vault: Vault, depositUsd: number): number {
  const { feeMinBps, feeMaxBps } = vault.config
  if (feeMaxBps === 0) return 0
  const utilization = vault.aumCapUsd === 0
    ? 1
    : Math.min(1, (vault.navValueUsd + depositUsd / 2) / vault.aumCapUsd)
  return feeMinBps + Math.floor((feeMaxBps - feeMinBps) * utilization)
}

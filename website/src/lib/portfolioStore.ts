import { profileStore } from './profileStore'

const WAD = 10n ** 18n
const USD6 = 10n ** 6n
const DEFAULT_INDEXER_URL = import.meta.env.DEV ? 'http://127.0.0.1:42069/graphql' : ''

export type PortfolioPosition = {
  fundAddress: string
  fund: string
  symbol: string
  manager: string
  managerLabel: string
  shares: bigint
  invested: number
  value: number
  pnl: number
  pnlPct: number
  accent: string
}

export type PortfolioData = {
  positions: PortfolioPosition[]
  invested: number
  value: number
  pnl: number
  pnlPct: number
  series: number[]
  seriesLabels: string[]
  hasIndexedHistory: boolean
}

type PositionRow = {
  fund: string
  lp: string
  shares: string
  deposited6: string
  withdrawn6: string
  claimed6: string
}

type FundRow = {
  address: string
  name: string
  symbol: string
  manager: string
  lastPePostFeeWad: string | null
}

type SettlementRow = {
  fund: string
  peWad: string
  pePostFeeWad: string | null
  timestamp: string
}

type PositionsResponse = {
  lpPositions: { items: PositionRow[] }
}

type DetailsResponse = {
  funds: { items: FundRow[] }
  settlements: { items: SettlementRow[] }
}

const POSITIONS_QUERY = `
  query PortfolioPositions($lp: String!) {
    lpPositions(where: { lp: $lp }, limit: 1000) {
      items { fund lp shares deposited6 withdrawn6 claimed6 }
    }
  }
`

const DETAILS_QUERY = `
  query PortfolioDetails($funds: [String!]!) {
    funds(where: { address_in: $funds }, limit: 1000) {
      items { address name symbol manager lastPePostFeeWad }
    }
    settlements(
      where: { fund_in: $funds }
      orderBy: "timestamp"
      orderDirection: "desc"
      limit: 1000
    ) {
      items { fund peWad pePostFeeWad timestamp }
    }
  }
`

const normalize = (value: string) => value.toLowerCase()

function decimal(value: bigint, scale: bigint): number {
  return Number(value) / Number(scale)
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function accentFor(address: string): string {
  const palette = ['#6ee7b7', '#bfdbfe', '#fde68a', '#c4b5fd', '#f9a8d4', '#67e8f9']
  let hash = 0
  for (let index = 0; index < address.length; index += 1) {
    hash = (hash * 31 + address.charCodeAt(index)) >>> 0
  }
  return palette[hash % palette.length]
}

function dateLabel(timestamp: bigint): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(Number(timestamp) * 1000),
  )
}

async function fetchGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const endpoint = import.meta.env.VITE_INDEXER_GRAPHQL_URL || DEFAULT_INDEXER_URL
  if (!endpoint) throw new Error('The NuvemFund indexer URL is not configured.')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) throw new Error(`Indexer returned HTTP ${response.status}.`)

  const payload = (await response.json()) as {
    data?: T
    errors?: Array<{ message?: string }>
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message || 'GraphQL error').join('; '))
  }
  if (!payload.data) throw new Error('Indexer returned no portfolio data.')
  return payload.data
}

function buildSeries(
  positions: Array<{ fundAddress: string; shares: bigint }>,
  settlements: SettlementRow[],
): { values: number[]; labels: string[]; hasHistory: boolean } {
  const activeFunds = new Set(positions.map((position) => position.fundAddress))
  const ordered = settlements
    .filter((settlement) => activeFunds.has(normalize(settlement.fund)))
    .slice()
    .sort((left, right) => Number(BigInt(left.timestamp) - BigInt(right.timestamp)))

  if (!ordered.length) return { values: [], labels: [], hasHistory: false }

  const prices = new Map<string, bigint>()
  const values: number[] = []
  const labels: string[] = []
  let cursor = 0

  while (cursor < ordered.length) {
    const timestamp = BigInt(ordered[cursor].timestamp)
    while (cursor < ordered.length && BigInt(ordered[cursor].timestamp) === timestamp) {
      const settlement = ordered[cursor]
      prices.set(
        normalize(settlement.fund),
        BigInt(settlement.pePostFeeWad ?? settlement.peWad),
      )
      cursor += 1
    }

    let portfolioValueWad = 0n
    for (const position of positions) {
      const price = prices.get(position.fundAddress) ?? WAD
      portfolioValueWad += (position.shares * price) / WAD
    }
    values.push(decimal(portfolioValueWad, WAD))
    labels.push(dateLabel(timestamp))
  }

  return { values, labels, hasHistory: values.length > 1 }
}

export async function loadPortfolio(address: string): Promise<PortfolioData> {
  const positionData = await fetchGraphql<PositionsResponse>(POSITIONS_QUERY, {
    lp: normalize(address),
  })
  const activeRows = positionData.lpPositions.items.filter((row) => BigInt(row.shares) > 0n)
  if (!activeRows.length) {
    return {
      positions: [],
      invested: 0,
      value: 0,
      pnl: 0,
      pnlPct: 0,
      series: [0, 0],
      seriesLabels: ['Now', 'Now'],
      hasIndexedHistory: false,
    }
  }

  const fundAddresses = [...new Set(activeRows.map((row) => normalize(row.fund)))]
  const details = await fetchGraphql<DetailsResponse>(DETAILS_QUERY, { funds: fundAddresses })
  const funds = new Map(details.funds.items.map((fund) => [normalize(fund.address), fund]))
  const missingFund = fundAddresses.find((fundAddress) => !funds.has(fundAddress))
  if (missingFund) {
    throw new Error(`Indexer returned no fund metadata for ${missingFund}.`)
  }

  const managerAddresses = [
    ...new Set(
      activeRows
        .map((row) => funds.get(normalize(row.fund))?.manager)
        .filter((manager): manager is string => Boolean(manager))
        .map(normalize),
    ),
  ]
  const managerProfiles = await Promise.all(
    managerAddresses.map(async (manager) => [manager, await profileStore.load(manager)] as const),
  )
  const managerNames = new Map(managerProfiles)

  const positions = activeRows.flatMap((row): PortfolioPosition[] => {
    const fundAddress = normalize(row.fund)
    const fund = funds.get(fundAddress)
    if (!fund) return []

    const shares = BigInt(row.shares)
    const price = BigInt(fund.lastPePostFeeWad ?? WAD)
    const currentValue = decimal((shares * price) / WAD, WAD)
    const deposited = decimal(BigInt(row.deposited6), USD6)
    const withdrawn = decimal(BigInt(row.withdrawn6), USD6)
    const claimed = decimal(BigInt(row.claimed6), USD6)
    const invested = Math.max(0, deposited - withdrawn)
    const pnl = currentValue + withdrawn + claimed - deposited

    return [
      {
        fundAddress,
        fund: fund.name,
        symbol: fund.symbol,
        manager: normalize(fund.manager),
        managerLabel:
          managerNames.get(normalize(fund.manager))?.username
            ? `@${managerNames.get(normalize(fund.manager))!.username}`
            : shortAddress(fund.manager),
        shares,
        invested,
        value: currentValue,
        pnl,
        pnlPct: deposited > 0 ? (pnl / deposited) * 100 : 0,
        accent: accentFor(fundAddress),
      },
    ]
  })

  const invested = positions.reduce((sum, position) => sum + position.invested, 0)
  const value = positions.reduce((sum, position) => sum + position.value, 0)
  const pnl = positions.reduce((sum, position) => sum + position.pnl, 0)
  const history = buildSeries(positions, details.settlements.items)
  const series = history.values.length > 1 ? history.values : [value, value]
  const seriesLabels = history.labels.length > 1 ? history.labels : ['Now', 'Now']

  return {
    positions,
    invested,
    value,
    pnl,
    pnlPct: invested > 0 ? (pnl / invested) * 100 : 0,
    series,
    seriesLabels,
    hasIndexedHistory: history.hasHistory,
  }
}

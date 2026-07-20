import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPortfolio } from './portfolioStore'

vi.mock('./profileStore', () => ({
  profileStore: { load: vi.fn().mockResolvedValue(null) },
}))

const LP = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'
const FUND = '0x1291be112d480055dafd8a610b7d1e203891c274'
const MANAGER = '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc'

function graphqlResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadPortfolio', () => {
  it('values active shares with post-fee NAV and includes realized cash flows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          graphqlResponse({
          lpPositions: {
            items: [
              {
                fund: FUND,
                lp: LP,
                shares: '2000000000000000000',
                deposited6: '2000000',
                withdrawn6: '500000',
                claimed6: '100000',
              },
              {
                fund: FUND,
                lp: LP,
                shares: '0',
                deposited6: '1000000',
                withdrawn6: '1000000',
                claimed6: '0',
              },
            ],
          },
          }),
        )
        .mockResolvedValueOnce(
          graphqlResponse({
            funds: {
            items: [
              {
                address: FUND,
                name: 'Devnet Alpha',
                symbol: 'DVA',
                manager: MANAGER,
                lastPePostFeeWad: '1100000000000000000',
              },
            ],
          },
            settlements: {
            items: [
              {
                fund: FUND,
                peWad: '1100000000000000000',
                pePostFeeWad: '1050000000000000000',
                timestamp: '100',
              },
              {
                fund: FUND,
                peWad: '1200000000000000000',
                pePostFeeWad: '1100000000000000000',
                timestamp: '200',
              },
            ],
            },
          }),
        ),
    )

    const result = await loadPortfolio(LP.toUpperCase())

    expect(result.positions).toHaveLength(1)
    expect(result.positions[0]).toMatchObject({
      fundAddress: FUND,
      fund: 'Devnet Alpha',
      symbol: 'DVA',
      manager: MANAGER,
      invested: 1.5,
      value: 2.2,
    })
    expect(result.positions[0]!.pnl).toBeCloseTo(0.8)
    expect(result.positions[0]!.pnlPct).toBeCloseTo(40)
    expect(result).toMatchObject({
      invested: 1.5,
      value: 2.2,
      hasIndexedHistory: true,
      series: [2.1, 2.2],
    })
    expect(result.pnl).toBeCloseTo(0.8)
  })

  it('returns a stable two-point series when the fund has not settled yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(
          graphqlResponse({
          lpPositions: {
            items: [
              {
                fund: FUND,
                lp: LP,
                shares: '3000000000000000000',
                deposited6: '3000000',
                withdrawn6: '0',
                claimed6: '0',
              },
            ],
          },
          }),
        )
        .mockResolvedValueOnce(
          graphqlResponse({
            funds: {
            items: [
              {
                address: FUND,
                name: 'Seed Fund',
                symbol: 'SEED',
                manager: MANAGER,
                lastPePostFeeWad: null,
              },
            ],
          },
            settlements: { items: [] },
          }),
        ),
    )

    const result = await loadPortfolio(LP)

    expect(result.value).toBe(3)
    expect(result.series).toEqual([3, 3])
    expect(result.seriesLabels).toEqual(['Now', 'Now'])
    expect(result.hasIndexedHistory).toBe(false)
  })

  it('surfaces GraphQL errors instead of displaying fabricated values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ message: 'indexing paused' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    await expect(loadPortfolio(LP)).rejects.toThrow('indexing paused')
  })
})

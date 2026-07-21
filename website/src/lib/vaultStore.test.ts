import { describe, expect, it } from 'vitest'
import type { Vault } from '../features/vaults/types'
import { currentEntryFeeBps } from './vaultStore'

function dynamicVault(navValueUsd: number, feeMinBps = 0, feeMaxBps = 500): Vault {
  return {
    navValueUsd,
    aumCapUsd: 10_000,
    config: { feeMinBps, feeMaxBps },
  } as Vault
}

describe('currentEntryFeeBps', () => {
  it('matches the on-chain midpoint curve observed in Dynamic Entry Test', () => {
    expect(currentEntryFeeBps(dynamicVault(0), 2_000)).toBe(50)
    expect(currentEntryFeeBps(dynamicVault(1_990), 2_000)).toBe(149)
    expect(currentEntryFeeBps(dynamicVault(3_969.14), 2_000)).toBe(248)
  })

  it('quotes the next public-testnet deposit from the indexed NAV', () => {
    expect(currentEntryFeeBps(dynamicVault(5_937.42), 2_000)).toBe(346)
  })

  it('keeps a fixed fee fixed regardless of utilization', () => {
    expect(currentEntryFeeBps(dynamicVault(0, 200, 200), 2_000)).toBe(200)
    expect(currentEntryFeeBps(dynamicVault(9_500, 200, 200), 2_000)).toBe(200)
  })
})

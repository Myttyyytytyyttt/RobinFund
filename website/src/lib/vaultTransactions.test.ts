import { describe, expect, it } from 'vitest'
import { planInitialProtectionFunding } from './vaultTransactions'

describe('initial protection funding preflight', () => {
  it('claims the public faucet when Robinhood testnet balance is insufficient', () => {
    expect(planInitialProtectionFunding({
      chainId: 46_630,
      balance6: 0n,
      allowance6: 2_000_000000n,
      amount6: 2_000_000000n,
      nextFaucetAt: 0n,
      blockTimestamp: 100n,
    })).toEqual({
      needsFaucet: true,
      needsApproval: false,
      shortfall6: 2_000_000000n,
    })
  })

  it('does not retry a testnet faucet that is still cooling down', () => {
    expect(planInitialProtectionFunding({
      chainId: 46_630,
      balance6: 1_000_000000n,
      allowance6: 0n,
      amount6: 2_000_000000n,
      nextFaucetAt: 200n,
      blockTimestamp: 100n,
    })).toEqual({
      needsFaucet: false,
      needsApproval: true,
      shortfall6: 1_000_000000n,
    })
  })

  it('never treats a production USDG shortfall as faucet-eligible', () => {
    expect(planInitialProtectionFunding({
      chainId: 4_663,
      balance6: 0n,
      allowance6: 0n,
      amount6: 2_000_000000n,
      nextFaucetAt: 0n,
      blockTimestamp: 100n,
    }).needsFaucet).toBe(false)
  })

  it('skips both faucet and approval when existing state is sufficient', () => {
    expect(planInitialProtectionFunding({
      chainId: 46_630,
      balance6: 5_000_000000n,
      allowance6: 2_000_000000n,
      amount6: 2_000_000000n,
    })).toEqual({
      needsFaucet: false,
      needsApproval: false,
      shortfall6: 0n,
    })
  })
})

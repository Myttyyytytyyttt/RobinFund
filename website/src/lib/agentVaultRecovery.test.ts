import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  advanceAgentVaultRecovery,
  clearAgentVaultRecovery,
  loadAgentVaultRecovery,
  saveAgentVaultRecovery,
} from './agentVaultRecovery'
import type { AgentVaultCreationInput } from './agentTransactions'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

const sponsor = '0x1111111111111111111111111111111111111111' as Address
const signer = '0x2222222222222222222222222222222222222222' as Address
const asset = '0x3333333333333333333333333333333333333333' as Address
const agentId = `0x${'44'.repeat(32)}` as Hex

const input: AgentVaultCreationInput = {
  manager: sponsor,
  name: 'Recovery Vault',
  symbol: 'REC',
  initialStake: '2000',
  perfFeeBps: 2_000,
  feeMinBps: 0,
  feeMaxBps: 200,
  managerEntryShareBps: 5_000,
  kFactor: 25,
  periodDays: 30,
  cooldownHours: 24,
  agentId,
  signer,
  displayName: 'Recovery Agent',
  strategySummary: 'Public strategy',
  metadataUri: '',
  runtimeKind: 'external',
  policy: {
    maxTradeBps: 1_000,
    maxConcentrationBps: 3_500,
    dailyTurnoverBps: 5_000,
    maxSlippageBps: 75,
    maxTradesPerDay: 24,
    minTradeInterval: 300,
    maxIntentLifetime: 300,
    allowedAssets: [asset],
  },
}

describe('AI vault session recovery', () => {
  it('persists the agent input before an onchain registration has a gateway job', () => {
    const storage = new MemoryStorage()
    const saved = saveAgentVaultRecovery({
      sponsor,
      agentId,
      jobId: null,
      input,
      identityEnvironment: 'production',
      stage: 'registering',
    }, storage)

    expect(loadAgentVaultRecovery(sponsor, storage)).toEqual(saved)
    expect(loadAgentVaultRecovery(sponsor, storage)?.jobId).toBeNull()
    expect(JSON.stringify(saved)).not.toContain('"proof"')
  })

  it('persists the exact public input and advances the same job', () => {
    const storage = new MemoryStorage()
    const saved = saveAgentVaultRecovery({
      sponsor,
      agentId,
      jobId: 'job-1',
      input,
      identityEnvironment: 'staging',
      stage: 'identity_check',
    }, storage)
    const advanced = advanceAgentVaultRecovery(saved, 'deploying', storage)
    const restored = loadAgentVaultRecovery(sponsor, storage)

    expect(restored).toEqual(advanced)
    expect(restored?.jobId).toBe('job-1')
    expect(restored?.input).toEqual(input)
    expect(JSON.stringify(restored)).not.toContain('"proof"')
  })

  it('isolates recovery records by sponsor and removes corrupt data', () => {
    const storage = new MemoryStorage()
    saveAgentVaultRecovery({
      sponsor,
      agentId,
      jobId: 'job-1',
      input,
      identityEnvironment: 'production',
      stage: 'agentbook',
    }, storage)
    const other = '0x5555555555555555555555555555555555555555' as Address
    expect(loadAgentVaultRecovery(other, storage)).toBeNull()
    expect(loadAgentVaultRecovery(sponsor, storage)?.agentId).toBe(agentId)

    clearAgentVaultRecovery(sponsor, storage)
    expect(loadAgentVaultRecovery(sponsor, storage)).toBeNull()
  })
})

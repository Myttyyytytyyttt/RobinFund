import { getAddress, isAddress, type Address, type Hex } from 'viem'
import type { AgentVaultCreationInput } from './agentTransactions'
import type { WorldIdentityEnvironment } from './worldIdentityCheck'

export const AGENT_VAULT_RECOVERY_PREFIX = 'nuvem:agent-vault-recovery:v1'

export type AgentVaultRecoveryStage =
  | 'registering'
  | 'identity_check'
  | 'agentbook'
  | 'backing'
  | 'deploying'
  | 'binding'

export type AgentVaultRecovery = {
  version: 1
  sponsor: Address
  agentId: Hex
  jobId: string | null
  input: AgentVaultCreationInput
  identityEnvironment: WorldIdentityEnvironment
  stage: AgentVaultRecoveryStage
  updatedAt: string
}

export function stageAfterWorldIdentity(
  environment: WorldIdentityEnvironment,
): Extract<AgentVaultRecoveryStage, 'agentbook' | 'backing'> {
  return environment === 'staging' ? 'backing' : 'agentbook'
}

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storageKey(sponsor: Address): string {
  return `${AGENT_VAULT_RECOVERY_PREFIX}:${sponsor.toLowerCase()}`
}

function browserStorage(): RecoveryStorage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function isInput(value: unknown, sponsor: Address, agentId: Hex): value is AgentVaultCreationInput {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<AgentVaultCreationInput>
  return (
    input.agentId?.toLowerCase() === agentId.toLowerCase()
    && typeof input.manager === 'string'
    && isAddress(input.manager)
    && getAddress(input.manager).toLowerCase() === sponsor.toLowerCase()
    && typeof input.signer === 'string'
    && isAddress(input.signer)
    && (input.runtimeKind === 'external' || input.runtimeKind === 'nuvem_reference')
    && typeof input.policy === 'object'
    && Array.isArray(input.policy?.allowedAssets)
    && input.policy.allowedAssets.every((asset) => isAddress(asset))
  )
}

export function parseAgentVaultRecovery(
  raw: string | null,
  expectedSponsor: Address,
): AgentVaultRecovery | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<AgentVaultRecovery>
    if (
      value.version !== 1
      || typeof value.sponsor !== 'string'
      || !isAddress(value.sponsor)
      || getAddress(value.sponsor).toLowerCase() !== expectedSponsor.toLowerCase()
      || typeof value.agentId !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test(value.agentId)
      || (
        value.jobId !== null
        && (
          typeof value.jobId !== 'string'
          || value.jobId.length === 0
          || value.jobId.length > 200
        )
      )
      || (value.jobId === null && value.stage !== 'registering')
      || (value.identityEnvironment !== 'production' && value.identityEnvironment !== 'staging')
      || !['registering', 'identity_check', 'agentbook', 'backing', 'deploying', 'binding'].includes(String(value.stage))
      || typeof value.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(value.updatedAt))
    ) return null
    const sponsor = getAddress(value.sponsor)
    const agentId = value.agentId.toLowerCase() as Hex
    if (!isInput(value.input, sponsor, agentId)) return null
    return {
      version: 1,
      sponsor,
      agentId,
      jobId: value.jobId,
      input: value.input,
      identityEnvironment: value.identityEnvironment,
      stage: value.stage as AgentVaultRecoveryStage,
      updatedAt: value.updatedAt,
    }
  } catch {
    return null
  }
}

export function loadAgentVaultRecovery(
  sponsor: Address,
  storage: RecoveryStorage | null = browserStorage(),
): AgentVaultRecovery | null {
  if (!storage) return null
  const key = storageKey(sponsor)
  const recovery = parseAgentVaultRecovery(storage.getItem(key), sponsor)
  if (!recovery) storage.removeItem(key)
  return recovery
}

export function saveAgentVaultRecovery(
  recovery: Omit<AgentVaultRecovery, 'version' | 'updatedAt'> & { updatedAt?: string },
  storage: RecoveryStorage | null = browserStorage(),
): AgentVaultRecovery {
  const value: AgentVaultRecovery = {
    ...recovery,
    version: 1,
    updatedAt: recovery.updatedAt ?? new Date().toISOString(),
  }
  if (storage) storage.setItem(storageKey(value.sponsor), JSON.stringify(value))
  return value
}

export function advanceAgentVaultRecovery(
  recovery: AgentVaultRecovery,
  stage: AgentVaultRecoveryStage,
  storage: RecoveryStorage | null = browserStorage(),
): AgentVaultRecovery {
  return saveAgentVaultRecovery({ ...recovery, stage }, storage)
}

export function clearAgentVaultRecovery(
  sponsor: Address,
  storage: RecoveryStorage | null = browserStorage(),
): void {
  storage?.removeItem(storageKey(sponsor))
}

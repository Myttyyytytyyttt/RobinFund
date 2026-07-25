import {
  IDKit,
  identityCheck,
  type IDKitResult,
  type IdentityAttribute,
  type IdentityCheckPreset,
} from '@worldcoin/idkit-core'
import { explainWorldProofError } from './worldIdNuvem'

export type WorldIdentityEnvironment = 'production' | 'staging'
export const AI_VAULT_IDENTITY_POLICY = 'ai-vault-eligibility-v1' as const
export const AI_VAULT_IDENTITY_POLICY_HASH = '0x6b980c5c9cad4224ab14ef18a67031da727051c99196bf367e099169970f1205' as const

export type NuvemIdentityCheckRequest = {
  credential: 'identity_check'
  verified: false
  reused: false
  requestId: string
  environment: WorldIdentityEnvironment
  signal: `0x${string}`
  policy: {
    id: typeof AI_VAULT_IDENTITY_POLICY
    version: number
    attributes: IdentityAttribute[]
    hash: `0x${string}`
  }
  appId: `app_${string}`
  action: string
  rpContext: {
    rp_id: string
    nonce: string
    created_at: number
    expires_at: number
    signature: string
  }
  allowLegacyProofs: false
  requireUserPresence: boolean
  expiresAt: string
}

function isCanonicalAiVaultPolicy(attributes: IdentityAttribute[]): boolean {
  if (attributes.length !== 2) return false
  const [document, age] = attributes
  return (
    document?.type === 'document_type'
    && document.value === 'passport'
    && age?.type === 'minimum_age'
    && age.value === 18
  )
}

export function configuredIdentityEnvironment(): WorldIdentityEnvironment {
  const configured = import.meta.env.VITE_WORLD_IDENTITY_ENVIRONMENT?.trim() || 'production'
  if (configured !== 'production' && configured !== 'staging') {
    throw new Error('VITE_WORLD_IDENTITY_ENVIRONMENT must be either production or staging.')
  }
  return configured
}

export function assertIdentityCheckRequest(
  input: NuvemIdentityCheckRequest,
  expectedEnvironment = configuredIdentityEnvironment(),
): NuvemIdentityCheckRequest {
  const expiresAt = Date.parse(input.expiresAt)
  const stagingApp = input.appId.startsWith('app_staging_')
  if (
    input.credential !== 'identity_check'
    || input.verified !== false
    || input.reused !== false
    || !input.requestId
    || input.environment !== expectedEnvironment
    || (input.environment === 'staging') !== stagingApp
    || !/^0x[0-9a-fA-F]{64}$/.test(input.signal)
    || input.policy.id !== AI_VAULT_IDENTITY_POLICY
    || !Number.isInteger(input.policy.version)
    || input.policy.version !== 1
    || !Array.isArray(input.policy.attributes)
    || !isCanonicalAiVaultPolicy(input.policy.attributes)
    || input.policy.hash.toLowerCase() !== AI_VAULT_IDENTITY_POLICY_HASH
    || !input.action
    || !input.rpContext?.rp_id
    || !input.rpContext.nonce
    || !input.rpContext.signature
    || input.allowLegacyProofs !== false
    || input.requireUserPresence !== false
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) {
    throw new Error('World Identity Check request does not match the configured Nuvem policy and environment.')
  }
  return input
}

export function identityCheckPresetForRequest(
  input: NuvemIdentityCheckRequest,
): IdentityCheckPreset {
  return identityCheck({
    attributes: input.policy.attributes,
    legacy_signal: input.signal,
  })
}

export function identityCheckGatewayBody(environment: WorldIdentityEnvironment): {
  credential: 'identity_check'
  environment: WorldIdentityEnvironment
  policy: typeof AI_VAULT_IDENTITY_POLICY
} {
  return {
    credential: 'identity_check',
    environment,
    policy: AI_VAULT_IDENTITY_POLICY,
  }
}

function identityError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.toLowerCase().includes('identity_attributes_not_matched')) {
    return new Error('World Identity Check could not attest the required document attributes.')
  }
  return new Error(explainWorldProofError('World Identity Check', error))
}

/**
 * Runs the document-based World ID 4.0 Identity Check. The backend-signed
 * request is authoritative: policy attributes and environment are never
 * substituted by frontend defaults.
 */
export async function requestIdentityCheckProof(
  input: NuvemIdentityCheckRequest,
  onConnectorUri: (uri: string) => void,
  options: { timeoutMs?: number; signal?: AbortSignal; expectedEnvironment?: WorldIdentityEnvironment } = {},
): Promise<IDKitResult> {
  assertIdentityCheckRequest(input, options.expectedEnvironment)
  const request = await IDKit.request({
    app_id: input.appId,
    action: input.action,
    rp_context: input.rpContext,
    allow_legacy_proofs: false,
    require_user_presence: input.requireUserPresence,
    environment: input.environment,
  }).preset(identityCheckPresetForRequest(input))
  if (!request.connectorURI) throw new Error('World App did not return an Identity Check link.')
  onConnectorUri(request.connectorURI)

  let completion: Awaited<ReturnType<typeof request.pollUntilCompletion>>
  try {
    completion = await request.pollUntilCompletion({
      pollInterval: 2_000,
      timeout: options.timeoutMs ?? 5 * 60_000,
      signal: options.signal,
    })
  } catch (error) {
    throw identityError(error)
  }
  if (!completion.success) throw identityError(completion.error)
  if (
    completion.result.protocol_version !== '4.0'
    || !('identity_attested' in completion.result)
    || completion.result.identity_attested !== true
    || completion.result.environment !== input.environment
  ) {
    throw new Error('World App returned a proof without the requested Identity Check attestation or environment.')
  }
  return completion.result
}

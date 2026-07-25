import { IDKit, proofOfHuman, type IDKitResult } from '@worldcoin/idkit-core'

export const NUVEM_WORLD_APP_ID = 'app_5fe197d24d83c55573c5d9d0356f3d6e' as const
export const NUVEM_WORLD_RP_ID = 'rp_db7d77ff9edef255' as const
export const NUVEM_WORLD_ACTION = 'sponsor-ai-vault' as const

export type NuvemWorldIdRequest = {
  requestId: string
  appId: `app_${string}`
  action: string
  signal: `0x${string}`
  rpContext: {
    rp_id: string
    nonce: string
    created_at: number
    expires_at: number
    signature: string
  }
  allowLegacyProofs: true
  expiresAt: string
}

export function assertNuvemWorldIdRequest(input: NuvemWorldIdRequest): NuvemWorldIdRequest {
  if (
    input.appId !== NUVEM_WORLD_APP_ID
    || input.rpContext.rp_id !== NUVEM_WORLD_RP_ID
    || input.action !== NUVEM_WORLD_ACTION
    || input.allowLegacyProofs !== true
    || !/^0x[0-9a-f]{64}$/.test(input.signal)
  ) throw new Error('World request is not the pinned Nuvem World ID 4.0 action.')
  return input
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

export function explainWorldProofError(context: string, errorCode: unknown): string {
  const raw = typeof errorCode === 'string'
    ? errorCode
    : errorCode instanceof Error
      ? errorCode.message
      : 'unknown_error'
  const normalized = raw.toLowerCase()
  const code = normalized.includes('network')
    || normalized.includes('connection')
    || normalized.includes('failed to fetch')
    || normalized.includes('timeout')
    ? 'connection_failed'
    : raw
  if (code === 'credential_unavailable') {
    return `${context} requires an Orb-verified World ID. Creating a World App account is not enough. Complete Proof of Human verification at an Orb, let the credential sync, and retry.`
  }
  if (code === 'inclusion_proof_pending') {
    return `${context} is waiting for the new World credential to finish syncing. Wait a few minutes and retry.`
  }
  if (code === 'connection_failed') {
    return `${context} could not reach the World bridge. Keep this page open, update World App, check the phone connection, and retry with a fresh QR.`
  }
  if (code === 'world_id_4_not_available') {
    return `${context} could not access the World ID 4.0 credential. A verified Orb account can retry through the supported legacy Orb fallback.`
  }
  if (code === 'user_rejected' || code === 'verification_rejected') {
    return `${context} was cancelled in World App.`
  }
  return `${context} failed: ${code}`
}

/**
 * Requests the Nuvem-owned World ID action. World ID 4.0 Proof of Human is
 * preferred; verified legacy Orb proofs are accepted without allowing Device,
 * Document or Selfie credentials. The opaque proof only lives in memory until
 * it is sent to the gateway; it is never persisted in browser storage.
 */
export async function requestNuvemWorldIdProof(
  input: NuvemWorldIdRequest,
  onConnectorUri: (uri: string) => void,
  timeoutMs = 5 * 60_000,
): Promise<IDKitResult> {
  assertNuvemWorldIdRequest(input)
  const expiresAt = Date.parse(input.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('The Nuvem World request expired. Please retry.')
  const request = await IDKit.request({
    app_id: input.appId,
    action: input.action,
    rp_context: input.rpContext,
    allow_legacy_proofs: input.allowLegacyProofs,
    environment: 'production',
  }).preset(proofOfHuman({ signal: input.signal }))
  if (!request.connectorURI) throw new Error('World App did not return a Nuvem verification link.')
  onConnectorUri(request.connectorURI)

  // IDKit owns the bridge polling. The small delay prevents a tight loop if a
  // future transport resolves synchronously before World App has connected.
  await delay(50)
  let completion: Awaited<ReturnType<typeof request.pollUntilCompletion>>
  try {
    completion = await request.pollUntilCompletion({ pollInterval: 2_000, timeout: timeoutMs })
  } catch (error) {
    throw new Error(explainWorldProofError('Nuvem World verification', error))
  }
  if (!completion.success) throw new Error(explainWorldProofError('Nuvem World verification', completion.error))
  return completion.result
}

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
  allowLegacyProofs: false
  expiresAt: string
}

export function assertNuvemWorldIdRequest(input: NuvemWorldIdRequest): NuvemWorldIdRequest {
  if (
    input.appId !== NUVEM_WORLD_APP_ID
    || input.rpContext.rp_id !== NUVEM_WORLD_RP_ID
    || input.action !== NUVEM_WORLD_ACTION
    || input.allowLegacyProofs !== false
    || !/^0x[0-9a-f]{64}$/.test(input.signal)
  ) throw new Error('World request is not the pinned Nuvem World ID 4.0 action.')
  return input
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

/**
 * Requests the Nuvem-owned World ID 4.0 action. The opaque proof only lives in
 * memory until it is sent to the gateway; it is never persisted in browser storage.
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
  const completion = await request.pollUntilCompletion({ pollInterval: 2_000, timeout: timeoutMs })
  if (!completion.success) throw new Error(`Nuvem World verification failed: ${completion.error}`)
  return completion.result
}

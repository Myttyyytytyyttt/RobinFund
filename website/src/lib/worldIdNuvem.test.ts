import { describe, expect, it } from 'vitest'
import {
  assertNuvemWorldIdRequest,
  explainWorldProofError,
  NUVEM_WORLD_ACTION,
  NUVEM_WORLD_APP_ID,
  NUVEM_WORLD_RP_ID,
  type NuvemWorldIdRequest,
} from './worldIdNuvem'

const request: NuvemWorldIdRequest = {
  requestId: '00000000-0000-4000-8000-000000000001',
  appId: NUVEM_WORLD_APP_ID,
  action: NUVEM_WORLD_ACTION,
  signal: `0x${'11'.repeat(32)}`,
  rpContext: {
    rp_id: NUVEM_WORLD_RP_ID,
    nonce: 'nonce',
    created_at: 1,
    expires_at: 2,
    signature: `0x${'22'.repeat(65)}`,
  },
  allowLegacyProofs: true,
  expiresAt: '2099-01-01T00:00:00.000Z',
}

describe('Nuvem World ID 4.0 request pinning', () => {
  it('accepts only the production Nuvem app, RP and action', () => {
    expect(assertNuvemWorldIdRequest(request)).toBe(request)
  })

  it('rejects a request redirected to another World app', () => {
    expect(() => assertNuvemWorldIdRequest({ ...request, appId: 'app_attacker' }))
      .toThrow('pinned Nuvem World ID 4.0 action')
  })

  it('requires the verified Orb fallback for accounts without a v4 credential', () => {
    expect(() => assertNuvemWorldIdRequest({
      ...request,
      allowLegacyProofs: false as true,
    })).toThrow('pinned Nuvem World ID 4.0 action')
  })

  it('explains that credential_unavailable requires Orb verification', () => {
    expect(explainWorldProofError('Nuvem World verification', 'credential_unavailable'))
      .toContain('Orb-verified World ID')
  })

  it('distinguishes credential synchronization from rejection', () => {
    expect(explainWorldProofError('Nuvem World verification', 'inclusion_proof_pending'))
      .toContain('finish syncing')
    expect(explainWorldProofError('Nuvem World verification', 'user_rejected'))
      .toContain('cancelled')
  })

  it('turns a bridge connection failure into an actionable retry', () => {
    expect(explainWorldProofError('Nuvem World verification', 'connection_failed'))
      .toContain('fresh QR')
    expect(explainWorldProofError('Nuvem World verification', new Error('Network request timed out')))
      .toContain('fresh QR')
  })
})

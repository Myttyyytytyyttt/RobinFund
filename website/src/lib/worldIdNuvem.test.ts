import { describe, expect, it } from 'vitest'
import {
  assertNuvemWorldIdRequest,
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
  allowLegacyProofs: false,
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

  it('rejects legacy fallback for the Nuvem sponsor gate', () => {
    expect(() => assertNuvemWorldIdRequest({
      ...request,
      allowLegacyProofs: true as false,
    })).toThrow('pinned Nuvem World ID 4.0 action')
  })
})

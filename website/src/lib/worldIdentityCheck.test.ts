import { describe, expect, it } from 'vitest'
import {
  AI_VAULT_IDENTITY_POLICY_HASH,
  assertIdentityCheckRequest,
  identityCheckGatewayBody,
  identityCheckPresetForRequest,
  type NuvemIdentityCheckRequest,
} from './worldIdentityCheck'

function request(
  environment: 'production' | 'staging' = 'production',
): NuvemIdentityCheckRequest {
  return {
    credential: 'identity_check',
    verified: false,
    reused: false,
    requestId: '00000000-0000-4000-8000-000000000001',
    environment,
    signal: `0x${'11'.repeat(32)}`,
    policy: {
      id: 'ai-vault-eligibility-v1',
      version: 1,
      attributes: [
        { type: 'document_type', value: 'passport' },
        { type: 'minimum_age', value: 18 },
      ],
      hash: AI_VAULT_IDENTITY_POLICY_HASH,
    },
    appId: environment === 'staging' ? 'app_staging_nuvem' : 'app_nuvem',
    action: 'sponsor-ai-vault-identity',
    rpContext: {
      rp_id: 'rp_nuvem',
      nonce: 'nonce',
      created_at: 1,
      expires_at: 2,
      signature: `0x${'33'.repeat(65)}`,
    },
    allowLegacyProofs: false,
    requireUserPresence: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  }
}

describe('World Identity Check request pinning', () => {
  it('accepts the backend-signed production policy', () => {
    const input = request()
    expect(assertIdentityCheckRequest(input, 'production')).toBe(input)
  })

  it('accepts staging only when both the build and app are staging', () => {
    const input = request('staging')
    expect(assertIdentityCheckRequest(input, 'staging')).toBe(input)
    expect(() => assertIdentityCheckRequest(input, 'production')).toThrow('policy and environment')
    expect(() => assertIdentityCheckRequest({ ...input, appId: 'app_production' }, 'staging'))
      .toThrow('policy and environment')
  })

  it('builds the exact gateway selector without a production fallback', () => {
    expect(identityCheckGatewayBody('staging')).toEqual({
      credential: 'identity_check',
      environment: 'staging',
      policy: 'ai-vault-eligibility-v1',
    })
  })

  it('requires a sponsor-and-agent signal for legacy_signal binding', () => {
    expect(() => assertIdentityCheckRequest({
      ...request(),
      signal: '0x1234',
    }, 'production')).toThrow('policy and environment')
  })

  it('binds the exact backend policy and signal to the IdentityCheck preset', () => {
    const input = request()
    expect(identityCheckPresetForRequest(input)).toEqual({
      type: 'IdentityCheck',
      attributes: input.policy.attributes,
      legacy_signal: input.signal,
    })
  })

  it('rejects a downgraded legacy proof request or changed eligibility policy', () => {
    expect(() => assertIdentityCheckRequest({
      ...request(),
      allowLegacyProofs: true as false,
    }, 'production')).toThrow('policy and environment')
    expect(() => assertIdentityCheckRequest({
      ...request(),
      policy: { ...request().policy, id: 'other-policy' as 'ai-vault-eligibility-v1' },
    }, 'production')).toThrow('policy and environment')
    expect(() => assertIdentityCheckRequest({
      ...request(),
      policy: { ...request().policy, hash: `0x${'22'.repeat(32)}` },
    }, 'production')).toThrow('policy and environment')
  })

  it('rejects invasive, extra or changed identity attributes', () => {
    expect(() => assertIdentityCheckRequest({
      ...request(),
      policy: {
        ...request().policy,
        attributes: [
          ...request().policy.attributes,
          { type: 'full_name', value: 'Alice Example' },
        ],
      },
    }, 'production')).toThrow('policy and environment')
    expect(() => assertIdentityCheckRequest({
      ...request(),
      policy: {
        ...request().policy,
        attributes: [
          { type: 'document_type', value: 'passport' },
          { type: 'minimum_age', value: 21 },
        ],
      },
    }, 'production')).toThrow('policy and environment')
    expect(() => assertIdentityCheckRequest({
      ...request(),
      policy: {
        ...request().policy,
        attributes: [...request().policy.attributes].reverse(),
      },
    }, 'production')).toThrow('policy and environment')
  })
})

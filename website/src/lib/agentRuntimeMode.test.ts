import { describe, expect, it } from 'vitest'
import { resolveAgentRuntimeKind } from './agentRuntimeMode'

describe('AI agent runtime selection', () => {
  it('falls back to managed provisioning when External has no signer', () => {
    expect(resolveAgentRuntimeKind('external', '  ')).toBe('nuvem_reference')
  })

  it('preserves External when a public signer was supplied', () => {
    expect(resolveAgentRuntimeKind(
      'external',
      '0x2222222222222222222222222222222222222222',
    )).toBe('external')
  })

  it('preserves an explicit Nuvem reference selection', () => {
    expect(resolveAgentRuntimeKind('nuvem_reference', '')).toBe('nuvem_reference')
  })
})

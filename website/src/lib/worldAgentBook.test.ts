import { describe, expect, it } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { normalizeAgentBookProof } from './worldAgentBook'

describe('normalizeAgentBookProof', () => {
  it('accepts the JSON proof shape returned by some World App clients', () => {
    const proof = Array.from({ length: 8 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, '0')}`)
    expect(normalizeAgentBookProof({ proof: JSON.stringify(proof) })).toEqual(proof)
  })

  it('decodes the canonical ABI-encoded uint256[8] proof', () => {
    const encoded = encodeAbiParameters([{ type: 'uint256[8]' }], [[1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]])
    const normalized = normalizeAgentBookProof({ proof: encoded })
    expect(normalized).toHaveLength(8)
    expect(normalized[0]).toBe(`0x${'1'.padStart(64, '0')}`)
    expect(normalized[7]).toBe(`0x${'8'.padStart(64, '0')}`)
  })

  it('fails closed on an unsupported proof', () => {
    expect(() => normalizeAgentBookProof({ proof: 'not-a-proof' })).toThrow('unsupported AgentBook proof')
  })
})

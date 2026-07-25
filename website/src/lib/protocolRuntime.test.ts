import { describe, expect, it } from 'vitest'
import { resolveProtocolIndexerUrl } from './protocolRuntime'

describe('protocol indexer runtime', () => {
  it('disables an explicit loopback indexer when local services are disabled', () => {
    expect(resolveProtocolIndexerUrl(
      'http://127.0.0.1:42069/graphql',
      true,
      true,
    )).toBeUndefined()
  })

  it('keeps a remote indexer in staging mode', () => {
    expect(resolveProtocolIndexerUrl(
      'https://indexer.example/graphql',
      true,
      true,
    )).toBe('https://indexer.example/graphql')
  })

  it('uses the local fallback only for the complete local stack', () => {
    expect(resolveProtocolIndexerUrl(undefined, true, false))
      .toBe('http://127.0.0.1:42069/graphql')
    expect(resolveProtocolIndexerUrl(undefined, true, true)).toBeUndefined()
  })
})

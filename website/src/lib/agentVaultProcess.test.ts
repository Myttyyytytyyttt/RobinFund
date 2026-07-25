import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./protocolRuntime', () => ({
  loadProtocolRuntime: async () => ({
    agentGatewayUrl: 'https://gateway.example',
  }),
}))

import {
  AgentGatewayRequestError,
  processAgentVaultJob,
} from './agentTransactions'

const agentId = `0x${'11'.repeat(32)}`
const responseJob = {
  id: 'job-1',
  agentId,
  state: 'deploying_controller',
  controller: null,
  fund: null,
  stakeEscrow: null,
  transactionHashes: [],
  attempts: 1,
  errorCode: null,
  requiredStake6: '2000000000',
}

describe('request-driven vault processing', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts an authenticated and idempotent worker tick', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ vaultJob: responseJob, worker: { claimed: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    await expect(processAgentVaultJob(
      'job-1',
      'sponsor-session',
      'request-driven-tick-1',
    )).resolves.toMatchObject({
      id: 'job-1',
      agentId,
      state: 'deploying_controller',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://gateway.example/v1/agent-vaults/job-1/process')
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      headers: {
        authorization: 'Bearer sponsor-session',
        'content-type': 'application/json',
        'idempotency-key': 'request-driven-tick-1',
      },
    })
  })

  it('preserves the gateway error code for authentication failures', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({
        error: {
          code: 'VAULT_JOB_FORBIDDEN',
          message: 'The job belongs to another sponsor.',
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ))

    const failure = processAgentVaultJob('job-1', 'wrong-session', 'request-driven-tick-2')
    await expect(failure).rejects.toBeInstanceOf(AgentGatewayRequestError)
    await expect(failure).rejects.toMatchObject({
      code: 'VAULT_JOB_FORBIDDEN',
      status: 403,
    })
  })
})

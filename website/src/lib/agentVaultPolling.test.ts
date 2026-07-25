import { describe, expect, it } from 'vitest'
import {
  AgentGatewayRequestError,
  AgentVaultPollingCancelled,
  assertAgentVaultJobAgent,
  pollAgentVaultJob,
  type AgentVaultJobStatus,
} from './agentTransactions'

function job(state: string, errorCode: string | null = null): AgentVaultJobStatus {
  return {
    id: 'job-1',
    agentId: `0x${'11'.repeat(32)}`,
    state,
    controller: null,
    fund: null,
    stakeEscrow: null,
    transactionHashes: [],
    attempts: 0,
    errorCode,
    requiredStake6: '2000000000',
  }
}

describe('AI vault deployment polling', () => {
  it('fails closed when a saved job belongs to another agent', () => {
    expect(() => assertAgentVaultJobAgent(
      job('requested'),
      `0x${'22'.repeat(32)}`,
    )).toThrow('different agent')
  })

  it('reports intermediate states and returns the resumable bind state', async () => {
    const statuses = [job('requested'), job('deploying_controller'), job('awaiting_sponsor_bind')]
    const observed: string[] = []
    const result = await pollAgentVaultJob(
      async () => statuses.shift() ?? job('awaiting_sponsor_bind'),
      { intervalMs: 1, timeoutMs: 500, onStatus: (value) => observed.push(value.state) },
    )
    expect(result.state).toBe('awaiting_sponsor_bind')
    expect(observed).toEqual(['requested', 'deploying_controller', 'awaiting_sponsor_bind'])
  })

  it('requests one durable worker transition after every pending status', async () => {
    const statuses = [job('requested'), job('deploying_controller'), job('ready')]
    const advanced: string[] = []
    const result = await pollAgentVaultJob(
      async () => statuses.shift() ?? job('ready'),
      {
        intervalMs: 1,
        timeoutMs: 500,
        advance: async (value) => {
          advanced.push(value.state)
        },
      },
    )

    expect(result.state).toBe('ready')
    expect(advanced).toEqual(['requested', 'deploying_controller'])
  })

  it('retries when a request-driven worker tick is already busy', async () => {
    let reads = 0
    const result = await pollAgentVaultJob(
      async () => {
        reads += 1
        return job(reads === 1 ? 'requested' : 'awaiting_sponsor_bind')
      },
      {
        intervalMs: 1,
        timeoutMs: 500,
        advance: async () => {
          throw new AgentGatewayRequestError('VAULT_WORKER_BUSY', 409, 'worker is busy')
        },
      },
    )

    expect(result.state).toBe('awaiting_sponsor_bind')
    expect(reads).toBe(2)
  })

  it('surfaces non-transient worker conflicts immediately', async () => {
    await expect(pollAgentVaultJob(
      async () => job('requested'),
      {
        intervalMs: 1,
        timeoutMs: 500,
        advance: async () => {
          throw new AgentGatewayRequestError('VAULT_NOT_BACKED', 409, 'identity backing is missing')
        },
      },
    )).rejects.toMatchObject({
      code: 'VAULT_NOT_BACKED',
      status: 409,
    })
  })

  it('surfaces permanent worker configuration failures immediately', async () => {
    await expect(pollAgentVaultJob(
      async () => job('requested'),
      {
        intervalMs: 1,
        timeoutMs: 500,
        advance: async () => {
          throw new AgentGatewayRequestError(
            'VAULT_WORKER_NOT_CONFIGURED',
            503,
            'deployment worker is not configured',
          )
        },
      },
    )).rejects.toMatchObject({
      code: 'VAULT_WORKER_NOT_CONFIGURED',
      status: 503,
    })
  })

  it('pauses immediately when its AbortSignal is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(pollAgentVaultJob(async () => job('requested'), {
      signal: controller.signal,
    })).rejects.toBeInstanceOf(AgentVaultPollingCancelled)
  })

  it('ignores an in-flight ready response after the modal pauses polling', async () => {
    const controller = new AbortController()
    let release: ((value: AgentVaultJobStatus) => void) | undefined
    const pending = pollAgentVaultJob(
      () => new Promise<AgentVaultJobStatus>((resolve) => { release = resolve }),
      { signal: controller.signal },
    )
    controller.abort()
    release?.(job('ready'))
    await expect(pending).rejects.toBeInstanceOf(AgentVaultPollingCancelled)
  })

  it('surfaces terminal worker failures without creating another job', async () => {
    await expect(pollAgentVaultJob(async () => job('failed', 'OPERATOR_NOT_FUND_REGISTRY_OWNER')))
      .rejects.toThrow('OPERATOR_NOT_FUND_REGISTRY_OWNER')
  })

  it('tolerates a temporary status outage during a live job', async () => {
    let calls = 0
    const result = await pollAgentVaultJob(async () => {
      calls += 1
      if (calls === 1) throw new Error('temporary gateway outage')
      return job('ready')
    }, { intervalMs: 1, timeoutMs: 500 })
    expect(result.state).toBe('ready')
    expect(calls).toBe(2)
  })
})

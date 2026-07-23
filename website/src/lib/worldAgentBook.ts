import { createWorldBridgeStore, type ISuccessResult } from '@worldcoin/idkit-core-legacy'
import { solidityEncode } from '@worldcoin/idkit-core-legacy/hashing'
import { decodeAbiParameters, type Address, type Hex } from 'viem'

export const CANONICAL_AGENTBOOK = '0xA23aB2712eA7BBa896930544C7d6636a96b944dA' as Address
export const AGENTBOOK_WORLD_APP_ID = 'app_a7c3e2b6b83927251a0db5345bd7146a' as const
export const AGENTBOOK_WORLD_ACTION = 'agentbook-registration' as const

export type AgentBookProof = {
  root: string
  nonce: string
  nullifierHash: string
  proof: Hex[]
}

export type AgentBookRequest = {
  signer: Address
  appId: `app_${string}`
  action: string
  nextNonce: string
}

export function normalizeAgentBookProof(result: Pick<ISuccessResult, 'proof'>): Hex[] {
  if (result.proof.startsWith('[')) {
    try {
      const parsed = JSON.parse(result.proof) as unknown
      if (
        Array.isArray(parsed)
        && parsed.length === 8
        && parsed.every((value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value))
      ) return parsed.map((value) => value.toLowerCase() as Hex)
    } catch {
      // Older World App clients return an ABI-encoded uint256[8].
    }
  }

  try {
    const [decoded] = decodeAbiParameters([{ type: 'uint256[8]' }], result.proof as Hex)
    return decoded.map((value) => `0x${value.toString(16).padStart(64, '0')}` as Hex)
  } catch {
    throw new Error('World App returned an unsupported AgentBook proof format.')
  }
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

/**
 * Runs the official AgentBook IDKit request in the browser. The QR/deep link is
 * generated locally and the anonymous World identifier is never returned here.
 */
export async function requestAgentBookProof(
  request: AgentBookRequest,
  onConnectorUri: (uri: string) => void,
  timeoutMs = 5 * 60_000,
): Promise<AgentBookProof> {
  if (!/^\d+$/.test(request.nextNonce)) throw new Error('AgentBook returned an invalid nonce.')
  const world = createWorldBridgeStore()
  const signal = solidityEncode(['address', 'uint256'], [request.signer, BigInt(request.nextNonce)])
  await world.getState().createClient({ app_id: request.appId, action: request.action, signal })
  const connectorUri = world.getState().connectorURI
  if (!connectorUri) throw new Error('World App did not return a verification link.')
  onConnectorUri(connectorUri)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await world.getState().pollForUpdates()
    const { result, errorCode } = world.getState()
    if (result) {
      return {
        root: result.merkle_root,
        nonce: request.nextNonce,
        nullifierHash: result.nullifier_hash,
        proof: normalizeAgentBookProof(result),
      }
    }
    if (errorCode) throw new Error(`World verification failed: ${errorCode}`)
    await delay(1_000)
  }
  throw new Error('World verification timed out. Open the link again and retry.')
}

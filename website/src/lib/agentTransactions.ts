import {
  createPublicClient,
  createWalletClient,
  custom,
  encodePacked,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { robinhoodChain } from './chains'
import { loadProtocolRuntime } from './protocolRuntime'
import { addInitialProtection, type BrowserWallet, type VaultCreationInput, type VaultDeployment } from './vaultTransactions'
import { AGENTBOOK_WORLD_ACTION, AGENTBOOK_WORLD_APP_ID, CANONICAL_AGENTBOOK } from './worldAgentBook'
import { assertNuvemWorldIdRequest, type NuvemWorldIdRequest } from './worldIdNuvem'
import {
  AI_VAULT_IDENTITY_POLICY_HASH,
  assertIdentityCheckRequest,
  identityCheckGatewayBody,
  type NuvemIdentityCheckRequest,
  type WorldIdentityEnvironment,
} from './worldIdentityCheck'

const registryAbi = parseAbi([
  'function register(bytes32 agentId,address signer,string metadataURI)',
  'function sponsorOf(bytes32 agentId) view returns (address)',
  'function signerOf(bytes32 agentId) view returns (address)',
  'function setController(bytes32 agentId,address controller,bool enabled)',
  'function controllers(bytes32 agentId,address controller) view returns (bool)',
  'function rotateSigner(bytes32 agentId,address newSigner)',
  'function pause(bytes32 agentId)',
  'function activate((bytes32 agentId,address sponsor,address signer,bytes32 backingHash,uint64 agentBookBlock,uint48 validUntil,uint256 nonce) backing,bytes signature)',
])
const controllerAbi = parseAbi([
  'function bindFund(address fund)',
  'function FUND() view returns (address)',
  'function setPaused(bool value)',
])

export type AgentPolicyInput = {
  maxTradeBps: number
  maxConcentrationBps: number
  dailyTurnoverBps: number
  maxSlippageBps: number
  maxTradesPerDay: number
  minTradeInterval: number
  maxIntentLifetime: number
  allowedAssets: Address[]
}

export type AgentVaultCreationInput = VaultCreationInput & {
  agentId: Hex
  signer: Address
  displayName: string
  strategySummary: string
  metadataUri: string
  runtimeKind: 'external' | 'nuvem_reference'
  policy: AgentPolicyInput
}

export type AgentVaultDeployment = VaultDeployment & {
  agentId: Hex
  controller: Address
  agentRegistry: Address
  uniswapApiAdapter: Address
  uniswapApiAdapterId: string
  worldBacking: { mode: 'devnet-mock' | 'world-agentbook'; canonical: boolean; active: boolean }
}

export type ManagedSignerIdentity = {
  agentId: Hex
  signer: Address
  custody: 'nuvem-managed'
  provider: 'local-derived-v1' | 'kms-v1'
}

export type WorldRegistrationStatus = {
  agentId: Hex
  signer: Address
  registered: boolean
  contract: Address
  lookupNetwork: 'eip155:480'
  appId: `app_${string}`
  action: string
  nextNonce: string | null
  command: string
}

export type WorldRegistrationProof = {
  root: string
  nonce: string
  nullifierHash: string
  proof: Hex[]
}

export type NuvemWorldIdStatus =
  | { verified: true; reused: boolean }
  | ({ verified: false; reused: false } & NuvemWorldIdRequest)

export type NuvemIdentityCheckStatus =
  | {
    credential: 'identity_check'
    verified: true
    reused: boolean
    environment: WorldIdentityEnvironment
    action: string
    policy: {
      id: 'ai-vault-eligibility-v1'
      version: number
      hash: Hex
    }
    identityAttested: true
    verifiedAt: string
    validUntil: string
  }
  | NuvemIdentityCheckRequest

export class AgentGatewayRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AgentGatewayRequestError'
  }
}

export async function createNuvemWorldIdRequest(
  agentId: Hex,
  accessToken: string,
): Promise<NuvemWorldIdStatus> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('Nuvem World ID is not configured.')
  const response = await fetch(new URL(`/v1/agents/${agentId}/world-id/request`, runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: '{}',
  })
  const payload = await response.json() as { worldId?: NuvemWorldIdStatus; error?: { message?: string } }
  if (!response.ok || !payload.worldId) {
    throw new Error(payload.error?.message || `Nuvem World request returned HTTP ${response.status}`)
  }
  if (!payload.worldId.verified) assertNuvemWorldIdRequest(payload.worldId)
  return payload.worldId
}

export async function submitNuvemWorldIdProof(
  agentId: Hex,
  requestId: string,
  proof: unknown,
  accessToken: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<void> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('Nuvem World ID is not configured.')
  const response = await fetch(new URL(`/v1/agents/${agentId}/world-id/verify`, runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ requestId, proof }),
  })
  const payload = await response.json() as {
    worldId?: { verified?: boolean }
    error?: { code?: string; message?: string }
  }
  if (!response.ok || payload.worldId?.verified !== true) {
    throw new AgentGatewayRequestError(
      payload.error?.code || 'WORLD_ID_HTTP_ERROR',
      response.status,
      payload.error?.message || `Nuvem World verification returned HTTP ${response.status}`,
    )
  }
}

export async function createNuvemIdentityCheckRequest(
  agentId: Hex,
  accessToken: string,
  environment: WorldIdentityEnvironment,
): Promise<NuvemIdentityCheckStatus> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('World Identity Check is not configured.')
  const response = await fetch(new URL(`/v1/agents/${agentId}/world-id/request`, runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(identityCheckGatewayBody(environment)),
  })
  const payload = await response.json() as {
    worldId?: NuvemIdentityCheckStatus
    error?: { code?: string; message?: string }
  }
  if (!response.ok || !payload.worldId) {
    throw new AgentGatewayRequestError(
      payload.error?.code || 'WORLD_IDENTITY_HTTP_ERROR',
      response.status,
      payload.error?.message || `World Identity Check request returned HTTP ${response.status}`,
    )
  }
  if (payload.worldId.credential !== 'identity_check' || payload.worldId.environment !== environment) {
    throw new Error('World Identity Check response belongs to a different credential or environment.')
  }
  if (!payload.worldId.verified) assertIdentityCheckRequest(payload.worldId, environment)
  else if (
    payload.worldId.identityAttested !== true
    || payload.worldId.policy?.id !== identityCheckGatewayBody(environment).policy
    || payload.worldId.policy.version !== 1
    || payload.worldId.policy.hash.toLowerCase() !== AI_VAULT_IDENTITY_POLICY_HASH
    || !payload.worldId.action
    || !Number.isFinite(Date.parse(payload.worldId.validUntil))
    || Date.parse(payload.worldId.validUntil) <= Date.now()
  ) {
    throw new Error('World Identity Check response does not contain an active attestation for this policy.')
  }
  return payload.worldId
}

export async function submitNuvemIdentityCheckProof(
  agentId: Hex,
  requestId: string,
  proof: unknown,
  accessToken: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<void> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('World Identity Check is not configured.')
  const response = await fetch(new URL(`/v1/agents/${agentId}/world-id/verify`, runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ credential: 'identity_check', requestId, proof }),
  })
  const payload = await response.json() as {
    worldId?: {
      credential?: string
      verified?: boolean
      identityAttested?: boolean
    }
    error?: { code?: string; message?: string }
  }
  if (
    !response.ok
    || payload.worldId?.credential !== 'identity_check'
    || payload.worldId.verified !== true
    || payload.worldId.identityAttested !== true
  ) {
    throw new AgentGatewayRequestError(
      payload.error?.code || 'WORLD_IDENTITY_HTTP_ERROR',
      response.status,
      payload.error?.message || `World Identity Check verification returned HTTP ${response.status}`,
    )
  }
}

function randomHex32(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

export function createAgentId(sponsor: Address, signer: Address, salt: Hex = randomHex32()): Hex {
  return keccak256(encodePacked(['string', 'address', 'address', 'bytes32'], ['nuvem-agent-v1', sponsor, signer, salt]))
}

export async function provisionManagedSigner(
  sponsor: Address,
  provisioningKey: string,
  accessToken?: string,
): Promise<ManagedSignerIdentity> {
  const runtime = await loadProtocolRuntime(true)
  const local = runtime.creatorEnabled && runtime.creatorUrl
  const endpoint = local
    ? new URL('/managed-signers', runtime.creatorUrl)
    : runtime.agentGatewayUrl
      ? new URL('/v1/managed-signers', runtime.agentGatewayUrl)
      : null
  if (!endpoint) throw new Error('Nuvem reference signing is not configured on this environment.')
  if (!local && !accessToken) throw new Error('A sponsor session is required to provision the Nuvem agent.')

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      'content-type': 'application/json',
      'idempotency-key': provisioningKey,
    },
    body: JSON.stringify(local ? { sponsor, provisioningKey } : { provisioningKey }),
  })
  const payload = await response.json() as {
    managedSigner?: ManagedSignerIdentity
    error?: string | { message?: string }
  }
  const message = typeof payload.error === 'string' ? payload.error : payload.error?.message
  if (!response.ok || !payload.managedSigner) throw new Error(message || `Managed signer returned HTTP ${response.status}`)
  if (!isAddress(payload.managedSigner.signer) || !/^0x[0-9a-fA-F]{64}$/.test(payload.managedSigner.agentId)) {
    throw new Error('Managed signer service returned an invalid public identity.')
  }
  return {
    ...payload.managedSigner,
    signer: getAddress(payload.managedSigner.signer),
    agentId: payload.managedSigner.agentId.toLowerCase() as Hex,
  }
}

async function clients(wallet: BrowserWallet) {
  const runtime = await loadProtocolRuntime(true)
  await wallet.switchChain(runtime.chainId)
  const provider = await wallet.getEthereumProvider()
  const account = getAddress(wallet.address)
  const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(runtime.rpcUrl) })
  const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: custom(provider) })
  return { runtime, publicClient, walletClient, account }
}

async function mined(publicClient: ReturnType<typeof createPublicClient>, hash: Hash): Promise<Hash> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
  return hash
}

export async function prepareLocalAgentVault(input: AgentVaultCreationInput): Promise<void> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.creatorEnabled || !runtime.creatorUrl) return
  const response = await fetch(`${runtime.creatorUrl}/agent-vaults/prepare`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  })
  const payload = await response.json() as { error?: string }
  if (!response.ok) throw new Error(payload.error || `Agent preparation returned HTTP ${response.status}`)
}

export async function registerAgent(wallet: BrowserWallet, input: AgentVaultCreationInput): Promise<Hash | null> {
  const { runtime, publicClient, walletClient, account } = await clients(wallet)
  if (!runtime.agentRegistry) throw new Error('AgentRegistry is not configured on this network.')
  try {
    const [sponsor, signer] = await Promise.all([
      publicClient.readContract({ address: runtime.agentRegistry, abi: registryAbi, functionName: 'sponsorOf', args: [input.agentId] }),
      publicClient.readContract({ address: runtime.agentRegistry, abi: registryAbi, functionName: 'signerOf', args: [input.agentId] }),
    ])
    if (sponsor.toLowerCase() !== account.toLowerCase() || signer.toLowerCase() !== input.signer.toLowerCase()) {
      throw new Error('This agent id is already registered with different ownership or signer.')
    }
    return null
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('This agent id')) throw error
  }
  const hash = await walletClient.writeContract({
    address: runtime.agentRegistry,
    abi: registryAbi,
    functionName: 'register',
    args: [input.agentId, input.signer, input.metadataUri],
    account,
    chain: robinhoodChain,
  })
  await mined(publicClient, hash)
  return hash
}

export async function deployLocalAgentVault(input: AgentVaultCreationInput): Promise<AgentVaultDeployment> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.creatorEnabled || !runtime.creatorUrl) {
    throw new Error('The local agent deploy operator is unavailable. Submit a gateway deployment job instead.')
  }
  const response = await fetch(`${runtime.creatorUrl}/agent-vaults`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, allowedAssets: input.policy.allowedAssets }),
  })
  const payload = await response.json() as AgentVaultDeployment & { error?: string }
  if (!response.ok) throw new Error(payload.error || `Agent deploy operator returned HTTP ${response.status}`)
  return payload
}

export async function finalizeAgentVault(
  wallet: BrowserWallet,
  deployment: AgentVaultDeployment,
): Promise<{ controllerHash: Hash; bindHash: Hash; approveHash: Hash; stakeHash: Hash }> {
  const { publicClient, walletClient, account } = await clients(wallet)
  const enabled = await publicClient.readContract({
    address: deployment.agentRegistry, abi: registryAbi, functionName: 'controllers', args: [deployment.agentId, deployment.controller],
  })
  let controllerHash = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hash
  if (!enabled) {
    controllerHash = await walletClient.writeContract({
      address: deployment.agentRegistry,
      abi: registryAbi,
      functionName: 'setController',
      args: [deployment.agentId, deployment.controller, true],
      account,
      chain: robinhoodChain,
    })
    await mined(publicClient, controllerHash)
  }
  const bound = await publicClient.readContract({ address: deployment.controller, abi: controllerAbi, functionName: 'FUND' })
  let bindHash = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hash
  if (bound.toLowerCase() !== deployment.fund.toLowerCase()) {
    if (bound !== '0x0000000000000000000000000000000000000000') throw new Error('Controller is already bound to another Fund.')
    bindHash = await walletClient.writeContract({
      address: deployment.controller,
      abi: controllerAbi,
      functionName: 'bindFund',
      args: [deployment.fund],
      account,
      chain: robinhoodChain,
    })
    await mined(publicClient, bindHash)
  }
  const stake = await addInitialProtection(wallet, deployment)
  return { controllerHash, bindHash, ...stake }
}

export async function submitAgentVaultJob(input: AgentVaultCreationInput, accessToken: string): Promise<{ id: string; state: string }> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('The Nuvem Agent Gateway is not configured.')
  const response = await fetch(new URL('/v1/agent-vaults', runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      agentId: input.agentId,
      signer: input.signer,
      displayName: input.displayName,
      strategySummary: input.strategySummary,
      metadataUri: input.metadataUri,
      runtimeKind: input.runtimeKind,
      policy: input.policy,
      economy: {
        name: input.name,
        symbol: input.symbol,
        initialStake: input.initialStake,
        perfFeeBps: input.perfFeeBps,
        feeMinBps: input.feeMinBps,
        feeMaxBps: input.feeMaxBps,
        managerEntryShareBps: input.managerEntryShareBps,
        kFactor: input.kFactor,
        periodDays: input.periodDays,
        cooldownHours: input.cooldownHours,
      },
    }),
  })
  const payload = await response.json() as { job?: { id: string; state: string }; error?: { message?: string } }
  if (!response.ok || !payload.job) throw new Error(payload.error?.message || `Gateway returned HTTP ${response.status}`)
  return payload.job
}

type WorldBackingResponse = {
  backing: {
    agentId: Hex
    sponsor: Address
    signer: Address
    backingHash: Hex
    agentBookBlock: string | number
    validUntil: number
    nonce: string | number
  }
  signature: Hex
  registry: Address
}

export async function getWorldRegistrationStatus(
  agentId: Hex,
  accessToken: string,
): Promise<WorldRegistrationStatus> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('World AgentBook registration is not configured.')
  const response = await fetch(new URL(`/v1/agents/${agentId}/world-registration`, runtime.agentGatewayUrl), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const payload = await response.json() as {
    registration?: WorldRegistrationStatus
    error?: { message?: string }
  }
  if (!response.ok || !payload.registration) {
    throw new Error(payload.error?.message || `World registration status returned HTTP ${response.status}`)
  }
  const registration = payload.registration
  if (
    registration.agentId.toLowerCase() !== agentId.toLowerCase()
    || !isAddress(registration.signer)
    || !isAddress(registration.contract)
    || registration.lookupNetwork !== 'eip155:480'
    || getAddress(registration.contract).toLowerCase() !== CANONICAL_AGENTBOOK.toLowerCase()
    || registration.appId !== AGENTBOOK_WORLD_APP_ID
    || registration.action !== AGENTBOOK_WORLD_ACTION
  ) throw new Error('World registration status is not bound to this AgentBook identity.')
  return { ...registration, signer: getAddress(registration.signer), contract: getAddress(registration.contract) }
}

export async function submitWorldRegistrationProof(
  agentId: Hex,
  proof: WorldRegistrationProof,
  accessToken: string,
): Promise<{ registered: boolean; txHash: Hex | null }> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('World AgentBook registration is not configured.')
  const response = await fetch(new URL(`/v1/agents/${agentId}/world-registration`, runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': `agentbook-${agentId}-${proof.nonce}`,
    },
    body: JSON.stringify(proof),
  })
  const payload = await response.json() as {
    registration?: { registered: boolean; txHash: Hex | null }
    error?: { message?: string }
  }
  if (!response.ok || !payload.registration) {
    throw new Error(payload.error?.message || `World AgentBook relay returned HTTP ${response.status}`)
  }
  return payload.registration
}

export async function waitForWorldRegistration(
  agentId: Hex,
  accessToken: string,
  timeoutMs = 90_000,
): Promise<WorldRegistrationStatus> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const registration = await getWorldRegistrationStatus(agentId, accessToken)
    if (registration.registered) return registration
    await new Promise((resolve) => window.setTimeout(resolve, 2_000))
  }
  throw new Error('AgentBook registration is still pending on World Chain. Retry Finish launch shortly.')
}

/** Submits a canonical AgentBook attestation without exposing any human identifier. */
export async function activateWorldBacking(
  wallet: BrowserWallet,
  input: Pick<AgentVaultCreationInput, 'agentId' | 'signer'>,
  accessToken: string,
): Promise<Hash> {
  const { runtime, publicClient, walletClient, account } = await clients(wallet)
  if (!runtime.agentGatewayUrl || !runtime.agentRegistry) throw new Error('World activation is not configured on this network.')
  const response = await fetch(new URL(`/v1/agents/${input.agentId}/world-backing`, runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: '{}',
  })
  const payload = await response.json() as WorldBackingResponse & { error?: { message?: string } }
  if (!response.ok || !payload.backing || !payload.signature) {
    throw new Error(payload.error?.message || `World backing returned HTTP ${response.status}`)
  }
  if (
    getAddress(payload.registry).toLowerCase() !== runtime.agentRegistry.toLowerCase()
    || payload.backing.agentId.toLowerCase() !== input.agentId.toLowerCase()
    || getAddress(payload.backing.sponsor).toLowerCase() !== account.toLowerCase()
    || getAddress(payload.backing.signer).toLowerCase() !== input.signer.toLowerCase()
    || payload.backing.validUntil <= Math.floor(Date.now() / 1_000)
  ) throw new Error('World backing is not bound to this agent, sponsor, signer and registry.')

  const hash = await walletClient.writeContract({
    address: runtime.agentRegistry,
    abi: registryAbi,
    functionName: 'activate',
    args: [{
      agentId: payload.backing.agentId,
      sponsor: getAddress(payload.backing.sponsor),
      signer: getAddress(payload.backing.signer),
      backingHash: payload.backing.backingHash,
      agentBookBlock: BigInt(payload.backing.agentBookBlock),
      validUntil: payload.backing.validUntil,
      nonce: BigInt(payload.backing.nonce),
    }, payload.signature],
    account,
    chain: robinhoodChain,
  })
  return mined(publicClient, hash)
}

export async function syncAgentProfile(
  agentId: Hex,
  accessToken: string,
  controller?: Address,
): Promise<AgentSyncResult> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('The Nuvem Agent Gateway is not configured.')
  const response = await fetch(new URL(`/v1/agents/${agentId}/sync`, runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(controller ? { controller } : {}),
  })
  const payload = await response.json() as AgentSyncResult & { error?: { code?: string; message?: string } }
  if (!response.ok) {
    throw new AgentGatewayRequestError(
      payload.error?.code || 'AGENT_SYNC_HTTP_ERROR',
      response.status,
      payload.error?.message || `Agent sync returned HTTP ${response.status}`,
    )
  }
  return payload
}

export type AgentSyncResult = {
  agent?: {
    agentId?: Hex
    signer?: Address
    status?: string
    worldBacked?: boolean
    worldBackedUntil?: string | null
    controller?: Address | null
    vault?: Address | null
    [key: string]: unknown
  }
  deploymentState?: string | null
  [key: string]: unknown
}

export type AgentVaultJobState =
  | 'requested'
  | 'preparing'
  | 'deploying_controller'
  | 'deploying_fund'
  | 'registering'
  | 'awaiting_sponsor_bind'
  | 'ready'
  | 'failed'
  | (string & {})

export type AgentVaultJobStatus = {
  id: string
  agentId: Hex
  state: AgentVaultJobState
  controller: Address | null
  fund: Address | null
  stakeEscrow: Address | null
  transactionHashes: Hex[]
  attempts: number
  errorCode: string | null
  requiredStake6: string
}

export function assertAgentVaultJobAgent(
  job: AgentVaultJobStatus,
  expectedAgentId: Hex,
): AgentVaultJobStatus {
  if (job.agentId.toLowerCase() !== expectedAgentId.toLowerCase()) {
    throw new Error('The deployment job belongs to a different agent.')
  }
  return job
}

function normalizeAgentVaultJob(value: unknown): AgentVaultJobStatus {
  if (!value || typeof value !== 'object') throw new Error('Gateway returned an invalid deployment job.')
  const job = value as Partial<AgentVaultJobStatus>
  if (
    !job.id
    || typeof job.id !== 'string'
    || typeof job.agentId !== 'string'
    || !/^0x[0-9a-fA-F]{64}$/.test(job.agentId)
    || !job.state
    || typeof job.state !== 'string'
  ) {
    throw new Error('Gateway returned a deployment job without a valid id, agent or state.')
  }
  return {
    id: job.id,
    agentId: job.agentId.toLowerCase() as Hex,
    state: job.state,
    controller: typeof job.controller === 'string' && isAddress(job.controller) ? getAddress(job.controller) : null,
    fund: typeof job.fund === 'string' && isAddress(job.fund) ? getAddress(job.fund) : null,
    stakeEscrow: typeof job.stakeEscrow === 'string' && isAddress(job.stakeEscrow) ? getAddress(job.stakeEscrow) : null,
    transactionHashes: Array.isArray(job.transactionHashes)
      ? job.transactionHashes.filter((hash): hash is Hex => typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash))
      : [],
    attempts: Number.isFinite(Number(job.attempts)) ? Number(job.attempts) : 0,
    errorCode: typeof job.errorCode === 'string' ? job.errorCode : null,
    requiredStake6: job.requiredStake6 == null ? '0' : String(job.requiredStake6),
  }
}

export async function getAgentVaultJob(jobId: string, accessToken: string): Promise<AgentVaultJobStatus> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('The Nuvem Agent Gateway is not configured.')
  const response = await fetch(new URL(`/v1/agent-vaults/${jobId}`, runtime.agentGatewayUrl), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const payload = await response.json() as {
    job?: unknown
    vaultJob?: unknown
    error?: { code?: string; message?: string }
  }
  const job = payload.job ?? payload.vaultJob
  if (!response.ok || !job) {
    throw new AgentGatewayRequestError(
      payload.error?.code || 'VAULT_JOB_HTTP_ERROR',
      response.status,
      payload.error?.message || `Deployment status returned HTTP ${response.status}`,
    )
  }
  return normalizeAgentVaultJob(job)
}

export async function processAgentVaultJob(
  jobId: string,
  accessToken: string,
  idempotencyKey: string = crypto.randomUUID(),
  signal?: AbortSignal,
): Promise<AgentVaultJobStatus> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('The Nuvem Agent Gateway is not configured.')
  const response = await fetch(new URL(`/v1/agent-vaults/${jobId}/process`, runtime.agentGatewayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: '{}',
    signal,
  })
  const payload = await response.json() as {
    job?: unknown
    vaultJob?: unknown
    error?: { code?: string; message?: string }
  }
  const job = payload.job ?? payload.vaultJob
  if (!response.ok || !job) {
    throw new AgentGatewayRequestError(
      payload.error?.code || 'VAULT_PROCESS_HTTP_ERROR',
      response.status,
      payload.error?.message || `Deployment processing returned HTTP ${response.status}`,
    )
  }
  return normalizeAgentVaultJob(job)
}

export async function getAgentVaultJobForAgent(agentId: Hex, accessToken: string): Promise<AgentVaultJobStatus> {
  const runtime = await loadProtocolRuntime(true)
  if (!runtime.agentGatewayUrl) throw new Error('The Nuvem Agent Gateway is not configured.')
  const response = await fetch(new URL(`/v1/agents/${agentId}/vault-job`, runtime.agentGatewayUrl), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const payload = await response.json() as {
    job?: unknown
    vaultJob?: unknown
    error?: { code?: string; message?: string }
  }
  const job = payload.job ?? payload.vaultJob
  if (!response.ok || !job) {
    throw new AgentGatewayRequestError(
      payload.error?.code || 'VAULT_JOB_HTTP_ERROR',
      response.status,
      payload.error?.message || `Deployment status returned HTTP ${response.status}`,
    )
  }
  return normalizeAgentVaultJob(job)
}

export async function deploymentFromAgentJob(agentId: Hex, job: AgentVaultJobStatus): Promise<AgentVaultDeployment> {
  assertAgentVaultJobAgent(job, agentId)
  const runtime = await loadProtocolRuntime(true)
  if (
    !job.controller
    || !job.fund
    || !job.stakeEscrow
    || !/^\d+$/.test(job.requiredStake6)
    || BigInt(job.requiredStake6) <= 0n
    || !runtime.agentRegistry
    || !runtime.uniswapApiAdapter
    || !runtime.uniswapApiAdapterId
    || !runtime.usdg
    || !runtime.fundRegistry
  ) {
    throw new Error('The deployment is not ready for sponsor binding or has an incomplete manifest.')
  }
  return {
    agentId,
    controller: job.controller,
    fund: job.fund,
    stakeEscrow: job.stakeEscrow,
    usdg: runtime.usdg,
    fundRegistry: runtime.fundRegistry,
    chainId: runtime.chainId,
    initialStake6: job.requiredStake6,
    agentRegistry: runtime.agentRegistry,
    uniswapApiAdapter: runtime.uniswapApiAdapter,
    uniswapApiAdapterId: runtime.uniswapApiAdapterId,
    worldBacking: { mode: 'world-agentbook', canonical: true, active: true },
  }
}

export async function waitForAgentVaultDeployment(
  jobId: string,
  input: AgentVaultCreationInput | Hex,
  accessToken: string,
  options: AgentVaultPollOptions | number = {},
): Promise<AgentVaultDeployment> {
  const agentId = typeof input === 'string' ? input : input.agentId
  const normalized = typeof options === 'number' ? { timeoutMs: options } : options
  const job = await pollAgentVaultJob(
    () => getAgentVaultJob(jobId, accessToken),
    {
      ...normalized,
      advance: normalized.advance ?? (() => (
        processAgentVaultJob(jobId, accessToken, crypto.randomUUID(), normalized.signal)
      )),
    },
  )
  return deploymentFromAgentJob(agentId, job)
}

export async function waitForAgentVaultByAgent(
  agentId: Hex,
  accessToken: string,
  options: AgentVaultPollOptions | number = {},
): Promise<AgentVaultDeployment> {
  const normalized = typeof options === 'number' ? { timeoutMs: options } : options
  const job = await pollAgentVaultJob(
    () => getAgentVaultJobForAgent(agentId, accessToken),
    {
      ...normalized,
      advance: normalized.advance ?? ((current) => (
        processAgentVaultJob(current.id, accessToken, crypto.randomUUID(), normalized.signal)
      )),
    },
  )
  return deploymentFromAgentJob(agentId, job)
}

export type AgentVaultPollOptions = {
  timeoutMs?: number
  intervalMs?: number
  signal?: AbortSignal
  onStatus?: (job: AgentVaultJobStatus) => void
  advance?: (job: AgentVaultJobStatus) => Promise<AgentVaultJobStatus | void>
}

export class AgentVaultPollingCancelled extends Error {
  constructor() {
    super('Vault deployment polling was paused.')
    this.name = 'AgentVaultPollingCancelled'
  }
}

function pollingDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AgentVaultPollingCancelled())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      reject(new AgentVaultPollingCancelled())
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function pollAgentVaultJob(
  readStatus: () => Promise<AgentVaultJobStatus>,
  options: AgentVaultPollOptions = {},
): Promise<AgentVaultJobStatus> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000
  const intervalMs = options.intervalMs ?? 2_500
  const started = Date.now()
  let lastTemporaryError: Error | null = null
  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) throw new AgentVaultPollingCancelled()
    try {
      const job = await readStatus()
      if (options.signal?.aborted) throw new AgentVaultPollingCancelled()
      lastTemporaryError = null
      options.onStatus?.(job)
      if (job.state === 'failed') {
        throw new Error(`Vault deployment failed: ${job.errorCode || 'unknown error'}`)
      }
      if (job.state === 'awaiting_sponsor_bind' || job.state === 'ready') return job
      await options.advance?.(job)
    } catch (error) {
      if (error instanceof AgentVaultPollingCancelled) throw error
      if (
        error instanceof AgentGatewayRequestError
        && error.code === 'VAULT_WORKER_NOT_CONFIGURED'
      ) throw error
      if (
        error instanceof AgentGatewayRequestError
        && error.status >= 400
        && error.status < 500
        && error.status !== 425
        && error.status !== 429
        && !(
          error.status === 409
          && ['VAULT_WORKER_BUSY', 'IDEMPOTENCY_IN_PROGRESS'].includes(error.code)
        )
      ) throw error
      if (error instanceof Error && error.message.startsWith('Vault deployment failed:')) throw error
      lastTemporaryError = error instanceof Error ? error : new Error('Deployment status is temporarily unavailable.')
    }
    await pollingDelay(intervalMs, options.signal)
  }
  if (lastTemporaryError) {
    throw new Error(`The deployment is still queued and its last status check failed: ${lastTemporaryError.message}`)
  }
  throw new Error('The deployment is still queued. Close this window safely and resume it later.')
}

export async function rotateAgentSigner(wallet: BrowserWallet, agentId: Hex, nextSigner: Address): Promise<Hash> {
  const { runtime, publicClient, walletClient, account } = await clients(wallet)
  if (!runtime.agentRegistry) throw new Error('AgentRegistry is not configured.')
  const hash = await walletClient.writeContract({
    address: runtime.agentRegistry, abi: registryAbi, functionName: 'rotateSigner', args: [agentId, nextSigner], account, chain: robinhoodChain,
  })
  return mined(publicClient, hash)
}

export async function pauseAgent(
  wallet: BrowserWallet,
  agentId: Hex,
  controller?: Address | null,
): Promise<Hash[]> {
  const { runtime, publicClient, walletClient, account } = await clients(wallet)
  if (!runtime.agentRegistry) throw new Error('AgentRegistry is not configured.')
  const hashes: Hash[] = []
  const registryHash = await walletClient.writeContract({
    address: runtime.agentRegistry, abi: registryAbi, functionName: 'pause', args: [agentId], account, chain: robinhoodChain,
  })
  hashes.push(await mined(publicClient, registryHash))
  if (controller) {
    const controllerHash = await walletClient.writeContract({
      address: controller, abi: controllerAbi, functionName: 'setPaused', args: [true], account, chain: robinhoodChain,
    })
    hashes.push(await mined(publicClient, controllerHash))
  }
  return hashes
}

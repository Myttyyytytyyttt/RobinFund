import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { toDataURL } from 'qrcode'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import {
  activateWorldBacking,
  AgentGatewayRequestError,
  AgentVaultPollingCancelled,
  assertAgentVaultJobAgent,
  createNuvemIdentityCheckRequest,
  createAgentId,
  deploymentFromAgentJob,
  deployLocalAgentVault,
  finalizeAgentVault,
  getAgentVaultJob,
  getWorldRegistrationStatus,
  prepareLocalAgentVault,
  provisionManagedSigner,
  registerAgent,
  submitNuvemIdentityCheckProof,
  submitWorldRegistrationProof,
  submitAgentVaultJob,
  syncAgentProfile,
  waitForAgentVaultDeployment,
  waitForWorldRegistration,
  type AgentVaultCreationInput,
  type AgentVaultDeployment,
  type AgentVaultJobStatus,
  type ManagedSignerIdentity,
} from '@/lib/agentTransactions'
import {
  advanceAgentVaultRecovery,
  clearAgentVaultRecovery,
  loadAgentVaultRecovery,
  saveAgentVaultRecovery,
  stageAfterWorldIdentity,
  type AgentVaultRecovery,
  type AgentVaultRecoveryStage,
} from '@/lib/agentVaultRecovery'
import { loadProtocolRuntime } from '@/lib/protocolRuntime'
import { requestAgentBookProof } from '@/lib/worldAgentBook'
import {
  configuredIdentityEnvironment,
  requestIdentityCheckProof,
  type WorldIdentityEnvironment,
} from '@/lib/worldIdentityCheck'
import {
  currentSupabaseAccessToken,
  ensureSupabaseWalletSession,
  type EthereumProvider,
} from '@/lib/supabase'
import {
  addInitialProtection,
  deployVault,
  type BrowserWallet,
  type VaultCreationInput,
  type VaultDeployment,
} from '@/lib/vaultTransactions'

type Props = { open: boolean; onClose: () => void; onCreated: (address: Address) => void }
type ManagerType = 'human' | 'ai'
type RuntimeKind = 'external' | 'nuvem_reference'
type Status = 'idle' | 'provisioning' | 'preparing' | 'registering' | 'world_identity' | 'world_agentbook' | 'backing' | 'deploying' | 'binding' | 'approving' | 'queued' | 'success'
type PendingIdentityProof = {
  agentId: Hex
  requestId: string
  proof: unknown
  idempotencyKey: string
  environment: WorldIdentityEnvironment
}

type FormState = {
  name: string
  symbol: string
  initialStake: string
  performanceFee: string
  entryFeeMin: string
  entryFeeMax: string
  managerEntryShare: string
  kFactor: string
  periodDays: string
  cooldownHours: string
  agentName: string
  strategySummary: string
  agentSigner: string
  metadataUri: string
  maxTrade: string
  maxConcentration: string
  dailyTurnover: string
  maxSlippage: string
  maxTradesPerDay: string
  minTradeInterval: string
  maxIntentLifetime: string
}

const INITIAL: FormState = {
  name: '', symbol: '', initialStake: '2000', performanceFee: '20', entryFeeMin: '0', entryFeeMax: '2',
  managerEntryShare: '50', kFactor: '25', periodDays: '30', cooldownHours: '24',
  agentName: '', strategySummary: '', agentSigner: '', metadataUri: '', maxTrade: '10',
  maxConcentration: '35', dailyTurnover: '50', maxSlippage: '0.75', maxTradesPerDay: '24',
  minTradeInterval: '5', maxIntentLifetime: '5',
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`
const bps = (value: string) => Math.round(Number(value) * 100)
const percent = (value: number) => String(value / 100)
const PROVISIONING_KEY_STORAGE = 'nuvem:agent-provisioning-key:v1'

function initialProvisioningKey(): string {
  try {
    const stored = window.sessionStorage.getItem(PROVISIONING_KEY_STORAGE)
    if (stored) return stored
    const created = crypto.randomUUID()
    window.sessionStorage.setItem(PROVISIONING_KEY_STORAGE, created)
    return created
  } catch {
    return crypto.randomUUID()
  }
}

function formFromRecovery(input: AgentVaultCreationInput): FormState {
  return {
    name: input.name,
    symbol: input.symbol,
    initialStake: input.initialStake,
    performanceFee: percent(input.perfFeeBps),
    entryFeeMin: percent(input.feeMinBps),
    entryFeeMax: percent(input.feeMaxBps),
    managerEntryShare: percent(input.managerEntryShareBps),
    kFactor: String(input.kFactor),
    periodDays: String(input.periodDays),
    cooldownHours: String(input.cooldownHours),
    agentName: input.displayName,
    strategySummary: input.strategySummary,
    agentSigner: input.signer,
    metadataUri: input.metadataUri,
    maxTrade: percent(input.policy.maxTradeBps),
    maxConcentration: percent(input.policy.maxConcentrationBps),
    dailyTurnover: percent(input.policy.dailyTurnoverBps),
    maxSlippage: percent(input.policy.maxSlippageBps),
    maxTradesPerDay: String(input.policy.maxTradesPerDay),
    minTradeInterval: String(input.policy.minTradeInterval / 60),
    maxIntentLifetime: String(input.policy.maxIntentLifetime / 60),
  }
}

function Field({ label, hint, value, onChange, suffix, min, max, step, placeholder }: {
  label: string; hint?: string; value: string; onChange: (value: string) => void; suffix?: string
  min?: number; max?: number; step?: number; placeholder?: string
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.16em] text-white/45">
        {label}{hint && <span className="normal-case tracking-normal text-white/28">{hint}</span>}
      </span>
      <span className="flex items-center rounded-xl border border-white/12 bg-black/25 px-4 transition-colors focus-within:border-emerald-200/40">
        <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} min={min} max={max} step={step}
          type={min === undefined && max === undefined ? 'text' : 'number'}
          className="min-w-0 flex-1 bg-transparent py-3 text-sm text-white outline-none placeholder:text-white/20" />
        {suffix && <span className="ml-2 shrink-0 text-xs text-white/35">{suffix}</span>}
      </span>
    </label>
  )
}

function Choice({ active, title, text, onClick, disabled = false }: {
  active: boolean
  title: string
  text: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`cursor-pointer rounded-2xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${active ? 'border-emerald-200/40 bg-emerald-200/10' : 'border-white/10 bg-black/20 hover:bg-white/5'}`}>
      <div className="flex items-center gap-2 text-sm font-medium"><span className={`h-2 w-2 rounded-full ${active ? 'bg-emerald-300' : 'bg-white/20'}`} />{title}</div>
      <p className="mt-2 text-[11px] leading-4 text-white/42">{text}</p>
    </button>
  )
}

export function VaultCreatorModal({ open, onClose, onCreated }: Props) {
  const { authenticated, user } = usePrivy()
  const { wallets } = useWallets()
  const [managerType, setManagerType] = useState<ManagerType>('human')
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind>('external')
  const [form, setForm] = useState<FormState>(INITIAL)
  const [advanced, setAdvanced] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [humanDeployment, setHumanDeployment] = useState<VaultDeployment | null>(null)
  const [agentDeployment, setAgentDeployment] = useState<AgentVaultDeployment | null>(null)
  const [agentId, setAgentId] = useState<Hex | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [managedIdentity, setManagedIdentity] = useState<ManagedSignerIdentity | null>(null)
  const [provisioningKey, setProvisioningKey] = useState(initialProvisioningKey)
  const [worldConnectorUri, setWorldConnectorUri] = useState<string | null>(null)
  const [worldQr, setWorldQr] = useState<string | null>(null)
  const [worldCommand, setWorldCommand] = useState<string | null>(null)
  const [worldProofReady, setWorldProofReady] = useState(false)
  const [recovery, setRecovery] = useState<AgentVaultRecovery | null>(null)
  const [jobStatus, setJobStatus] = useState<AgentVaultJobStatus | null>(null)
  const [polling, setPolling] = useState(false)
  const pendingWorldProof = useRef<PendingIdentityProof | null>(null)
  const pollingAbort = useRef<AbortController | null>(null)

  const loginAddress = user?.wallet?.address
  const activeExternal = wallets.find((wallet) => wallet.walletClientType !== 'privy')
  const signer = wallets.find((wallet) => wallet.address.toLowerCase() === loginAddress?.toLowerCase())
  const walletMismatch = Boolean(authenticated && loginAddress && activeExternal && activeExternal.address.toLowerCase() !== loginAddress.toLowerCase())
  const update = (key: keyof FormState) => (value: string) => setForm((current) => ({ ...current, [key]: value }))
  const cap = useMemo(() => Number(form.initialStake || 0) * Number(form.kFactor || 0), [form.initialStake, form.kFactor])
  const busy = !['idle', 'queued', 'success'].includes(status)
  const actionDisabled = busy || polling
  const closeCreator = useCallback(() => {
    pollingAbort.current?.abort()
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && !busy && closeCreator()
    window.addEventListener('keydown', escape)
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', escape) }
  }, [busy, closeCreator, open])

  useEffect(() => {
    if (open) return
    pollingAbort.current?.abort()
    pollingAbort.current = null
    setPolling(false)
    if (!recovery) {
      const nextKey = crypto.randomUUID()
      try { window.sessionStorage.setItem(PROVISIONING_KEY_STORAGE, nextKey) } catch { /* storage is optional */ }
      setProvisioningKey(nextKey)
    }
    setStatus('idle')
    setError(null)
    setHumanDeployment(null)
    setAgentDeployment(null)
    setAgentId(null)
    setManagedIdentity(null)
    setJobId(null)
    setWorldConnectorUri(null)
    setWorldQr(null)
    setWorldCommand(null)
    pendingWorldProof.current = null
    setWorldProofReady(false)
    setRecovery(null)
    setJobStatus(null)
  }, [open, recovery])

  useEffect(() => {
    if (!open || !loginAddress || !isAddress(loginAddress) || recovery) return
    const restored = loadAgentVaultRecovery(getAddress(loginAddress))
    if (!restored) return
    setManagerType('ai')
    setRuntimeKind(restored.input.runtimeKind)
    setForm(formFromRecovery(restored.input))
    setAgentId(restored.agentId)
    setJobId(restored.jobId)
    setRecovery(restored)
    setStatus('queued')
    try {
      if (restored.identityEnvironment !== configuredIdentityEnvironment()) {
        setError(`This launch belongs to World ${restored.identityEnvironment}, but this build is configured for ${configuredIdentityEnvironment()}. Open the matching frontend environment to resume it.`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'World Identity Check environment is invalid.')
    }
  }, [loginAddress, open, recovery])

  useEffect(() => {
    let live = true
    if (!worldConnectorUri) {
      setWorldQr(null)
      return () => { live = false }
    }
    void toDataURL(worldConnectorUri, {
      width: 280,
      margin: 1,
      color: { dark: '#071012', light: '#ffffff' },
    }).then((data) => { if (live) setWorldQr(data) })
    return () => { live = false }
  }, [worldConnectorUri])

  useEffect(() => () => pollingAbort.current?.abort(), [])

  if (!open) return null

  const commonInput = (): VaultCreationInput => {
    if (!loginAddress || !signer) throw new Error('Connect the wallet used to sign in before creating a vault.')
    if (walletMismatch) throw new Error('Your extension changed accounts. Reconnect from the navbar first.')
    const input: VaultCreationInput = {
      manager: getAddress(loginAddress), name: form.name.trim(), symbol: form.symbol.trim().toUpperCase(), initialStake: form.initialStake,
      perfFeeBps: bps(form.performanceFee), feeMinBps: bps(form.entryFeeMin), feeMaxBps: bps(form.entryFeeMax),
      managerEntryShareBps: bps(form.managerEntryShare), kFactor: Number(form.kFactor), periodDays: Number(form.periodDays), cooldownHours: Number(form.cooldownHours),
    }
    if (input.name.length < 3 || input.name.length > 48) throw new Error('Name must contain 3–48 characters.')
    if (!/^[A-Z0-9]{2,8}$/.test(input.symbol)) throw new Error('Symbol must contain 2–8 letters or numbers.')
    if (Number(input.initialStake) < 2_000) throw new Error('Initial loss protection starts at 2,000 USDG.')
    if (input.feeMinBps > input.feeMaxBps) throw new Error('Minimum entry fee cannot exceed the maximum.')
    return input
  }

  const agentInput = async (managed?: ManagedSignerIdentity): Promise<AgentVaultCreationInput> => {
    const common = commonInput()
    const runtime = await loadProtocolRuntime(true)
    const rawSigner = runtimeKind === 'nuvem_reference' ? managed?.signer : form.agentSigner.trim()
    if (!rawSigner || !isAddress(rawSigner)) {
      throw new Error(runtimeKind === 'nuvem_reference'
        ? 'Nuvem could not provision the isolated reference-agent signer.'
        : 'Enter the public address of the agent signer. Its private key stays on the agent machine.')
    }
    const agentSigner = getAddress(rawSigner)
    if (agentSigner.toLowerCase() === common.manager.toLowerCase()) throw new Error('Use a separate signer for the agent runtime.')
    if (!runtime.agentAssets.length) throw new Error('No agent-tradable assets are configured on this network.')
    const nextId = managed?.agentId ?? agentId ?? createAgentId(common.manager, agentSigner)
    if (agentId?.toLowerCase() !== nextId.toLowerCase()) setAgentId(nextId)
    return {
      ...common,
      agentId: nextId,
      signer: agentSigner,
      displayName: form.agentName.trim() || `${common.name} Agent`,
      strategySummary: form.strategySummary.trim(),
      metadataUri: form.metadataUri.trim(),
      runtimeKind,
      policy: {
        maxTradeBps: bps(form.maxTrade), maxConcentrationBps: bps(form.maxConcentration), dailyTurnoverBps: bps(form.dailyTurnover),
        maxSlippageBps: bps(form.maxSlippage), maxTradesPerDay: Number(form.maxTradesPerDay), minTradeInterval: Number(form.minTradeInterval) * 60,
        maxIntentLifetime: Number(form.maxIntentLifetime) * 60, allowedAssets: runtime.agentAssets,
      },
    }
  }

  const finishAgent = async (
    deployment: AgentVaultDeployment,
    afterFinalize?: () => Promise<void>,
    completedRecovery: AgentVaultRecovery | null = recovery,
  ) => {
    if (!signer) throw new Error('Sponsor wallet is unavailable.')
    setStatus('binding')
    await finalizeAgentVault(signer as BrowserWallet, deployment)
    await afterFinalize?.()
    if (completedRecovery) clearAgentVaultRecovery(completedRecovery.sponsor)
    setRecovery(null)
    setJobStatus(null)
    setStatus('success')
    onCreated(deployment.fund)
  }

  const sponsorAccessToken = async (): Promise<string> => {
    if (!signer) throw new Error('Sponsor wallet is unavailable.')
    const provider = await signer.getEthereumProvider()
    const supabaseWallet = {
      address: signer.address,
      request: provider.request.bind(provider),
      on: provider.on.bind(provider),
      removeListener: provider.removeListener.bind(provider),
    } as EthereumProvider
    await ensureSupabaseWalletSession(signer.address, supabaseWallet)
    const token = await currentSupabaseAccessToken()
    if (!token) throw new Error('Could not create the sponsor SIWE session.')
    return token
  }

  const clearPendingNuvemWorldProof = () => {
    pendingWorldProof.current = null
    setWorldProofReady(false)
  }

  const verifyNuvemIdentity = async (
    input: AgentVaultCreationInput,
    token: string,
    environment: WorldIdentityEnvironment,
  ): Promise<void> => {
    let pending = pendingWorldProof.current
    if (
      pending
      && (
        pending.agentId.toLowerCase() !== input.agentId.toLowerCase()
        || pending.environment !== environment
      )
    ) {
      clearPendingNuvemWorldProof()
      pending = null
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!pending) {
        const identity = await createNuvemIdentityCheckRequest(input.agentId, token, environment)
        if (identity.verified) {
          clearPendingNuvemWorldProof()
          return
        }
        const proof = await requestIdentityCheckProof(identity, setWorldConnectorUri, {
          expectedEnvironment: environment,
        })
        pending = {
          agentId: input.agentId,
          requestId: identity.requestId,
          proof,
          idempotencyKey: crypto.randomUUID(),
          environment,
        }
        pendingWorldProof.current = pending
        setWorldProofReady(true)
      }

      try {
        await submitNuvemIdentityCheckProof(
          pending.agentId,
          pending.requestId,
          pending.proof,
          token,
          pending.idempotencyKey,
        )
        clearPendingNuvemWorldProof()
        return
      } catch (caught) {
        if (caught instanceof AgentGatewayRequestError && caught.code === 'WORLD_IDENTITY_REQUEST_INVALID') {
          clearPendingNuvemWorldProof()
          pending = null
          continue
        }
        if (
          caught instanceof AgentGatewayRequestError
          && [
            'WORLD_IDENTITY_PROOF_INVALID',
            'WORLD_IDENTITY_PROOF_MISMATCH',
            'WORLD_IDENTITY_REJECTED',
            'WORLD_IDENTITY_BINDING_CONFLICT',
            'WORLD_IDENTITY_REPLAY',
          ].includes(caught.code)
        ) {
          clearPendingNuvemWorldProof()
        } else if (caught instanceof AgentGatewayRequestError && caught.status >= 500) {
          pending = { ...pending, idempotencyKey: crypto.randomUUID() }
          pendingWorldProof.current = pending
        }
        throw caught
      }
    }
    throw new Error('The previous World Identity Check expired. Retry once to generate a fresh QR.')
  }

  const advanceRecovery = (
    current: AgentVaultRecovery,
    stage: AgentVaultRecoveryStage,
  ): AgentVaultRecovery => {
    const next = advanceAgentVaultRecovery(current, stage)
    setRecovery(next)
    return next
  }

  const continueAgentLaunch = async (
    stored: AgentVaultRecovery,
    token: string,
  ): Promise<void> => {
    if (!signer || getAddress(signer.address).toLowerCase() !== stored.sponsor.toLowerCase()) {
      throw new Error('Reconnect the sponsor wallet that created this pending AI vault.')
    }
    const configuredEnvironment = configuredIdentityEnvironment()
    if (configuredEnvironment !== stored.identityEnvironment) {
      throw new Error(`This launch uses World ${stored.identityEnvironment}; this frontend uses ${configuredEnvironment}. Resume it from the matching environment.`)
    }

    let current = stored
    if (current.stage === 'registering' || !current.jobId) {
      setStatus('preparing')
      await prepareLocalAgentVault(current.input)
      setStatus('registering')
      await registerAgent(signer as BrowserWallet, current.input)
      const job = await submitAgentVaultJob(current.input, token)
      current = saveAgentVaultRecovery({
        ...current,
        jobId: job.id,
        stage: 'identity_check',
      })
      setRecovery(current)
      setJobId(job.id)
    }

    const activeJobId = current.jobId
    if (!activeJobId) throw new Error('The pending launch has not received a deployment job yet.')
    const firstJob = await getAgentVaultJob(activeJobId, token)
    setJobStatus(firstJob)
    assertAgentVaultJobAgent(firstJob, current.agentId)
    if (firstJob.state === 'failed') {
      throw new Error(`Vault deployment failed: ${firstJob.errorCode || 'unknown worker error'}. Start a new launch after the operator issue is fixed.`)
    }

    let deployed: AgentVaultDeployment
    if (firstJob.state === 'awaiting_sponsor_bind' || firstJob.state === 'ready') {
      deployed = await deploymentFromAgentJob(current.agentId, firstJob)
    } else {
      if (current.stage === 'identity_check') {
        setStatus('world_identity')
        await verifyNuvemIdentity(current.input, token, current.identityEnvironment)
        setWorldConnectorUri(null)
        setWorldQr(null)
        current = advanceRecovery(current, stageAfterWorldIdentity(current.identityEnvironment))
      }

      if (current.stage === 'agentbook' && current.identityEnvironment === 'staging') {
        current = advanceRecovery(current, 'backing')
      }

      if (current.stage === 'agentbook') {
        setStatus('world_agentbook')
        let registration = await getWorldRegistrationStatus(current.agentId, token)
        setWorldCommand(registration.command)
        if (!registration.registered) {
          if (!registration.nextNonce) throw new Error('AgentBook did not return the next registration nonce.')
          const proof = await requestAgentBookProof({
            signer: registration.signer,
            appId: registration.appId,
            action: registration.action,
            nextNonce: registration.nextNonce,
          }, setWorldConnectorUri)
          await submitWorldRegistrationProof(current.agentId, proof, token)
          registration = await waitForWorldRegistration(current.agentId, token)
        }
        if (!registration.registered) throw new Error('World AgentBook registration was not confirmed.')
        setWorldConnectorUri(null)
        setWorldQr(null)
        current = advanceRecovery(current, 'backing')
      }

      if (current.stage === 'backing') {
        setStatus('backing')
        const beforeActivation = await syncAgentProfile(current.agentId, token)
        const alreadyActive = beforeActivation.agent?.worldBacked === true
          || beforeActivation.agent?.status === 'active'
        if (!alreadyActive) {
          await activateWorldBacking(signer as BrowserWallet, current.input, token)
          await syncAgentProfile(current.agentId, token)
        }
        current = advanceRecovery(current, 'deploying')
      }

      setStatus('queued')
      const controller = new AbortController()
      pollingAbort.current?.abort()
      pollingAbort.current = controller
      setPolling(true)
      try {
        deployed = await waitForAgentVaultDeployment(activeJobId, current.agentId, token, {
          signal: controller.signal,
          onStatus: setJobStatus,
        })
      } finally {
        if (pollingAbort.current === controller) pollingAbort.current = null
        setPolling(false)
      }
    }

    setAgentDeployment(deployed)
    current = advanceRecovery(current, 'binding')
    await finishAgent(
      deployed,
      () => syncAgentProfile(current.agentId, token, deployed.controller).then(() => undefined),
      current,
    )
  }

  const submit = async () => {
    setError(null)
    setWorldConnectorUri(null)
    setWorldQr(null)
    try {
      if (managerType === 'human') {
        if (humanDeployment) {
          if (!signer) throw new Error('Manager wallet is unavailable.')
          setStatus('approving')
          await addInitialProtection(signer as BrowserWallet, humanDeployment)
          setStatus('success')
          return onCreated(humanDeployment.fund)
        }
        setStatus('deploying')
        const deployed = await deployVault(commonInput())
        setHumanDeployment(deployed)
        if (!signer) throw new Error('Manager wallet is unavailable.')
        setStatus('approving')
        await addInitialProtection(signer as BrowserWallet, deployed)
        setStatus('success')
        return onCreated(deployed.fund)
      }

      if (!signer) throw new Error('Sponsor wallet is unavailable.')
      const runtime = await loadProtocolRuntime(true)
      let token: string | null = null
      if (!runtime.creatorEnabled) token = await sponsorAccessToken()
      const identityEnvironment = runtime.creatorEnabled ? null : configuredIdentityEnvironment()

      if (recovery) {
        if (runtime.creatorEnabled) throw new Error('A network deployment cannot be resumed through the local devnet creator.')
        if (!token) token = await sponsorAccessToken()
        await continueAgentLaunch(recovery, token)
        return
      }

      if (agentDeployment) return await finishAgent(agentDeployment)
      let managed: ManagedSignerIdentity | undefined
      if (runtimeKind === 'nuvem_reference') {
        setStatus('provisioning')
        managed = await provisionManagedSigner(getAddress(signer.address), provisioningKey, token ?? undefined)
        setManagedIdentity(managed)
        setAgentId(managed.agentId)
      }
      const input = await agentInput(managed)

      if (runtime.creatorEnabled) {
        setStatus('preparing')
        await prepareLocalAgentVault(input)
        setStatus('registering')
        await registerAgent(signer as BrowserWallet, input)
        setStatus('deploying')
        const deployed = await deployLocalAgentVault(input)
        setAgentDeployment(deployed)
        return await finishAgent(deployed)
      }

      if (!token) token = await sponsorAccessToken()
      const stored = saveAgentVaultRecovery({
        sponsor: getAddress(signer.address),
        agentId: input.agentId,
        jobId: null,
        input,
        identityEnvironment: identityEnvironment ?? 'production',
        stage: 'registering',
      })
      setRecovery(stored)
      await continueAgentLaunch(stored, token)
    } catch (caught) {
      if (caught instanceof AgentVaultPollingCancelled) {
        setStatus('queued')
        return
      }
      const pending = signer && isAddress(signer.address)
        ? loadAgentVaultRecovery(getAddress(signer.address))
        : null
      setRecovery(pending)
      setStatus(pending ? 'queued' : 'idle')
      setWorldConnectorUri(null)
      setWorldQr(null)
      setError(caught instanceof Error ? caught.message : 'Vault creation failed.')
    }
  }

  const discardRecovery = () => {
    if (!recovery) return
    pollingAbort.current?.abort()
    clearAgentVaultRecovery(recovery.sponsor)
    setRecovery(null)
    setJobStatus(null)
    setJobId(null)
    setAgentId(null)
    setAgentDeployment(null)
    setError(null)
    setStatus('idle')
    const nextKey = crypto.randomUUID()
    try { window.sessionStorage.setItem(PROVISIONING_KEY_STORAGE, nextKey) } catch { /* storage is optional */ }
    setProvisioningKey(nextKey)
  }

  const activeIdentityEnvironment = recovery?.identityEnvironment ?? configuredIdentityEnvironment()
  const steps = managerType === 'human'
    ? [['Deploy', ['deploying'].includes(status)], ['Stake', status === 'approving'], ['Live', status === 'success']]
    : activeIdentityEnvironment === 'staging'
      ? [['Agent identity', status === 'provisioning'], ['Register', status === 'registering'], ['Identity Check', status === 'world_identity'], ['Staging backing', status === 'backing'], ['Deploy', status === 'deploying' || status === 'queued'], ['Bind + stake', status === 'binding'], ['Active', status === 'success']]
      : [['Agent identity', status === 'provisioning'], ['Register', status === 'registering'], ['Identity Check', status === 'world_identity'], ['AgentBook', status === 'world_agentbook'], ['World backing', status === 'backing'], ['Deploy', status === 'deploying' || status === 'queued'], ['Bind + stake', status === 'binding'], ['Active', status === 'success']]

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[#020709]/80 px-3 py-4 backdrop-blur-xl sm:px-6 sm:py-8" role="dialog" aria-modal="true" aria-labelledby="vault-creator-title" onMouseDown={(event) => event.currentTarget === event.target && !busy && closeCreator()}>
      <div className="relative mx-auto w-full max-w-5xl overflow-hidden rounded-[28px] border border-white/15 bg-[#071012]/95 text-white shadow-[0_28px_100px_rgba(0,0,0,0.65)]">
        <div className="pointer-events-none absolute inset-0" aria-hidden><img src="/vaultbg.webp" alt="" className="h-full w-full scale-110 object-cover opacity-35 blur-[32px]" /><div className="absolute inset-0 bg-black/72" /></div>
        <div className="relative z-10">
          <header className="flex items-start justify-between gap-5 border-b border-white/10 px-5 py-5 sm:px-8 sm:py-6">
            <div><div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-emerald-200/65"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />Unified launch desk</div>
              <h2 id="vault-creator-title" className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Create a Nuvem vault</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">Choose who makes allocation decisions. The sponsor always owns the stake, fees, pause and recovery controls.</p></div>
            <button type="button" disabled={busy} onClick={closeCreator} aria-label="Close creator" className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/20 text-xl text-white/60 hover:bg-white/10 disabled:opacity-30">×</button>
          </header>

          <div className="grid md:grid-cols-[1fr_285px]">
            <form className="space-y-5 border-b border-white/10 p-5 sm:p-8 md:border-b-0 md:border-r" onSubmit={(event) => { event.preventDefault(); void submit() }}>
              <div className="grid grid-cols-2 gap-3">
                <Choice disabled={actionDisabled || Boolean(recovery)} active={managerType === 'human'} title="Human manager" text="Your connected wallet controls approved Fund trades." onClick={() => { setManagerType('human'); setError(null) }} />
                <Choice disabled={actionDisabled || Boolean(recovery)} active={managerType === 'ai'} title="AI manager" text="A policy-limited controller verifies every signed agent intent." onClick={() => { setManagerType('ai'); setError(null) }} />
              </div>

              {error && <div role="alert" aria-live="assertive" className="rounded-xl border border-red-300/20 bg-red-300/10 px-4 py-3 text-xs leading-5 text-red-100">{error}<div className="mt-1 text-white/40">{worldProofReady ? 'World App already approved. Retry resubmits the proof held only in this tab; no new QR is needed.' : recovery ? 'Retry resumes this exact job; it does not register or deploy a second agent.' : 'Retry resumes completed onchain steps and creates a fresh QR only when needed.'}</div></div>}

              <div className="grid gap-4 sm:grid-cols-[1fr_150px]"><Field label="Vault name" value={form.name} onChange={update('name')} /><Field label="Symbol" hint="2–8 chars" value={form.symbol} onChange={(value) => update('symbol')(value.toUpperCase())} /></div>
              <Field label="Initial loss protection" hint="Sponsor capital" value={form.initialStake} onChange={update('initialStake')} suffix="USDG" min={2000} step={100} />
              <div className="grid gap-4 sm:grid-cols-2"><Field label="Performance fee" value={form.performanceFee} onChange={update('performanceFee')} suffix="%" min={0} max={30} step={0.1} /><Field label="Maximum entry fee" value={form.entryFeeMax} onChange={update('entryFeeMax')} suffix="%" min={0} max={5} step={0.1} /></div>

              {managerType === 'ai' && (
                <div className="space-y-4 rounded-2xl border border-emerald-200/15 bg-emerald-200/[0.045] p-4 sm:p-5">
                  <div><div className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/65">Agent runtime</div><p className="mt-1 text-xs leading-5 text-white/45">{runtimeKind === 'external' ? 'Your signer stays on your PC or VPS and only its public address reaches Nuvem.' : 'Nuvem provisions an isolated signer for this vault. No wallet setup, seed phrase or private key is shown in the browser.'}</p></div>
                  <div className="grid grid-cols-2 gap-3"><Choice disabled={actionDisabled || Boolean(recovery)} active={runtimeKind === 'external'} title="External agent" text="Run any model from your PC, VPS or cloud via the SDK." onClick={() => { setRuntimeKind('external'); setAgentId(null); setManagedIdentity(null) }} /><Choice disabled={actionDisabled || Boolean(recovery)} active={runtimeKind === 'nuvem_reference'} title="Nuvem reference" text="One-click identity and the transparent Nuvem runtime." onClick={() => { setRuntimeKind('nuvem_reference'); setAgentId(null) }} /></div>
                  <div className="grid gap-4 sm:grid-cols-2"><Field label="Agent display name" value={form.agentName} onChange={update('agentName')} placeholder={`${form.name || 'Vault'} Agent`} />{runtimeKind === 'external' ? <Field label="Agent signer address" hint="public only" value={form.agentSigner} onChange={update('agentSigner')} placeholder="0x…" /> : <div className="min-w-0"><div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-white/45">Managed signer</div><div className="rounded-xl border border-white/12 bg-black/25 px-4 py-3 text-xs text-white/55">{managedIdentity ? <span className="font-mono text-emerald-100">{short(managedIdentity.signer)}</span> : 'Created automatically when you launch'}</div></div>}</div>
                  <Field label="Public strategy summary" value={form.strategySummary} onChange={update('strategySummary')} placeholder="What this agent optimizes for" />
                  <Field label="Metadata URI" hint="optional" value={form.metadataUri} onChange={update('metadataUri')} placeholder="ipfs://…" />
                  <div className="border-t border-white/10 pt-4"><div className="mb-3 text-[10px] uppercase tracking-[0.16em] text-white/40">Onchain policy</div>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><Field label="Max trade" value={form.maxTrade} onChange={update('maxTrade')} suffix="% NAV" min={1} max={20} step={1} /><Field label="Max concentration" value={form.maxConcentration} onChange={update('maxConcentration')} suffix="% NAV" min={10} max={50} step={1} /><Field label="Daily turnover" value={form.dailyTurnover} onChange={update('dailyTurnover')} suffix="% NAV" min={5} max={100} step={1} /><Field label="Max slippage" value={form.maxSlippage} onChange={update('maxSlippage')} suffix="%" min={0.1} max={1} step={0.05} /><Field label="Trades per day" value={form.maxTradesPerDay} onChange={update('maxTradesPerDay')} min={1} max={200} step={1} /><Field label="Min interval" value={form.minTradeInterval} onChange={update('minTradeInterval')} suffix="min" min={1} max={60} step={1} /><Field label="Intent lifetime" value={form.maxIntentLifetime} onChange={update('maxIntentLifetime')} suffix="min" min={1} max={5} step={1} /></div>
                  </div>
                  <div className="rounded-xl border border-sky-200/15 bg-sky-200/[0.05] px-4 py-3 text-[11px] leading-5 text-sky-50/65">
                    {activeIdentityEnvironment === 'staging'
                      ? 'Robinhood testnet uses World staging Identity Check and an explicitly non-canonical staging backing. Canonical AgentBook remains required on mainnet. Only the attestation result is retained.'
                      : 'Every public AI vault requires one policy-bound World Identity Check plus canonical AgentBook backing. Only the attestation result is retained; document attributes and raw proofs are not stored by this page.'}
                    {' '}LP deposits remain permissionless.
                  </div>
                  {(status === 'world_identity' || status === 'world_agentbook') && worldConnectorUri && (
                    <div aria-live="polite" className="rounded-2xl border border-white/15 bg-white p-4 text-center text-gray-950">
                      <div className="text-sm font-semibold">{status === 'world_identity' ? 'Complete World Identity Check' : 'Register the agent in AgentBook'}</div>
                      <p className="mt-1 text-xs text-gray-500">
                        {status === 'world_identity'
                          ? `World will attest the backend-signed eligibility policy in ${recovery?.identityEnvironment ?? 'the configured environment'}.`
                          : 'This second proof makes the signer discoverable through World’s canonical AgentBook.'}
                        {' '}Nuvem never stores the raw proof in browser storage.
                      </p>
                      {worldQr && <img src={worldQr} alt="World App verification QR code" className="mx-auto mt-3 h-56 w-56 rounded-lg" />}
                      <p className="mt-3 text-xs font-medium text-gray-700">Keep this tab open for the QR step, scan once, and approve in World App. This page advances automatically; the QR expires after 5 minutes.</p>
                      <div className="mt-3 flex flex-wrap justify-center gap-2">
                        <a href={worldConnectorUri} target="_blank" rel="noreferrer" className="inline-flex rounded-lg bg-gray-950 px-4 py-2 text-xs font-semibold text-white">Open World App</a>
                        {status === 'world_identity' && recovery?.identityEnvironment === 'staging' && (
                          <a href="https://simulator.orb.engineer/" target="_blank" rel="noreferrer" className="inline-flex rounded-lg border border-gray-300 px-4 py-2 text-xs font-semibold text-gray-800">Open staging simulator</a>
                        )}
                      </div>
                      {status === 'world_agentbook' && worldCommand && (
                        <div className="mt-3 border-t border-gray-200 pt-3 text-[10px] text-gray-500">
                          <div>CLI fallback</div>
                          <button type="button" onClick={() => void navigator.clipboard.writeText(worldCommand)} className="mt-1 cursor-pointer font-mono text-gray-800 underline">Copy command</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <button type="button" onClick={() => setAdvanced((value) => !value)} className="flex w-full cursor-pointer items-center justify-between border-t border-white/10 pt-4 text-xs text-white/55 hover:text-white">Economic parameters <span className={advanced ? 'rotate-180' : ''}>⌄</span></button>
              {advanced && <div className="grid gap-4 rounded-2xl border border-white/10 bg-black/20 p-4 sm:grid-cols-2"><Field label="Minimum entry fee" value={form.entryFeeMin} onChange={update('entryFeeMin')} suffix="%" min={0} max={5} step={0.1} /><Field label="Sponsor share of entry fee" value={form.managerEntryShare} onChange={update('managerEntryShare')} suffix="%" min={0} max={50} step={1} /><Field label="AUM cap multiplier" value={form.kFactor} onChange={update('kFactor')} suffix="× stake" min={1} max={25} step={1} /><Field label="Accounting period" value={form.periodDays} onChange={update('periodDays')} suffix="days" min={7} max={90} step={1} /><Field label="Withdrawal cooldown" value={form.cooldownHours} onChange={update('cooldownHours')} suffix="hours" min={1} max={168} step={1} /></div>}

              {recovery && status === 'queued' && <div aria-live="polite" className="rounded-xl border border-amber-200/20 bg-amber-200/10 px-4 py-3 text-xs leading-5 text-amber-50"><div className="font-medium">{polling ? 'Operator deployment is running.' : 'Pending AI vault recovered in this tab.'}</div><div className="text-white/55">{polling ? 'You may close this window; polling pauses without cancelling the server job and resumes from the same job later.' : 'Continue the saved registration → Identity Check → AgentBook → backing flow. Completed steps are detected and skipped.'}</div><div className="mt-1 font-mono text-[10px] text-white/45">{jobStatus?.state ?? recovery.stage} · {jobId ?? short(recovery.agentId)}</div>{(jobStatus?.state === 'failed' || !recovery.jobId) && !polling && <button type="button" onClick={discardRecovery} className="mt-2 cursor-pointer text-[10px] text-white/45 underline hover:text-white/70">{jobStatus?.state === 'failed' ? 'Clear this failed recovery and start over' : 'Discard this pre-deployment recovery and start over'}</button>}</div>}
              {status === 'success' && <div className="rounded-xl border border-emerald-300/25 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">{managerType === 'ai' ? 'AI vault bound, policy active and loss protection locked.' : 'Vault registered and loss protection locked.'}<div className="mt-1 font-mono text-[10px] text-white/45">{agentDeployment?.fund || humanDeployment?.fund}</div></div>}

              <button type="submit" disabled={!authenticated || walletMismatch || actionDisabled || status === 'success'} className="w-full cursor-pointer rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-gray-950 transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-35">
                {!authenticated ? 'Connect wallet from the navbar' : walletMismatch ? 'Reconnect the active wallet first' : status === 'provisioning' ? 'Creating isolated agent identity…' : status === 'preparing' ? 'Preparing sponsor wallet…' : status === 'registering' ? 'Register agent in your wallet…' : status === 'world_identity' ? 'Waiting for World Identity Check…' : status === 'world_agentbook' ? 'Waiting for AgentBook…' : status === 'backing' ? 'Activating World backing in your wallet…' : status === 'deploying' ? 'Deploying contracts…' : status === 'binding' ? 'Authorize, bind and stake…' : status === 'approving' ? 'Lock protection in your wallet…' : status === 'queued' && polling ? 'Watching deployment job…' : status === 'queued' && recovery ? 'Resume pending AI vault' : status === 'success' ? 'Vault is live' : agentDeployment || humanDeployment ? 'Resume launch' : managerType === 'ai' ? 'Create AI vault' : 'Create human vault'}
              </button>
            </form>

            <aside className="p-5 sm:p-7 md:p-6"><div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Launch preview</div>
              <div className="mt-4 space-y-4"><div><div className="text-xs text-white/40">Sponsor</div><div className="mt-1 font-mono text-xs text-white/80">{loginAddress ? short(loginAddress) : 'Not connected'}</div></div>
                <div className="grid grid-cols-2 gap-3"><div className="rounded-xl border border-white/10 bg-white/[0.045] p-3"><div className="text-[9px] uppercase tracking-[0.14em] text-white/35">Protection</div><div className="mt-1 text-sm font-medium">${Number(form.initialStake || 0).toLocaleString()}</div></div><div className="rounded-xl border border-white/10 bg-white/[0.045] p-3"><div className="text-[9px] uppercase tracking-[0.14em] text-white/35">AUM cap</div><div className="mt-1 text-sm font-medium">${cap.toLocaleString()}</div></div></div>
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4"><div className="mb-3 text-[9px] uppercase tracking-[0.16em] text-white/35">Launch path</div><ol className="space-y-3">{steps.map(([label, active], index) => <li key={String(label)} className="flex gap-3 text-xs"><span className={active || status === 'success' ? 'text-emerald-200' : 'text-white/25'}>{String(index + 1).padStart(2, '0')}</span><span className={active ? 'text-white' : 'text-white/48'}>{String(label)}</span></li>)}</ol></div>
                {managerType === 'ai' && <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-[11px] leading-5 text-white/45"><div className="mb-2 text-white/70">Security boundary</div>{runtimeKind === 'external' ? 'The session reads context. Only your locally held EIP-712 signer can authorize a trade.' : 'The signer is isolated per vault and cannot bypass the controller policy.'} The controller validates every execution onchain.</div>}
                <p className="text-[10px] leading-4 text-white/30">Fees and immutable economics are visible before signing. Agent policy changes use a 24-hour timelock; pause and signer rotation are immediate.</p>
              </div></aside>
          </div>
        </div>
      </div>
    </div>
  )
}

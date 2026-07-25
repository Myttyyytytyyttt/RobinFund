import { useCallback, useEffect, useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { toDataURL } from 'qrcode'
import { getAddress, type Address, type Hex } from 'viem'
import { loadAgentDashboards, type AgentDashboardRecord, type PublicAgentDecision } from '@/lib/agentStore'
import {
  activateWorldBacking,
  createNuvemWorldIdRequest,
  finalizeAgentVault,
  getWorldRegistrationStatus,
  pauseAgent,
  rotateAgentSigner,
  submitNuvemWorldIdProof,
  submitWorldRegistrationProof,
  syncAgentProfile,
  waitForAgentVaultByAgent,
  waitForWorldRegistration,
} from '@/lib/agentTransactions'
import { requestAgentBookProof } from '@/lib/worldAgentBook'
import { requestNuvemWorldIdProof } from '@/lib/worldIdNuvem'
import { currentSupabaseAccessToken, ensureSupabaseWalletSession, type EthereumProvider } from '@/lib/supabase'
import type { BrowserWallet } from '@/lib/vaultTransactions'

const compact = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`
const ago = (value: string | null) => {
  if (!value) return 'never'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3_600)}h ago`
}

function decisionExplorerUrl(decision: PublicAgentDecision): string | null {
  if (!decision.transaction_hash) return null
  if (decision.chain_id === 4663) {
    return `https://robinhoodchain.blockscout.com/tx/${decision.transaction_hash}`
  }
  if (decision.chain_id === 46630) {
    return `https://explorer.testnet.chain.robinhood.com/tx/${decision.transaction_hash}`
  }
  return null
}

function UniswapDecision({ decision }: { decision: PublicAgentDecision }) {
  const explorer = decisionExplorerUrl(decision)
  const route = decision.token_in && decision.token_out
    ? `${compact(decision.token_in)} → ${compact(decision.token_out)}`
    : 'Bound CLASSIC route'
  const title = decision.decision === 'executed'
    ? 'Executed via Uniswap API'
    : decision.decision === 'approved'
      ? 'Uniswap execution approved'
      : null
  if (!title || !decision.token_in || !decision.token_out) return null
  return (
    <div className="rounded-xl border border-[#ff4d8d]/20 bg-[#ff4d8d]/[0.06] p-3 text-[10px]">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-pink-100">{title}</span>
        <span className="rounded-full border border-pink-200/15 px-2 py-0.5 text-[9px] text-pink-100/65">CLASSIC · chain {decision.chain_id}</span>
      </div>
      <div className="mt-2 font-mono text-white/60">{route}</div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <div><div className="text-white/25">Input</div><div className="mt-0.5 truncate text-white/65">{decision.amount_in ?? '—'}</div></div>
        <div><div className="text-white/25">Quoted out</div><div className="mt-0.5 truncate text-white/65">{decision.quoted_amount_out ?? '—'}</div></div>
        <div><div className="text-white/25">Min out</div><div className="mt-0.5 truncate text-white/65">{decision.min_amount_out ?? '—'}</div></div>
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-white/8 pt-2 text-white/35">
        <span>{decision.slippage_bps != null ? `${decision.slippage_bps / 100}% max slippage` : 'Onchain policy checked'}</span>
        {explorer && <a href={explorer} target="_blank" rel="noreferrer" className="text-pink-100/70 underline decoration-pink-100/25 underline-offset-2 hover:text-pink-50">View transaction ↗</a>}
      </div>
    </div>
  )
}

export function AgentDashboard({ sponsor }: { sponsor?: string }) {
  const { user } = usePrivy()
  const { wallets } = useWallets()
  const [agents, setAgents] = useState<AgentDashboardRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [rotate, setRotate] = useState<Record<string, string>>({})
  const [worldConnectorUri, setWorldConnectorUri] = useState<string | null>(null)
  const [worldQr, setWorldQr] = useState<string | null>(null)
  const [worldPhase, setWorldPhase] = useState<'nuvem' | 'agentbook' | null>(null)
  const loginAddress = user?.wallet?.address
  const wallet = wallets.find((candidate) => candidate.address.toLowerCase() === loginAddress?.toLowerCase())

  const refresh = useCallback(async () => {
    try {
      setAgents(await loadAgentDashboards(sponsor))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load agent audit data.')
    }
  }, [sponsor])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    let live = true
    if (!worldConnectorUri) {
      setWorldQr(null)
      return () => { live = false }
    }
    void toDataURL(worldConnectorUri, { width: 260, margin: 1 })
      .then((value) => { if (live) setWorldQr(value) })
    return () => { live = false }
  }, [worldConnectorUri])

  if (agents.length === 0 && !error) return null

  const act = async (agent: AgentDashboardRecord, action: 'pause' | 'rotate' | 'resume') => {
    if (!wallet) return setError('Connect the sponsor wallet to manage this agent.')
    setBusy(agent.agent_id)
    setError(null)
    setWorldConnectorUri(null)
    setWorldPhase(null)
    try {
      if (action === 'pause') {
        await pauseAgent(wallet as BrowserWallet, agent.agent_id as Hex, agent.controller_address as Address | null)
      } else if (action === 'rotate') {
        const value = rotate[agent.agent_id]
        if (!value) throw new Error('Enter the new local agent signer address.')
        await rotateAgentSigner(wallet as BrowserWallet, agent.agent_id as Hex, getAddress(value))
      } else {
        const provider = await wallet.getEthereumProvider()
        const supabaseWallet = {
          address: wallet.address,
          request: provider.request.bind(provider),
          on: provider.on.bind(provider),
          removeListener: provider.removeListener.bind(provider),
        } as EthereumProvider
        await ensureSupabaseWalletSession(wallet.address, supabaseWallet)
        const token = await currentSupabaseAccessToken()
        if (!token) throw new Error('Could not create the sponsor SIWE session.')
        if (!agent.world_backed) {
          setWorldPhase('nuvem')
          const nuvemWorld = await createNuvemWorldIdRequest(agent.agent_id as Hex, token)
          if (!nuvemWorld.verified) {
            const proof = await requestNuvemWorldIdProof(nuvemWorld, setWorldConnectorUri)
            await submitNuvemWorldIdProof(agent.agent_id as Hex, nuvemWorld.requestId, proof, token)
          }
          setWorldConnectorUri(null)
          setWorldPhase('agentbook')
          let registration = await getWorldRegistrationStatus(agent.agent_id as Hex, token)
          if (!registration.registered) {
            if (!registration.nextNonce) throw new Error('AgentBook did not return the next registration nonce.')
            const proof = await requestAgentBookProof({
              signer: registration.signer,
              appId: registration.appId,
              action: registration.action,
              nextNonce: registration.nextNonce,
            }, setWorldConnectorUri)
            await submitWorldRegistrationProof(agent.agent_id as Hex, proof, token)
            registration = await waitForWorldRegistration(agent.agent_id as Hex, token)
          }
          if (!registration.registered) throw new Error('World AgentBook registration was not confirmed.')
          setWorldConnectorUri(null)
          setWorldPhase(null)
          await activateWorldBacking(wallet as BrowserWallet, {
            agentId: agent.agent_id as Hex,
            signer: getAddress(agent.signer_address),
          }, token)
          await syncAgentProfile(agent.agent_id as Hex, token)
        }
        const deployment = await waitForAgentVaultByAgent(agent.agent_id as Hex, token)
        await finalizeAgentVault(wallet as BrowserWallet, deployment)
        await syncAgentProfile(agent.agent_id as Hex, token, deployment.controller)
      }
      await refresh()
      setWorldConnectorUri(null)
      setWorldPhase(null)
    } catch (caught) {
      setWorldConnectorUri(null)
      setWorldQr(null)
      setWorldPhase(null)
      setError(caught instanceof Error ? caught.message : 'Agent action failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="col-span-full mb-4 rounded-[26px] border border-emerald-200/20 bg-[#071412]/85 p-5 text-white shadow-2xl backdrop-blur-xl sm:p-7">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-emerald-200/65">Nuvem Agents control plane</div>
          <h3 className="mt-1 text-xl font-semibold tracking-tight">Autonomy, with visible limits</h3>
        </div>
        <div className="text-xs text-white/40">Public sanitized audit · private keys stay local</div>
      </div>
      {error && <div role="alert" aria-live="assertive" className="mb-4 rounded-xl border border-red-200/20 bg-red-300/10 px-4 py-3 text-xs text-red-100">{error}<div className="mt-1 text-white/40">Retry generates a fresh QR.</div></div>}
      {worldConnectorUri && <div aria-live="polite" className="mb-4 rounded-2xl border border-white/15 bg-white p-4 text-center text-gray-950"><div className="text-sm font-semibold">{worldPhase === 'nuvem' ? 'Verify sponsor with Nuvem' : 'Register agent in AgentBook'}</div><p className="mt-1 text-xs text-gray-500">Keep this tab open, scan once, and approve in World App. The dashboard advances automatically; the QR expires after 5 minutes.</p>{worldQr && <img src={worldQr} alt="World App verification QR code" className="mx-auto mt-3 h-52 w-52 rounded-lg" />}<a href={worldConnectorUri} className="mt-3 inline-flex rounded-lg bg-gray-950 px-4 py-2 text-xs font-semibold text-white">Open World App</a></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {agents.map((agent) => {
          const online = agent.last_heartbeat_at && Date.now() - new Date(agent.last_heartbeat_at).getTime() < 120_000
          const ownerAddress = sponsor || loginAddress
          const owner = ownerAddress?.toLowerCase() === agent.sponsor_wallet.toLowerCase()
          return (
            <article key={agent.agent_id} className="rounded-2xl border border-white/10 bg-black/25 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">{agent.display_name}</div>
                  <div className="mt-1 font-mono text-[10px] text-white/35">{compact(agent.agent_id)} · {agent.runtime_kind === 'external' ? 'BYOA' : 'Nuvem runtime'}</div>
                </div>
                <div className="flex gap-2 text-[10px]">
                  <span className={`rounded-full border px-2.5 py-1 ${online ? 'border-emerald-300/25 bg-emerald-300/10 text-emerald-100' : 'border-white/10 text-white/45'}`}>{online ? 'Online' : 'Offline'}</span>
                  <span className={`rounded-full border px-2.5 py-1 ${agent.world_backed ? 'border-sky-300/25 bg-sky-300/10 text-sky-100' : 'border-amber-300/20 bg-amber-300/10 text-amber-100'}`}>{agent.world_backed ? 'World-backed' : 'Backing pending'}</span>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-white/55">{agent.strategy_summary || 'No public strategy summary.'}</p>
              <div className="mt-4 grid grid-cols-3 gap-2 text-[10px]">
                <div className="rounded-lg bg-white/5 p-2"><div className="text-white/30">Heartbeat</div><div className="mt-1 text-white/70">{ago(agent.last_heartbeat_at)}</div></div>
                <div className="rounded-lg bg-white/5 p-2"><div className="text-white/30">Status</div><div className="mt-1 capitalize text-white/70">{agent.status.replace('_', ' ')}</div></div>
                <div className="rounded-lg bg-white/5 p-2"><div className="text-white/30">Decisions</div><div className="mt-1 text-white/70">{agent.decisions.length}</div></div>
              </div>
              <div className="mt-4 space-y-2">
                {agent.decisions.slice(0, 3).map((decision) => (
                  <div key={decision.id} className="space-y-2">
                    <div className="flex gap-3 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-[11px]">
                      <span className={decision.decision === 'executed' ? 'text-emerald-200' : decision.decision === 'rejected' || decision.decision === 'failed' ? 'text-red-200' : 'text-amber-100'}>{decision.decision.toUpperCase()}</span>
                      <span className="line-clamp-2 flex-1 text-white/55">{decision.summary}</span>
                      <span className="shrink-0 text-white/25">{ago(decision.occurred_at)}</span>
                    </div>
                    <UniswapDecision decision={decision} />
                  </div>
                ))}
                {agent.decisions.length === 0 && <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-white/30">No sanitized decisions yet</div>}
              </div>
              {owner && (
                <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-4">
                  {!agent.vault_address && <button disabled={busy === agent.agent_id} onClick={() => void act(agent, 'resume')} className="cursor-pointer rounded-full border border-emerald-200/25 bg-emerald-200/10 px-3 py-1.5 text-[11px] text-emerald-100 hover:bg-emerald-200/15 disabled:opacity-40">Finish launch</button>}
                  <button disabled={busy === agent.agent_id} onClick={() => void act(agent, 'pause')} className="cursor-pointer rounded-full border border-red-200/20 px-3 py-1.5 text-[11px] text-red-100 hover:bg-red-200/10 disabled:opacity-40">Pause now</button>
                  <input value={rotate[agent.agent_id] ?? ''} onChange={(event) => setRotate((current) => ({ ...current, [agent.agent_id]: event.target.value }))} placeholder="0x new signer" className="min-w-0 flex-1 rounded-full border border-white/10 bg-black/25 px-3 py-1.5 font-mono text-[10px] outline-none focus:border-emerald-200/30" />
                  <button disabled={busy === agent.agent_id} onClick={() => void act(agent, 'rotate')} className="cursor-pointer rounded-full border border-white/15 px-3 py-1.5 text-[11px] text-white/65 hover:bg-white/10 disabled:opacity-40">Rotate signer</button>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

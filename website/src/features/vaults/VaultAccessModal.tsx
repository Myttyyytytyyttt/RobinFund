import { useEffect, useMemo, useRef, useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import type { Address } from 'viem'
import type { Vault } from './types'
import { currentEntryFeeBps } from '@/lib/vaultStore'
import { loadProtocolRuntime } from '@/lib/protocolRuntime'
import { queueVaultDeposit, type BrowserWallet } from '@/lib/vaultTransactions'

type VaultAccessModalProps = {
  vault: Vault | null
  onClose: () => void
  onOpenCommunity: (vault: Vault) => void
  onChanged: () => void
}

const MAINNET_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address

function formatUsd(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(value)
}

const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`

function ManagerAvatar({ vault }: { vault: Vault }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-white/25 bg-white/10 text-2xl font-semibold uppercase shadow-xl">
      {vault.manager.avatar && !failed ? (
        <img
          src={vault.manager.avatar}
          alt={vault.manager.name}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        vault.manager.name.replace('@', '').slice(0, 1)
      )}
    </div>
  )
}

function AccessDetail({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3">
      <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-white/40">{label}</div>
      <div className={`break-words text-sm font-medium ${accent ? 'text-emerald-300' : 'text-white/85'}`}>{value}</div>
    </div>
  )
}

export function VaultAccessModal({ vault, onClose, onOpenCommunity, onChanged }: VaultAccessModalProps) {
  const { authenticated, user } = usePrivy()
  const { wallets } = useWallets()
  const [amount, setAmount] = useState('500')
  const [txStatus, setTxStatus] = useState<'idle' | 'approving' | 'queued'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  const loginAddress = user?.wallet?.address
  const signer = wallets.find((wallet) => wallet.address.toLowerCase() === loginAddress?.toLowerCase())

  useEffect(() => {
    if (!vault) return
    setAmount(String(Math.max(vault.access.minDeposit, 500)))
    setTxStatus('idle')
    setError(null)
    setTxHash(null)
    dialogRef.current?.scrollTo({ top: 0 })
  }, [vault])

  useEffect(() => {
    if (!vault) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && txStatus !== 'approving' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, txStatus, vault])

  const quote = useMemo(() => {
    if (!vault) return { amount: 0, fee: 0, net: 0, shares: 0, rateBps: 0, valid: false }
    const parsed = Number(amount)
    const safeAmount = Number.isFinite(parsed) ? parsed : 0
    const rateBps = currentEntryFeeBps(vault, safeAmount)
    const fee = (safeAmount * rateBps) / 10_000
    return {
      amount: safeAmount,
      fee,
      net: Math.max(0, safeAmount - fee),
      shares: Math.max(0, safeAmount - fee) / vault.sharePriceUsd,
      rateBps,
      valid:
        safeAmount >= vault.access.minDeposit &&
        safeAmount <= vault.access.availableCapacity,
    }
  }, [amount, vault])

  if (!vault) return null

  const isOpen = vault.access.status === 'open'
  const presets = [vault.access.minDeposit, 500, 1_000, 2_500].filter(
    (value, index, values) => value <= vault.access.availableCapacity && values.indexOf(value) === index,
  )

  const deposit = async () => {
    if (!authenticated || !signer) {
      setError('Connect the same wallet shown in the navbar before depositing.')
      return
    }
    if (!quote.valid) return
    setError(null)
    setTxStatus('approving')
    try {
      const runtime = await loadProtocolRuntime()
      const result = await queueVaultDeposit(
        signer as BrowserWallet,
        vault.address,
        runtime.usdg || MAINNET_USDG,
        amount,
      )
      setTxHash(result.requestHash)
      setTxStatus('queued')
      onChanged()
    } catch (caught) {
      setTxStatus('idle')
      setError(caught instanceof Error ? caught.message : 'The deposit request failed.')
    }
  }

  const statusLabel = {
    open: 'Deposits open',
    paused: 'Deposits paused',
    closed: 'Vault closed',
    setup: 'Protection pending',
  }[vault.access.status]

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[70] overflow-y-auto bg-[#020709]/70 px-4 py-6 backdrop-blur-xl sm:px-6 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-access-title"
      onMouseDown={(event) => event.currentTarget === event.target && txStatus !== 'approving' && onClose()}
    >
      <div className="relative mx-auto w-full min-w-0 max-w-4xl overflow-hidden rounded-[28px] border border-white/15 bg-[#071012] text-white shadow-[0_28px_100px_rgba(0,0,0,0.55)]">
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <img src="/vaultbg.webp" alt="" className="h-full w-full scale-[1.08] object-cover blur-[28px]" />
          <div className="absolute inset-0 bg-black/60" />
        </div>

        <div className="relative z-10">
          <div className="relative border-b border-white/10 px-6 pb-7 pt-6 sm:px-9 sm:pb-8 sm:pt-8">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(84,194,161,0.16),transparent_52%)]" />
            <button
              type="button"
              onClick={onClose}
              disabled={txStatus === 'approving'}
              aria-label="Close vault details"
              className="absolute right-5 top-5 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/20 text-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              ×
            </button>

            <div className="relative flex flex-col items-center text-center">
              <div className="relative mb-3">
                <ManagerAvatar vault={vault} />
                <span className="absolute bottom-0 right-0 h-4 w-4 rounded-full border-[3px] border-[#071012] bg-emerald-400" />
              </div>
              <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-emerald-200/65">Managed by</div>
              <h2 id="vault-access-title" className="text-xl font-semibold tracking-tight sm:text-2xl">{vault.manager.name}</h2>
              <div className="mt-1 font-mono text-xs text-white/45">{short(vault.manager.address)}</div>
              {vault.manager.socials.x && (
                <a
                  href={vault.manager.socials.x}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs text-white/65 transition-colors hover:bg-white/12 hover:text-white"
                >
                  {vault.manager.handle || 'X profile'}
                </a>
              )}
            </div>
          </div>

          <div className="grid min-w-0 lg:grid-cols-[1.08fr_0.92fr]">
            <section className="min-w-0 border-b border-white/10 p-6 sm:p-9 lg:border-b-0 lg:border-r">
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[11px] font-medium text-white/70">{vault.symbol}</span>
                <span className={`rounded-full border px-3 py-1 text-[11px] font-medium ${isOpen ? 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200' : 'border-amber-300/25 bg-amber-300/10 text-amber-200'}`}>
                  {statusLabel}
                </span>
                {vault.access.hasAccess && (
                  <span className="rounded-full border border-sky-300/25 bg-sky-300/10 px-3 py-1 text-[11px] font-medium text-sky-200">Member access</span>
                )}
              </div>

              <h3 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">{vault.name}</h3>
              <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">Fund contract</div>
                <p className="mt-1.5 break-all font-mono text-xs text-white/70">{vault.address}</p>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <AccessDetail label="Share NAV" value={vault.navValid ? vault.nav : 'Oracle unavailable'} />
                <AccessDetail label="Members" value={`${vault.members}`} />
                <AccessDetail label="Loss protection" value={formatUsd(vault.coverK * 1000)} accent />
                <AccessDetail label="Performance fee" value={`${(vault.config.perfFeeBps / 100).toFixed(1)}%`} />
              </div>

              <div className="mt-5 space-y-2 rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-xs text-white/55">
                <div className="flex justify-between gap-4"><span>AUM cap</span><span className="text-right text-white/80">{formatUsd(vault.aumCapUsd)}</span></div>
                <div className="flex justify-between gap-4"><span>Accounting period</span><span className="text-right text-white/80">{Math.round(vault.config.periodSeconds / 86400)} days</span></div>
                <div className="flex justify-between gap-4"><span>Next settlement</span><span className="text-right text-white/80">{vault.nextSettlement}</span></div>
              </div>
            </section>

            <section className="min-w-0 p-6 sm:p-9">
              <div className="mb-5">
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Onchain access</div>
                <div className="mt-1 text-lg font-semibold">{vault.access.hasAccess ? 'Your vault' : 'Queue a deposit'}</div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <AccessDetail label="Minimum" value={formatUsd(vault.access.minDeposit)} />
                <AccessDetail label="Capacity left" value={formatUsd(vault.access.availableCapacity)} />
                <AccessDetail label="Current entry fee" value={`${(quote.rateBps / 100).toFixed(2)}%`} />
                <AccessDetail label="Withdrawals" value={vault.access.withdrawalCooldown} />
              </div>

              <div className="mt-4 space-y-2 rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-xs text-white/55">
                <div className="flex justify-between gap-4"><span>Deposit window</span><span className="text-right text-white/80">{vault.access.depositWindow}</span></div>
                <div className="flex justify-between gap-4"><span>Execution</span><span className="text-right text-white/80">{vault.access.nextBatch}</span></div>
                <div className="flex justify-between gap-4"><span>Access</span><span className="text-right text-white/80">{vault.access.accessPolicy}</span></div>
              </div>

              {!vault.access.hasAccess && txStatus !== 'queued' && (
                <div className="mt-5">
                  <label htmlFor="vault-deposit" className="text-[10px] uppercase tracking-[0.16em] text-white/40">Deposit amount · USDG</label>
                  <div className="mt-2 flex items-center rounded-xl border border-white/15 bg-black/25 px-4 focus-within:border-emerald-300/45">
                    <span className="text-white/35">$</span>
                    <input
                      id="vault-deposit"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                      inputMode="decimal"
                      disabled={txStatus === 'approving'}
                      className="min-w-0 flex-1 bg-transparent px-2 py-3 text-lg text-white outline-none disabled:opacity-40"
                    />
                    <span className="text-xs text-white/35">USDG</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {presets.map((value) => (
                      <button type="button" key={value} onClick={() => setAmount(String(value))} className="cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-white/55 transition-colors hover:bg-white/10 hover:text-white">
                        {formatUsd(value)}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-white/50">
                    <div className="flex justify-between"><span>Estimated fee</span><span className="text-white/80">{formatUsd(quote.fee, 2)}</span></div>
                    <div className="mt-2 flex justify-between"><span>Estimated shares</span><span className="text-white/80">{quote.shares.toFixed(3)} {vault.symbol}</span></div>
                    <p className="mt-2 border-t border-white/10 pt-2 text-[10px] leading-4 text-white/35">Forward pricing: final shares are calculated by the keeper at execution, not at request time.</p>
                  </div>
                </div>
              )}

              {txStatus === 'queued' && (
                <div className="mt-5 rounded-2xl border border-emerald-300/25 bg-emerald-300/10 p-4 text-sm text-emerald-100">
                  Deposit queued onchain.
                  {txHash && <div className="mt-1 break-all font-mono text-[10px] text-white/45">{txHash}</div>}
                </div>
              )}

              {error && <div className="mt-4 rounded-xl border border-red-300/20 bg-red-300/10 px-4 py-3 text-xs text-red-100">{error}</div>}

              <div className="mt-6">
                {vault.access.hasAccess ? (
                  <button type="button" onClick={() => onOpenCommunity(vault)} className="w-full cursor-pointer rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-gray-950 transition-transform hover:scale-[1.01] active:scale-[0.99]">
                    Enter community
                  </button>
                ) : txStatus === 'queued' ? (
                  <button type="button" onClick={onClose} className="w-full cursor-pointer rounded-xl border border-white/15 bg-white/[0.06] px-5 py-3.5 text-sm font-medium text-white/75 transition-colors hover:bg-white/12 hover:text-white">Close</button>
                ) : (
                  <button
                    type="button"
                    disabled={!isOpen || !quote.valid || txStatus === 'approving'}
                    onClick={() => void deposit()}
                    className="w-full cursor-pointer rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-gray-950 transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {!isOpen ? statusLabel : txStatus === 'approving' ? 'Confirm both transactions…' : authenticated ? 'Approve & queue deposit' : 'Connect wallet to deposit'}
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

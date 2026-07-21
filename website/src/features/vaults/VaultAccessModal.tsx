import { useEffect, useMemo, useRef, useState } from 'react'
import type { Vault } from './types'

type VaultAccessModalProps = {
  vault: Vault | null
  onClose: () => void
  onOpenCommunity: (vault: Vault, preview: boolean) => void
}

function formatUsd(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(value)
}

function SocialLink({
  kind,
  href,
  label,
}: {
  kind: 'x' | 'telegram' | 'website'
  href?: string
  label: string
}) {
  const paths = {
    x: 'M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.2l7.3-8.3L2.8 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L7.6 3.9H5.8L17.8 20z',
    telegram:
      'M21.9 4.3c.3-1.1-.8-2-1.8-1.6L2.7 9.6c-1.1.4-1.1 2 .1 2.3l4.4 1.3 1.7 5.4c.3 1 1.6 1.3 2.3.5l2.4-2.5 4.5 3.3c.9.6 2.1.2 2.4-.9l3.4-14.7zM9.2 12.7l8.5-5.4c.4-.2.8.3.4.6l-6.9 6.4-.3 3.1-1.7-4.7z',
    website:
      'M12 2a10 10 0 100 20 10 10 0 000-20zm7.9 9h-3a15.6 15.6 0 00-1.1-5.3A8 8 0 0119.9 11zM12 4c.9 1.2 1.9 3.6 2.1 7h-4.2C10.1 7.6 11.1 5.2 12 4zM4.1 13h3c.2 2 .6 3.8 1.1 5.3A8 8 0 014.1 13zm3-2h-3a8 8 0 014.1-5.3A15.6 15.6 0 007.1 11zm4.9 9c-.9-1.2-1.9-3.6-2.1-7h4.2c-.2 3.4-1.2 5.8-2.1 7zm3.8-1.7c.5-1.5.9-3.3 1.1-5.3h3a8 8 0 01-4.1 5.3z',
  }

  return (
    <a
      href={href ?? '#'}
      aria-label={label}
      onClick={(event) => {
        if (!href || href === '#') event.preventDefault()
      }}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] text-white/60 transition-colors hover:bg-white/15 hover:text-white"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
        <path d={paths[kind]} />
      </svg>
    </a>
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

export function VaultAccessModal({ vault, onClose, onOpenCommunity }: VaultAccessModalProps) {
  const [amount, setAmount] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!vault) return
    setAmount(String(Math.max(vault.access.minDeposit, 500)))
    setReviewing(false)
    dialogRef.current?.scrollTo({ top: 0 })
  }, [vault])

  useEffect(() => {
    if (!vault) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [vault])

  useEffect(() => {
    if (!vault) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, vault])

  const quote = useMemo(() => {
    if (!vault) return { amount: 0, fee: 0, net: 0, shares: 0, valid: false }
    const parsed = Number(amount)
    const safeAmount = Number.isFinite(parsed) ? parsed : 0
    const fee = (safeAmount * vault.access.entryFeeBps) / 10_000
    return {
      amount: safeAmount,
      fee,
      net: Math.max(0, safeAmount - fee),
      shares: Math.max(0, safeAmount - fee) / vault.sharePriceUsd,
      valid:
        safeAmount >= vault.access.minDeposit &&
        safeAmount <= vault.access.maxDeposit &&
        safeAmount <= vault.access.availableCapacity,
    }
  }, [amount, vault])

  if (!vault) return null

  const isOpen = vault.access.status === 'open'
  const presets = [vault.access.minDeposit, 1_000, 2_500].filter(
    (value, index, values) => value <= vault.access.maxDeposit && values.indexOf(value) === index,
  )

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[70] overflow-y-auto bg-[#020709]/70 px-4 py-6 backdrop-blur-xl sm:px-6 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-access-title"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <div className="relative mx-auto w-full min-w-0 max-w-4xl overflow-hidden rounded-[28px] border border-white/15 bg-[#071012] text-white shadow-[0_28px_100px_rgba(0,0,0,0.55)]">
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <img
            src="/vaultbg.webp"
            alt=""
            className="h-full w-full scale-[1.08] object-cover blur-[8px]"
          />
          <div className="absolute inset-0 bg-black/60" />
        </div>

        <div className="relative z-10">
          <div className="relative border-b border-white/10 px-6 pb-7 pt-6 sm:px-9 sm:pb-8 sm:pt-8">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(84,194,161,0.16),transparent_52%)]" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close vault details"
            className="absolute right-5 top-5 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/20 text-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            ×
          </button>

          <div className="relative flex flex-col items-center text-center">
            <div className="relative mb-3">
              <img
                src={vault.manager.avatar}
                alt={vault.manager.name}
                className="h-20 w-20 rounded-full border border-white/25 object-cover shadow-xl"
              />
              <span className="absolute bottom-0 right-0 h-4 w-4 rounded-full border-[3px] border-[#071012] bg-emerald-400" />
            </div>
            <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-emerald-200/65">Managed by</div>
            <h2 id="vault-access-title" className="text-xl font-semibold tracking-tight sm:text-2xl">
              {vault.manager.name}
            </h2>
            <div className="mt-1 text-sm text-white/50">{vault.manager.handle}</div>
            <div className="mt-3 flex items-center gap-2">
              <SocialLink kind="x" href={vault.manager.socials.x} label={`${vault.manager.name} on X`} />
              <SocialLink
                kind="telegram"
                href={vault.manager.socials.telegram}
                label={`${vault.manager.name} on Telegram`}
              />
              <SocialLink kind="website" href={vault.manager.socials.website} label={`${vault.manager.name} website`} />
            </div>
          </div>
        </div>

          <div className="grid min-w-0 lg:grid-cols-[1.08fr_0.92fr]">
          <section className="min-w-0 border-b border-white/10 p-6 sm:p-9 lg:border-b-0 lg:border-r">
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[11px] font-medium text-white/70">
                {vault.symbol}
              </span>
              <span
                className={`rounded-full border px-3 py-1 text-[11px] font-medium ${
                  isOpen
                    ? 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200'
                    : 'border-amber-300/25 bg-amber-300/10 text-amber-200'
                }`}
              >
                {isOpen ? 'Deposits open' : 'Deposits paused'}
              </span>
              {vault.access.hasAccess && (
                <span className="rounded-full border border-sky-300/25 bg-sky-300/10 px-3 py-1 text-[11px] font-medium text-sky-200">
                  Member access
                </span>
              )}
            </div>

            <h3 className="text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">{vault.name}</h3>
            <p className="mt-3 break-words text-sm leading-6 text-white/60">{vault.description}</p>

            <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4">
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/35">Mandate</div>
              <p className="mt-1.5 text-sm text-white/75">{vault.mandate}</p>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <AccessDetail label="Share NAV" value={vault.nav} />
              <AccessDetail label="Members" value={`${vault.members}`} />
              <AccessDetail label="Loss protection" value={`$${vault.coverK}k`} accent />
              <AccessDetail label="All-time return" value={vault.perfTotal} accent />
            </div>
          </section>

          <section className="min-w-0 p-6 sm:p-9">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Access terms</div>
                <div className="mt-1 text-lg font-semibold">Join the vault</div>
              </div>
              <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[10px] uppercase tracking-[0.12em] text-white/45">
                Preview
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <AccessDetail label="Minimum" value={formatUsd(vault.access.minDeposit)} />
              <AccessDetail label="Maximum" value={formatUsd(vault.access.maxDeposit)} />
              <AccessDetail
                label="Entry fee"
                value={`${(vault.access.entryFeeBps / 100).toFixed(2)}% · ${vault.access.entryFeeMode}`}
              />
              <AccessDetail label="Capacity left" value={formatUsd(vault.access.availableCapacity)} />
            </div>

            <div className="mt-4 space-y-2 rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-xs text-white/55">
              <div className="flex justify-between gap-4">
                <span>Deposit window</span>
                <span className="text-right text-white/80">{vault.access.depositWindow}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Next batch</span>
                <span className="text-right text-white/80">{vault.access.nextBatch}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Withdrawals</span>
                <span className="text-right text-white/80">{vault.access.withdrawalCooldown}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Access</span>
                <span className="text-right text-white/80">{vault.access.accessPolicy}</span>
              </div>
            </div>

            {!vault.access.hasAccess && !reviewing && (
              <div className="mt-5">
                <label htmlFor="vault-deposit" className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                  Deposit amount · USDG
                </label>
                <div className="mt-2 flex items-center rounded-xl border border-white/15 bg-black/25 px-4 focus-within:border-emerald-300/45">
                  <span className="text-white/35">$</span>
                  <input
                    id="vault-deposit"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                    inputMode="decimal"
                    className="min-w-0 flex-1 bg-transparent px-2 py-3 text-lg text-white outline-none placeholder:text-white/20"
                  />
                  <span className="text-xs text-white/35">USDG</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {presets.map((value) => (
                    <button
                      type="button"
                      key={value}
                      onClick={() => setAmount(String(value))}
                      className="cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      {formatUsd(value)}
                    </button>
                  ))}
                </div>
                {!quote.valid && amount && (
                  <p className="mt-2 text-xs text-amber-200/75">
                    Enter an amount between {formatUsd(vault.access.minDeposit)} and{' '}
                    {formatUsd(Math.min(vault.access.maxDeposit, vault.access.availableCapacity))}.
                  </p>
                )}
              </div>
            )}

            {!vault.access.hasAccess && reviewing && (
              <div className="mt-5 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.06] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-medium text-emerald-200">Deposit preview</span>
                  <button
                    type="button"
                    onClick={() => setReviewing(false)}
                    className="cursor-pointer text-xs text-white/45 hover:text-white"
                  >
                    Edit
                  </button>
                </div>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-white/55"><span>Deposit</span><span className="text-white">{formatUsd(quote.amount, 2)}</span></div>
                  <div className="flex justify-between text-white/55"><span>Entry fee</span><span className="text-white">{formatUsd(quote.fee, 2)}</span></div>
                  <div className="flex justify-between text-white/55"><span>Estimated shares</span><span className="text-white">{quote.shares.toFixed(3)} {vault.symbol}</span></div>
                  <div className="flex justify-between border-t border-white/10 pt-2 text-white/55"><span>Execution</span><span className="text-white">{vault.access.nextBatch}</span></div>
                </div>
              </div>
            )}

            <div className="mt-6 space-y-2.5">
              {vault.access.hasAccess ? (
                <button
                  type="button"
                  onClick={() => onOpenCommunity(vault, false)}
                  className="w-full cursor-pointer rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-gray-950 transition-transform hover:scale-[1.01] active:scale-[0.99]"
                >
                  Enter community
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!isOpen || !quote.valid}
                    onClick={() => {
                      if (!reviewing) setReviewing(true)
                      else onOpenCommunity(vault, true)
                    }}
                    className="w-full cursor-pointer rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-gray-950 transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {!isOpen ? 'Deposits temporarily paused' : reviewing ? 'Preview member experience' : 'Review deposit'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenCommunity(vault, true)}
                    className="w-full cursor-pointer rounded-xl border border-white/15 bg-white/[0.04] px-5 py-3 text-sm font-medium text-white/65 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    Explore community preview
                  </button>
                </>
              )}
            </div>
          </section>
          </div>
        </div>
      </div>
    </div>
  )
}

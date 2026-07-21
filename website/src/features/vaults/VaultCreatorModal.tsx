import { useEffect, useMemo, useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import type { Address } from 'viem'
import {
  addInitialProtection,
  deployVault,
  type BrowserWallet,
  type VaultCreationInput,
  type VaultDeployment,
} from '@/lib/vaultTransactions'

type VaultCreatorModalProps = {
  open: boolean
  onClose: () => void
  onCreated: (address: Address) => void
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
}

const INITIAL_FORM: FormState = {
  name: '',
  symbol: '',
  initialStake: '2000',
  performanceFee: '20',
  entryFeeMin: '0',
  entryFeeMax: '2',
  managerEntryShare: '50',
  kFactor: '25',
  periodDays: '30',
  cooldownHours: '24',
}

const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`

function percentToBps(value: string): number {
  return Math.round(Number(value) * 100)
}

function Field({
  label,
  hint,
  value,
  onChange,
  suffix,
  min,
  max,
  step,
  autoFocus,
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  suffix?: string
  min?: number
  max?: number
  step?: number
  autoFocus?: boolean
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-2 flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.16em] text-white/45">
        {label}
        {hint && <span className="normal-case tracking-normal text-white/28">{hint}</span>}
      </span>
      <span className="flex items-center rounded-xl border border-white/12 bg-black/25 px-4 transition-colors focus-within:border-emerald-200/40">
        <input
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          min={min}
          max={max}
          step={step}
          type={min === undefined && max === undefined ? 'text' : 'number'}
          className="min-w-0 flex-1 bg-transparent py-3 text-sm text-white outline-none placeholder:text-white/20"
        />
        {suffix && <span className="ml-2 shrink-0 text-xs text-white/35">{suffix}</span>}
      </span>
    </label>
  )
}

export function VaultCreatorModal({ open, onClose, onCreated }: VaultCreatorModalProps) {
  const { authenticated, user } = usePrivy()
  const { wallets } = useWallets()
  const [form, setForm] = useState<FormState>(INITIAL_FORM)
  const [advanced, setAdvanced] = useState(false)
  const [status, setStatus] = useState<'idle' | 'deploying' | 'approving' | 'success'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [deployment, setDeployment] = useState<VaultDeployment | null>(null)

  const loginAddress = user?.wallet?.address
  const activeExternal = wallets.find((wallet) => wallet.walletClientType !== 'privy')
  const signer = wallets.find((wallet) => wallet.address.toLowerCase() === loginAddress?.toLowerCase())
  const walletMismatch = Boolean(
    authenticated && loginAddress && activeExternal && activeExternal.address.toLowerCase() !== loginAddress.toLowerCase(),
  )

  const update = (key: keyof FormState) => (value: string) => setForm((current) => ({ ...current, [key]: value }))

  const cap = useMemo(() => {
    const stake = Number(form.initialStake)
    const k = Number(form.kFactor)
    return Number.isFinite(stake * k) ? stake * k : 0
  }, [form.initialStake, form.kFactor])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && status === 'idle' && onClose()
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, open, status])

  if (!open) return null

  const buildInput = (): VaultCreationInput => {
    if (!loginAddress) throw new Error('Connect an EVM wallet before creating a vault.')
    if (!signer) throw new Error('The wallet that signed in is not connected.')
    if (walletMismatch) throw new Error('Your extension changed accounts. Reconnect from the navbar first.')
    const input: VaultCreationInput = {
      manager: loginAddress as Address,
      name: form.name.trim(),
      symbol: form.symbol.trim().toUpperCase(),
      initialStake: form.initialStake,
      perfFeeBps: percentToBps(form.performanceFee),
      feeMinBps: percentToBps(form.entryFeeMin),
      feeMaxBps: percentToBps(form.entryFeeMax),
      managerEntryShareBps: percentToBps(form.managerEntryShare),
      kFactor: Number(form.kFactor),
      periodDays: Number(form.periodDays),
      cooldownHours: Number(form.cooldownHours),
    }
    if (input.name.length < 3 || input.name.length > 48) throw new Error('Name must contain 3-48 characters.')
    if (!/^[A-Z0-9]{2,8}$/.test(input.symbol)) throw new Error('Symbol must contain 2-8 letters or numbers.')
    if (Number(input.initialStake) < 2_000) throw new Error('Initial loss protection starts at 2,000 USDG.')
    if (input.feeMinBps > input.feeMaxBps) throw new Error('Minimum entry fee cannot exceed the maximum.')
    return input
  }

  const stake = async (nextDeployment: VaultDeployment) => {
    if (!signer) throw new Error('The manager wallet is unavailable.')
    setStatus('approving')
    await addInitialProtection(signer as BrowserWallet, nextDeployment)
    setStatus('success')
    onCreated(nextDeployment.fund)
  }

  const submit = async () => {
    setError(null)
    try {
      if (deployment) return await stake(deployment)
      const input = buildInput()
      setStatus('deploying')
      const nextDeployment = await deployVault(input)
      setDeployment(nextDeployment)
      onCreated(nextDeployment.fund)
      await stake(nextDeployment)
    } catch (caught) {
      setStatus('idle')
      setError(caught instanceof Error ? caught.message : 'Vault creation failed.')
    }
  }

  const busy = status === 'deploying' || status === 'approving'

  return (
    <div
      className="fixed inset-0 z-[80] overflow-y-auto bg-[#020709]/75 px-4 py-6 backdrop-blur-xl sm:px-6 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-creator-title"
      onMouseDown={(event) => event.currentTarget === event.target && !busy && onClose()}
    >
      <div className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-[28px] border border-white/15 bg-[#071012]/95 text-white shadow-[0_28px_100px_rgba(0,0,0,0.6)]">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <img src="/vaultbg.webp" alt="" className="h-full w-full scale-110 object-cover blur-[28px]" />
          <div className="absolute inset-0 bg-black/70" />
        </div>

        <div className="relative z-10">
          <header className="flex items-start justify-between gap-6 border-b border-white/10 px-6 py-6 sm:px-8">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-emerald-200/65">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                Manager launch desk · devnet
              </div>
              <h2 id="vault-creator-title" className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">
                Create an onchain vault
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-white/55">
                The operator deploys and registers the contracts. Your wallet then locks the initial loss protection.
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              aria-label="Close creator"
              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/20 text-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              ×
            </button>
          </header>

          <div className="grid gap-0 md:grid-cols-[1fr_240px]">
            <form
              className="space-y-5 border-b border-white/10 p-6 sm:p-8 md:border-b-0 md:border-r"
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <div className="grid gap-4 sm:grid-cols-[1fr_150px]">
                <Field label="Vault name" value={form.name} onChange={update('name')} autoFocus />
                <Field label="Symbol" value={form.symbol} onChange={(value) => update('symbol')(value.toUpperCase())} hint="2-8 chars" />
              </div>
              <Field
                label="Initial loss protection"
                hint="Manager capital"
                value={form.initialStake}
                onChange={update('initialStake')}
                suffix="USDG"
                min={2000}
                step={100}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Performance fee" value={form.performanceFee} onChange={update('performanceFee')} suffix="%" min={0} max={30} step={0.1} />
                <Field label="Maximum entry fee" value={form.entryFeeMax} onChange={update('entryFeeMax')} suffix="%" min={0} max={5} step={0.1} />
              </div>

              <button
                type="button"
                onClick={() => setAdvanced((value) => !value)}
                className="flex w-full cursor-pointer items-center justify-between border-t border-white/10 pt-4 text-xs text-white/55 transition-colors hover:text-white"
              >
                Contract parameters
                <span className={`transition-transform ${advanced ? 'rotate-180' : ''}`}>⌄</span>
              </button>

              {advanced && (
                <div className="grid gap-4 rounded-2xl border border-white/10 bg-black/20 p-4 sm:grid-cols-2">
                  <Field label="Minimum entry fee" value={form.entryFeeMin} onChange={update('entryFeeMin')} suffix="%" min={0} max={5} step={0.1} />
                  <Field label="Manager share of entry fee" value={form.managerEntryShare} onChange={update('managerEntryShare')} suffix="%" min={0} max={50} step={1} />
                  <Field label="AUM cap multiplier" value={form.kFactor} onChange={update('kFactor')} suffix="× stake" min={1} max={25} step={1} />
                  <Field label="Accounting period" value={form.periodDays} onChange={update('periodDays')} suffix="days" min={7} max={90} step={1} />
                  <Field label="Withdrawal cooldown" value={form.cooldownHours} onChange={update('cooldownHours')} suffix="hours" min={1} max={168} step={1} />
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-red-300/20 bg-red-300/10 px-4 py-3 text-xs leading-5 text-red-100">
                  {error}
                  {deployment && <div className="mt-1 text-white/45">The Fund is already registered. Retry only completes its loss protection.</div>}
                </div>
              )}

              {status === 'success' && deployment && (
                <div className="rounded-xl border border-emerald-300/25 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">
                  Vault registered and loss protection locked.
                  <div className="mt-1 font-mono text-[11px] text-white/55">{deployment.fund}</div>
                </div>
              )}

              <button
                type="submit"
                disabled={!authenticated || walletMismatch || busy || status === 'success'}
                className="w-full cursor-pointer rounded-xl bg-white px-5 py-3.5 text-sm font-semibold text-gray-950 transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-35"
              >
                {!authenticated
                  ? 'Connect wallet from the navbar'
                  : walletMismatch
                    ? 'Reconnect the active wallet first'
                    : status === 'deploying'
                      ? 'Deploying and registering…'
                      : status === 'approving'
                        ? 'Confirm protection in your wallet…'
                        : status === 'success'
                          ? 'Vault is live'
                          : deployment
                            ? 'Retry loss protection'
                            : 'Create vault'}
              </button>
            </form>

            <aside className="p-6 sm:p-8 md:p-6">
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/40">Launch preview</div>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="text-xs text-white/40">Manager</div>
                  <div className="mt-1 font-mono text-xs text-white/80">{loginAddress ? short(loginAddress) : 'Not connected'}</div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-white/10 bg-white/[0.045] p-3">
                    <div className="text-[9px] uppercase tracking-[0.14em] text-white/35">Protection</div>
                    <div className="mt-1 text-sm font-medium">${Number(form.initialStake || 0).toLocaleString()}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.045] p-3">
                    <div className="text-[9px] uppercase tracking-[0.14em] text-white/35">AUM cap</div>
                    <div className="mt-1 text-sm font-medium">${cap.toLocaleString()}</div>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs leading-5 text-white/48">
                  <div className="mb-3 text-[9px] uppercase tracking-[0.16em] text-white/35">Real transaction path</div>
                  <ol className="space-y-3">
                    <li className="flex gap-3"><span className="text-emerald-200">01</span><span>Operator deploys Fund and five custody contracts.</span></li>
                    <li className="flex gap-3"><span className="text-emerald-200">02</span><span>FundRegistry emits FundRegistered.</span></li>
                    <li className="flex gap-3"><span className="text-emerald-200">03</span><span>Your wallet approves USDG and locks protection.</span></li>
                    <li className="flex gap-3"><span className="text-emerald-200">04</span><span>Ponder discovers the vault automatically.</span></li>
                  </ol>
                </div>
                <p className="text-[10px] leading-4 text-white/30">
                  Name and economic parameters are immutable in v1. Description and social content are intentionally not fabricated.
                </p>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useId, useMemo, useState } from 'react'
import type { Vault } from './types'

type VaultCommunityViewProps = {
  vault: Vault | null
  onClose: () => void
}

const fmtUsd = (value: number) =>
  `$${value.toLocaleString('en-US', { maximumFractionDigits: value < 10 ? 2 : 0 })}`

function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-40 flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-white/12 bg-black/15 px-6 text-center">
      <div className="text-sm font-medium text-white/72">{title}</div>
      <p className="mt-2 max-w-sm text-xs leading-5 text-white/38">{children}</p>
    </div>
  )
}

function PositionChart({ vault }: { vault: Vault }) {
  const id = useId().replace(/:/g, '')
  const data = vault.position.history.map((point) => point.value)
  const path = useMemo(() => {
    if (data.length < 2) return null
    const width = 620
    const height = 190
    const min = Math.min(...data)
    const max = Math.max(...data)
    const span = Math.max(max - min, 1)
    return data
      .map((value, index) => {
        const x = (index / (data.length - 1)) * width
        const y = height - 18 - ((value - min) / span) * (height - 36)
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
      })
      .join(' ')
  }, [data])

  if (!path) {
    return (
      <EmptyState title="Waiting for settled history">
        The chart will start after this vault records at least two real settlements.
      </EmptyState>
    )
  }

  return (
    <div className="min-h-40 flex-1 overflow-hidden rounded-2xl border border-white/10 bg-black/20 p-3">
      <svg viewBox="0 0 620 190" className="h-full min-h-40 w-full" preserveAspectRatio="none" role="img" aria-label="Indexed vault position history">
        <defs>
          <linearGradient id={`position-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${path} L620 190 L0 190 Z`} fill={`url(#position-${id})`} />
        <path d={path} fill="none" stroke="#6ee7b7" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

function Panel({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-[310px] min-w-0 flex-col p-5 sm:p-7">
      <div className="mb-5">
        <div className="text-[10px] uppercase tracking-[0.18em] text-white/38">{eyebrow}</div>
        <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-white">{title}</h2>
      </div>
      {children}
    </section>
  )
}

export function VaultCommunityView({ vault, onClose }: VaultCommunityViewProps) {
  const [parallax, setParallax] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!vault) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEscape)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onEscape)
    }
  }, [onClose, vault])

  if (!vault) return null

  return (
    <div
      className="fixed inset-0 z-[75] overflow-y-auto bg-[#021722] text-white"
      onPointerMove={(event) => setParallax({ x: event.clientX / window.innerWidth - 0.5, y: event.clientY / window.innerHeight - 0.5 })}
    >
      <div className="fixed inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute -inset-6 transition-transform duration-500 ease-out" style={{ transform: `scale(1.08) translate(${parallax.x * -12}px, ${parallax.y * -9}px)` }}>
          <img src="/vaultbg.webp" alt="" className="h-full w-full object-cover blur-[28px]" />
        </div>
        <div className="absolute inset-0 bg-black/65" />
      </div>

      <div className="relative z-10 min-h-screen px-4 py-5 sm:px-6 sm:py-6">
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/65">{vault.symbol} · member space</div>
            <h1 className="truncate text-xl font-semibold tracking-[-0.025em] sm:text-2xl">{vault.name}</h1>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 cursor-pointer rounded-full border border-white/20 bg-black/30 px-5 py-2.5 text-sm text-white transition-colors hover:bg-white hover:text-gray-950">
            Back to funds
          </button>
        </nav>

        <main className="mx-auto mt-5 w-full max-w-7xl overflow-hidden rounded-[28px] border border-white/15 bg-black/45 shadow-2xl backdrop-blur-xl">
          <div className="grid lg:grid-cols-2">
            <Panel eyebrow="Manager notes" title="Thesis board">
              <EmptyState title="No thesis has been published">
                This vault has no persisted manager thesis yet. Nothing simulated is shown.
              </EmptyState>
            </Panel>

            <div className="border-t border-white/10 lg:border-l lg:border-t-0">
              <Panel eyebrow="Your shares" title="Position trajectory">
                <div className="mb-4 grid grid-cols-3 gap-3">
                  <div><div className="text-[9px] uppercase tracking-[0.14em] text-white/35">Value</div><div className="mt-1 text-lg font-medium">{fmtUsd(vault.position.value)}</div></div>
                  <div><div className="text-[9px] uppercase tracking-[0.14em] text-white/35">Net invested</div><div className="mt-1 text-lg font-medium">{fmtUsd(vault.position.netInvested)}</div></div>
                  <div><div className="text-[9px] uppercase tracking-[0.14em] text-white/35">P&amp;L</div><div className={`mt-1 text-lg font-medium ${vault.position.pnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmtUsd(vault.position.pnl)}</div></div>
                </div>
                <PositionChart vault={vault} />
              </Panel>
            </div>

            <div className="border-t border-white/10">
              <Panel eyebrow="Community" title="Live chat">
                <EmptyState title="No persisted messages">
                  The social database has no messages for this vault. Local-only demo messages were removed.
                </EmptyState>
              </Panel>
            </div>

            <div className="border-t border-white/10 lg:border-l">
              <Panel eyebrow="Robinhood Chain" title="Onchain activity">
                {vault.activity.length ? (
                  <div className="space-y-2.5 overflow-y-auto pr-1">
                    {vault.activity.map((item) => (
                      <div key={item.id} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3">
                        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${item.tone === 'green' ? 'bg-emerald-300' : item.tone === 'red' ? 'bg-red-300' : 'bg-sky-300'}`} />
                        <div className="min-w-0 flex-1"><div className="text-sm font-medium text-white/82">{item.title}</div><div className="mt-0.5 text-xs text-white/42">{item.detail}</div></div>
                        <span className="shrink-0 text-[10px] text-white/28">{item.time}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No indexed activity yet">
                    Deposits, trades and settlements will appear here from Ponder events.
                  </EmptyState>
                )}
              </Panel>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

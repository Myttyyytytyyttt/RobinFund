import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { PortfolioPoint, Vault, VaultActivity, VaultChatMessage } from './types'

type VaultCommunityViewProps = {
  vault: Vault | null
  preview?: boolean
  onClose: () => void
}

function formatUsd(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(value)
}

function activityDot(tone: VaultActivity['tone']) {
  if (tone === 'green') return 'bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.45)]'
  if (tone === 'red') return 'bg-rose-300 shadow-[0_0_10px_rgba(253,164,175,0.4)]'
  if (tone === 'blue') return 'bg-sky-300 shadow-[0_0_10px_rgba(125,211,252,0.4)]'
  return 'bg-white/45'
}

function PanelHeading({ eyebrow, title, aside }: { eyebrow: string; title: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-5 flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/35">{eyebrow}</div>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-white sm:text-xl">{title}</h2>
      </div>
      {aside}
    </div>
  )
}

function PortfolioChart({ points, vault }: { points: PortfolioPoint[]; vault: Vault }) {
  const chart = useMemo(() => {
    const width = 620
    const height = 210
    const padX = 18
    const padTop = 30
    const padBottom = 28
    const values = points.map((point) => point.value)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = Math.max(max - min, 1)
    const coords = points.map((point, index) => ({
      x: padX + (index / Math.max(points.length - 1, 1)) * (width - padX * 2),
      y: padTop + ((max - point.value) / range) * (height - padTop - padBottom),
      point,
    }))
    const line = coords.map((coord, index) => `${index === 0 ? 'M' : 'L'} ${coord.x} ${coord.y}`).join(' ')
    const area = `${line} L ${coords[coords.length - 1]?.x ?? padX} ${height - padBottom} L ${coords[0]?.x ?? padX} ${
      height - padBottom
    } Z`
    return { width, height, padBottom, min, max, coords, line, area }
  }, [points])

  return (
    <div className="relative mt-3 min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-black/20 px-2 pb-1 pt-2">
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="h-[190px] w-full overflow-visible sm:h-[215px]"
        role="img"
        aria-label={`${vault.name} position performance chart`}
      >
        <defs>
          <linearGradient id={`vault-area-${vault.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#74e8bc" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#74e8bc" stopOpacity="0" />
          </linearGradient>
          <filter id={`vault-glow-${vault.id}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1="18"
            x2="602"
            y1={30 + fraction * 152}
            y2={30 + fraction * 152}
            stroke="rgba(255,255,255,0.07)"
            strokeDasharray="4 6"
          />
        ))}

        <path d={chart.area} fill={`url(#vault-area-${vault.id})`} />
        <path
          d={chart.line}
          fill="none"
          stroke="#78e8bd"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter={`url(#vault-glow-${vault.id})`}
        />

        {vault.position.events.map((event) => {
          const coord = chart.coords[event.pointIndex]
          if (!coord) return null
          const isBuy = event.side === 'B'
          const bubbleY = Math.max(8, coord.y - 34)
          return (
            <g key={`${event.pointIndex}-${event.ticker}`}>
              <title>{event.label}</title>
              <line x1={coord.x} x2={coord.x} y1={bubbleY + 22} y2={coord.y - 5} stroke="rgba(255,255,255,0.28)" />
              <rect
                x={coord.x - 23}
                y={bubbleY}
                width="46"
                height="22"
                rx="11"
                fill={isBuy ? 'rgba(52,211,153,0.24)' : 'rgba(251,113,133,0.22)'}
                stroke={isBuy ? 'rgba(110,231,183,0.55)' : 'rgba(253,164,175,0.5)'}
              />
              <text
                x={coord.x}
                y={bubbleY + 14.5}
                textAnchor="middle"
                fill={isBuy ? '#a7f3d0' : '#fecdd3'}
                fontSize="9.5"
                fontWeight="600"
              >
                {event.side} · {event.ticker}
              </text>
            </g>
          )
        })}

        <circle
          cx={chart.coords[chart.coords.length - 1]?.x}
          cy={chart.coords[chart.coords.length - 1]?.y}
          r="4.5"
          fill="#d1fae5"
          stroke="#34d399"
          strokeWidth="3"
        />
        <text x="18" y={chart.height - 8} fill="rgba(255,255,255,0.35)" fontSize="10">
          {points[0]?.label}
        </text>
        <text x="602" y={chart.height - 8} textAnchor="end" fill="rgba(255,255,255,0.35)" fontSize="10">
          {points[points.length - 1]?.label}
        </text>
      </svg>
    </div>
  )
}

function ThesisBoard({ vault }: { vault: Vault }) {
  return (
    <section className="flex min-h-[380px] min-w-0 flex-col border-b border-white/10 p-5 sm:p-7 lg:min-h-0 lg:border-r">
      <PanelHeading
        eyebrow="Manager desk"
        title="Thesis Board"
        aside={
          <span className="rounded-full border border-emerald-200/15 bg-emerald-200/[0.07] px-3 py-1 text-[10px] font-medium text-emerald-100/70">
            Manager posts only
          </span>
        }
      />
      <div className="vault-scrollbar flex-none space-y-3 overflow-visible pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {vault.theses.map((thesis) => (
          <article
            key={thesis.id}
            className={`min-w-0 rounded-2xl border p-4 sm:p-5 ${
              thesis.pinned
                ? 'border-emerald-200/20 bg-emerald-200/[0.055]'
                : 'border-white/10 bg-white/[0.035]'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                {thesis.pinned && (
                  <div className="mb-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-emerald-200/65">Pinned thesis</div>
                )}
                <h3 className="text-sm font-semibold text-white sm:text-base">{thesis.title}</h3>
              </div>
              <span className="shrink-0 text-[10px] text-white/30">{thesis.updatedAt}</span>
            </div>
            <p className="mt-3 break-words text-xs leading-5 text-white/60 sm:text-sm sm:leading-6">{thesis.body}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {thesis.tags.map((tag) => (
                <span key={tag} className="rounded-full border border-white/10 bg-black/15 px-2.5 py-1 text-[10px] text-white/45">
                  {tag}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3 border-t border-white/10 pt-4">
        <img src={vault.manager.avatar} alt="" className="h-8 w-8 rounded-full border border-white/15 object-cover" />
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-white/75">{vault.manager.name}</div>
          <div className="truncate text-[10px] text-white/35">{vault.manager.bio}</div>
        </div>
      </div>
    </section>
  )
}

function PositionPanel({ vault, preview }: { vault: Vault; preview: boolean }) {
  const hasPosition = vault.position.value > 0 && !preview
  return (
    <section className="flex min-h-[380px] min-w-0 flex-col border-b border-white/10 p-5 sm:p-7 lg:min-h-0">
      <PanelHeading
        eyebrow="Portfolio"
        title={hasPosition ? 'Your position' : 'Vault performance'}
        aside={
          <span className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-[10px] text-white/50">
            {hasPosition ? `${vault.position.allocationPercent}% of portfolio` : '30d view'}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-white/30">{hasPosition ? 'Value' : 'Vault NAV'}</div>
          <div className="mt-1 text-lg font-medium text-white sm:text-xl">
            {hasPosition ? formatUsd(vault.position.value) : vault.nav}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-white/30">{hasPosition ? 'Invested' : '7-day'}</div>
          <div className="mt-1 text-lg font-medium text-white sm:text-xl">
            {hasPosition ? formatUsd(vault.position.netInvested) : vault.perf7d}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <div className="text-[10px] uppercase tracking-[0.14em] text-white/30">{hasPosition ? 'Return' : 'All-time'}</div>
          <div className="mt-1 text-lg font-medium text-emerald-300 sm:text-xl">
            {hasPosition ? `${formatUsd(vault.position.pnl)} · +${vault.position.pnlPercent}%` : vault.perfTotal}
          </div>
        </div>
      </div>

      <PortfolioChart points={vault.position.history} vault={vault} />
      <div className="mt-3 flex items-center justify-between text-[10px] text-white/30">
        <span>Action bubbles mark manager trades</span>
        <span>{hasPosition ? `${vault.position.shares.toLocaleString('en-US', { maximumFractionDigits: 2 })} shares` : 'Strategy preview'}</span>
      </div>
    </section>
  )
}

function ChatPanel({ vault, preview }: { vault: Vault; preview: boolean }) {
  const [messages, setMessages] = useState<VaultChatMessage[]>(vault.chat)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setMessages(vault.chat)
    setDraft('')
  }, [vault])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const body = draft.trim()
    if (!body || preview) return
    setMessages((current) => [
      ...current,
      {
        id: `local-${Date.now()}`,
        user: '@you',
        avatar: '/twitter5.jpg',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        body,
        role: 'member',
      },
    ])
    setDraft('')
  }

  return (
    <section className="flex min-h-[390px] min-w-0 flex-col border-b border-white/10 p-5 sm:p-7 lg:min-h-0 lg:border-b-0 lg:border-r">
      <PanelHeading
        eyebrow="Members"
        title="Live chat"
        aside={
          <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] text-white/45">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> {vault.members} inside
          </span>
        }
      />

      <div className="vault-scrollbar flex-none space-y-4 overflow-visible pr-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {messages.map((message) => (
          <div key={message.id} className="flex items-start gap-3">
            <img src={message.avatar} alt="" className="h-8 w-8 shrink-0 rounded-full border border-white/15 object-cover" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-white/80">{message.user}</span>
                {message.role === 'manager' && (
                  <span className="rounded-full bg-emerald-300/10 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-emerald-200/70">
                    Manager
                  </span>
                )}
                <span className="text-[9px] text-white/25">{message.time}</span>
              </div>
              <p className="mt-1 break-words text-xs leading-5 text-white/60 sm:text-sm">{message.body}</p>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={submit} className="mt-4 flex items-center gap-2 border-t border-white/10 pt-4">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={preview}
          placeholder={preview ? 'Join the vault to participate' : 'Write to the community…'}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3 text-xs text-white outline-none placeholder:text-white/25 focus:border-emerald-200/30 disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={preview || !draft.trim()}
          aria-label="Send message"
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-white text-gray-950 transition-transform hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="m4 12 16-8-5.5 16-3.1-6.3L4 12Z" strokeLinejoin="round" />
            <path d="m11.4 13.7 3.7-3.7" strokeLinecap="round" />
          </svg>
        </button>
      </form>
    </section>
  )
}

function VaultPulse({ vault }: { vault: Vault }) {
  return (
    <section className="flex min-h-[390px] min-w-0 flex-col p-5 sm:p-7 lg:min-h-0">
      <PanelHeading
        eyebrow="Onchain now"
        title="Vault Pulse"
        aside={<span className="text-[10px] text-white/35">Live activity</span>}
      />

      <div className="grid grid-cols-3 gap-2.5">
        <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
          <div className="text-[9px] uppercase tracking-[0.12em] text-white/30">Protection</div>
          <div className="mt-1.5 text-sm font-semibold text-emerald-200">${vault.coverK}k</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
          <div className="text-[9px] uppercase tracking-[0.12em] text-white/30">Settlement</div>
          <div className="mt-1.5 text-sm font-semibold text-white/80">{vault.nextSettlement}</div>
        </div>
        <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
          <div className="text-[9px] uppercase tracking-[0.12em] text-white/30">Cash buffer</div>
          <div className="mt-1.5 text-sm font-semibold text-white/80">9.0%</div>
        </div>
      </div>

      <div className="vault-scrollbar relative mt-5 flex-none overflow-visible pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <div className="absolute bottom-3 left-[5px] top-3 w-px bg-white/10" />
        <div className="space-y-4">
          {vault.activity.map((item) => (
            <div key={item.id} className="relative flex items-start gap-4 pl-0.5">
              <span className={`relative z-10 mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-[#0a1315] ${activityDot(item.tone)}`} />
              <div className="min-w-0 flex-1 border-b border-white/[0.07] pb-3">
                <div className="flex items-start justify-between gap-3">
                <div className="text-xs font-medium text-white/80 sm:text-sm">{item.title}</div>
                  <div className="shrink-0 text-[9px] text-white/30">{item.time}</div>
                </div>
                <div className="mt-1 text-[11px] text-white/40">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-[10px]">
        <span className="text-white/35">Next deposits execute</span>
        <span className="font-medium text-white/70">{vault.access.nextBatch}</span>
      </div>
    </section>
  )
}

export function VaultCommunityView({ vault, preview = false, onClose }: VaultCommunityViewProps) {
  useEffect(() => {
    if (!vault) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, vault])

  useEffect(() => {
    if (!vault) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [vault])

  if (!vault) return null

  return (
    <div className="fixed inset-0 z-[75] overflow-y-auto bg-[#03090b]/75 px-3 py-3 text-white backdrop-blur-2xl sm:px-5 sm:py-5">
      <div className="mx-auto flex min-h-full w-full max-w-[1500px] flex-col">
        <header className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/15 bg-black/35 px-4 py-3 backdrop-blur-xl sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Back to vault details"
              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-white/[0.05] text-white/65 transition-colors hover:bg-white/15 hover:text-white"
            >
              ←
            </button>
            <img src="/logo.png" alt="NuvemFund" className="hidden h-7 w-auto sm:block" />
            <span className="hidden h-5 w-px bg-white/15 sm:block" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-sm font-semibold sm:text-base">{vault.name}</h1>
                <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[9px] text-white/40">{vault.symbol}</span>
              </div>
              <div className="truncate text-[10px] text-white/35">{vault.manager.handle} · {vault.mandate}</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {preview ? (
              <span className="rounded-full border border-amber-200/20 bg-amber-200/[0.08] px-3 py-1.5 text-[10px] font-medium text-amber-100/70">
                Community preview
              </span>
            ) : (
              <span className="rounded-full border border-emerald-200/20 bg-emerald-200/[0.08] px-3 py-1.5 text-[10px] font-medium text-emerald-100/70">
                Member · verified
              </span>
            )}
            <button
              type="button"
              className="hidden cursor-pointer rounded-full border border-white/15 bg-white/[0.05] px-4 py-2 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white sm:block"
            >
              Share vault
            </button>
          </div>
        </header>

        <main className="grid w-full min-w-0 flex-1 overflow-hidden rounded-[26px] border border-white/15 bg-[#081214]/90 shadow-[0_30px_100px_rgba(0,0,0,0.45)] lg:h-[calc(100vh-118px)] lg:min-h-[720px] lg:max-h-[920px] lg:flex-none lg:grid-cols-2 lg:grid-rows-2">
          <ThesisBoard vault={vault} />
          <PositionPanel vault={vault} preview={preview} />
          <ChatPanel vault={vault} preview={preview} />
          <VaultPulse vault={vault} />
        </main>
      </div>
    </div>
  )
}

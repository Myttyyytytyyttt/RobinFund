import { useEffect, useMemo, useRef, useState } from 'react'
import type { Profile } from '@/lib/profileStore'

const ACCENT = '#34d399' // emerald-400 (mismo verde de las cards)

// --- Mock (Fase 2: viene del backend/indexer ligado a la wallet) ---
type Position = { fund: string; manager: string; invested: number; value: number }
const MOCK_POSITIONS: Position[] = [
  { fund: 'Alpine Alpha', manager: '@sofia.eth', invested: 5000, value: 6180 },
  { fund: 'Momentum Seven', manager: '@kenji_t', invested: 3000, value: 3890 },
  { fund: 'Blue Chip Basket', manager: '@marchetti', invested: 4000, value: 4110 },
]

// Serie de valor de cartera (30 días) — determinista y con forma bonita
const SERIES: number[] = [
  10000, 10120, 10080, 10250, 10400, 10310, 10180, 10420, 10680, 10590, 10740, 11020, 10910, 11180,
  11450, 11320, 11600, 11880, 11740, 12050, 12310, 12180, 11990, 12420, 12680, 12540, 12900, 13210,
  13080, 14180,
]

const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

function dayLabel(i: number, total: number) {
  const daysAgo = total - 1 - i
  return daysAgo === 0 ? 'Today' : `${daysAgo}d ago`
}

export default function ProfileView({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const invested = MOCK_POSITIONS.reduce((s, p) => s + p.invested, 0)
  const value = MOCK_POSITIONS.reduce((s, p) => s + p.value, 0)
  const pnl = value - invested
  const pnlPct = (pnl / invested) * 100

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[65] overflow-y-auto" style={{ background: 'radial-gradient(120% 80% at 50% -10%, #123244 0%, #08131a 60%)' }}>
      {/* Topbar */}
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 sm:px-8 h-16 border-b border-white/10 bg-black/20 backdrop-blur-md">
        <img src="/logo.png" alt="Neverless" className="h-7 w-auto" />
        <span className="font-semibold text-white">Profile</span>
        <button
          onClick={onClose}
          className="ml-auto rounded-full border border-white/20 text-white/70 hover:text-white text-sm px-4 py-1.5 cursor-pointer transition-colors"
        >
          ← Back
        </button>
      </header>

      <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 text-white">
        {/* Identidad */}
        <div className="flex items-center gap-4 mb-8">
          <div className="w-16 h-16 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-2xl font-semibold uppercase">
            {profile.username.slice(0, 1)}
          </div>
          <div>
            <div className="text-2xl font-semibold">@{profile.username}</div>
            <div className="text-white/50 text-sm font-mono">
              {profile.address.slice(0, 6)}…{profile.address.slice(-4)}
              {profile.twitter && <span className="ml-2 text-white/70">· 𝕏 @{profile.twitter}</span>}
            </div>
          </div>
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatTile label="Invested" value={fmtUsd(invested)} />
          <StatTile label="Current value" value={fmtUsd(value)} />
          <StatTile
            label="All-time P&L"
            value={fmtUsd(pnl)}
            sub={fmtPct(pnlPct)}
            accent={pnl >= 0 ? ACCENT : '#f87171'}
          />
        </div>

        {/* Chart */}
        <div className="rounded-2xl bg-white/5 border border-white/10 p-5 mb-8">
          <div className="flex items-baseline justify-between mb-4">
            <div className="text-sm text-white/60">Portfolio value · 30d</div>
            <div className="text-sm" style={{ color: ACCENT }}>
              {fmtPct(((SERIES[SERIES.length - 1] - SERIES[0]) / SERIES[0]) * 100)}
            </div>
          </div>
          <AreaChart data={SERIES} accent={ACCENT} />
        </div>

        {/* Posiciones */}
        <div className="text-white/50 text-[11px] uppercase tracking-wide mb-3">Your funds</div>
        <div className="space-y-3">
          {MOCK_POSITIONS.map((p) => {
            const g = ((p.value - p.invested) / p.invested) * 100
            return (
              <div
                key={p.fund}
                className="flex items-center gap-4 rounded-2xl bg-white/5 border border-white/10 px-5 py-4 hover:bg-white/[0.07] transition-colors cursor-pointer"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.fund}</div>
                  <div className="text-white/50 text-sm">{p.manager}</div>
                </div>
                <div className="ml-auto text-right">
                  <div className="font-medium">{fmtUsd(p.value)}</div>
                  <div className="text-sm" style={{ color: g >= 0 ? ACCENT : '#f87171' }}>
                    {fmtPct(g)}
                  </div>
                </div>
                <div className="hidden sm:block w-28 text-right text-white/40 text-xs">
                  invested {fmtUsd(p.invested)}
                </div>
              </div>
            )
          })}
        </div>

        <p className="text-white/30 text-xs mt-8">
          Mockup data — live positions connect to your wallet in a later phase.
        </p>
      </div>
    </div>
  )
}

function StatTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 px-5 py-4">
      <div className="text-white/50 text-xs mb-1">{label}</div>
      <div className="text-2xl font-light tracking-tight" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub && <div className="text-sm mt-0.5" style={accent ? { color: accent } : undefined}>{sub}</div>}
    </div>
  )
}

/** Área de una serie: gradiente + línea 2px, grid recesivo, hover crosshair + tooltip. */
function AreaChart({ data, accent, height = 240 }: { data: number[]; accent: string; height?: number }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(720)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const padL = 48
  const padR = 12
  const padT = 12
  const padB = 24
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const geom = useMemo(() => {
    const innerW = Math.max(1, w - padL - padR)
    const innerH = height - padT - padB
    const x = (i: number) => padL + (i / (data.length - 1)) * innerW
    const y = (v: number) => padT + (1 - (v - min) / range) * innerH
    const pts = data.map((v, i) => [x(i), y(v)] as const)
    const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
    const area = `${line} L${x(data.length - 1).toFixed(1)},${padT + innerH} L${padL},${padT + innerH} Z`
    return { x, y, pts, line, area, innerH }
  }, [w, data, min, range, height])

  const onMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
    const rel = e.clientX - rect.left
    const innerW = Math.max(1, w - padL - padR)
    const i = Math.round(((rel - padL) / innerW) * (data.length - 1))
    setHover(Math.max(0, Math.min(data.length - 1, i)))
  }

  // 4 líneas guía + labels del eje Y
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, v: max - f * range, y: padT + f * geom.innerH }))
  const hp = hover != null ? geom.pts[hover] : null

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height }}>
      <svg width={w} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.35" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grid recesivo + labels Y */}
        {ticks.map((t) => (
          <g key={t.f}>
            <line x1={padL} y1={t.y} x2={w - padR} y2={t.y} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
            <text x={padL - 8} y={t.y + 3} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.4)">
              {fmtUsd(t.v)}
            </text>
          </g>
        ))}

        <path d={geom.area} fill="url(#areaFill)" />
        <path d={geom.line} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {/* Labels X (extremos + medio) — anclados para no recortar en los bordes */}
        {[0, Math.floor((data.length - 1) / 2), data.length - 1].map((i, k) => (
          <text
            key={i}
            x={geom.x(i)}
            y={height - 6}
            textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}
            fontSize="10"
            fill="rgba(255,255,255,0.4)"
          >
            {dayLabel(i, data.length)}
          </text>
        ))}

        {/* Crosshair + punto */}
        {hp && (
          <g>
            <line x1={hp[0]} y1={padT} x2={hp[0]} y2={height - padB} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
            <circle cx={hp[0]} cy={hp[1]} r="4.5" fill={accent} stroke="#08131a" strokeWidth="2" />
          </g>
        )}
      </svg>

      {/* Tooltip */}
      {hp && hover != null && (
        <div
          className="absolute pointer-events-none rounded-lg bg-[#0d1b24] border border-white/15 px-3 py-2 text-xs shadow-xl"
          style={{
            left: Math.min(Math.max(hp[0] - 40, 4), w - 100),
            top: Math.max(hp[1] - 54, 4),
          }}
        >
          <div className="text-white font-medium">{fmtUsd(data[hover])}</div>
          <div className="text-white/50">{dayLabel(hover, data.length)}</div>
        </div>
      )}
    </div>
  )
}

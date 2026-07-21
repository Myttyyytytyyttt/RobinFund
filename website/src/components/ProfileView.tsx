import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Profile } from '@/lib/profileStore'
import {
  loadPortfolio,
  type PortfolioData,
  type PortfolioPosition,
} from '@/lib/portfolioStore'

const ACCENT = '#6ee7b7'
const LOSS = '#fca5a5'
const PROFILE_BACKGROUND = '/ctavid2.mp4'

const EMPTY_PORTFOLIO: PortfolioData = {
  positions: [],
  invested: 0,
  value: 0,
  pnl: 0,
  pnlPct: 0,
  series: [0, 0],
  seriesLabels: ['Now', 'Now'],
  hasIndexedHistory: false,
}

const fmtUsd = (value: number) =>
  `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

const fmtPct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

const shortAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`

export default function ProfileView({
  profile,
  avatarUrl,
  onClose,
  onConnectTwitter,
}: {
  profile: Profile
  avatarUrl?: string | null
  onClose: () => void
  onConnectTwitter?: () => unknown
}) {
  const [parallax, setParallax] = useState({ x: 0, y: 0 })
  const [portfolio, setPortfolio] = useState<PortfolioData>(EMPTY_PORTFOLIO)
  const [portfolioStatus, setPortfolioStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const { positions, invested, value, pnl, pnlPct, series, seriesLabels } = portfolio
  const trajectoryPct = series[0] === 0 ? 0 : ((series[series.length - 1] - series[0]) / series[0]) * 100

  useEffect(() => {
    let cancelled = false
    setPortfolio(EMPTY_PORTFOLIO)
    setPortfolioStatus('loading')
    loadPortfolio(profile.address)
      .then((nextPortfolio) => {
        if (cancelled) return
        setPortfolio(nextPortfolio)
        setPortfolioStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        setPortfolio(EMPTY_PORTFOLIO)
        setPortfolioStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [profile.address])

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [onClose])

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    setParallax({
      x: event.clientX / window.innerWidth - 0.5,
      y: event.clientY / window.innerHeight - 0.5,
    })
  }

  return (
    <div
      className="fixed inset-0 z-[65] overflow-y-auto bg-[#021722] text-white"
      onPointerMove={onPointerMove}
    >
      <div className="fixed inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div
          className="absolute -inset-6 transition-transform duration-500 ease-out"
          style={{ transform: `scale(1.07) translate(${parallax.x * -12}px, ${parallax.y * -9}px)` }}
        >
          <FrozenProfileBackground />
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(1,13,20,0.18)_0%,rgba(1,13,20,0.36)_55%,rgba(1,13,20,0.66)_100%)]" />
      </div>

      <div className="relative z-10 min-h-screen">
        <nav className="max-w-7xl mx-auto w-full px-6 pt-6 flex items-center justify-between">
          <img
            src="/logo.png"
            alt="NuvemFund"
            className="h-9 w-auto select-none drop-shadow-lg"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-black/30 backdrop-blur-md border border-white/20 text-white text-sm px-5 py-2.5 cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Back to NuvemFund
          </button>
        </nav>

        <main className="max-w-6xl mx-auto w-full px-6 pt-10 pb-12">
          <section className="animate-fade-rise rounded-3xl bg-black/40 backdrop-blur-md border border-white/20 overflow-hidden shadow-2xl shadow-black/20">
            <div className="px-6 py-6 sm:px-8 sm:py-7 flex flex-col lg:flex-row lg:items-center gap-7">
              <div className="flex items-center gap-4 min-w-0 lg:w-[38%]">
                <div className="relative shrink-0">
                  <ProfileAvatar username={profile.username} src={avatarUrl} />
                  <span className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-300 border-[3px] border-[#102b32]" />
                </div>
                <div className="min-w-0">
                  <div className="text-white/50 text-[11px] uppercase tracking-[0.16em] mb-1">
                    Your portfolio
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-semibold tracking-[-0.035em] truncate">
                    @{profile.username}
                  </h1>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-white/55 text-xs">
                    <span className="font-mono">{shortAddress(profile.address)}</span>
                  </div>
                  <TwitterIdentityPill username={profile.twitter} onConnect={onConnectTwitter} />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 flex-1 border-t lg:border-t-0 lg:border-l border-white/10 pt-5 lg:pt-0 lg:pl-8 gap-5 sm:gap-0">
                <PortfolioMetric label="Portfolio value" value={fmtUsd(value)} />
                <PortfolioMetric label="Net invested" value={fmtUsd(invested)} />
                <PortfolioMetric
                  label="All-time return"
                  value={fmtUsd(pnl)}
                  detail={fmtPct(pnlPct)}
                  accent={pnl >= 0 ? ACCENT : LOSS}
                  className="col-span-2 sm:col-span-1"
                />
              </div>
            </div>
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.55fr)_minmax(330px,0.85fr)] gap-5 mt-5">
            <section className="animate-fade-rise-delay rounded-3xl bg-black/40 backdrop-blur-md border border-white/20 p-5 sm:p-7 shadow-2xl shadow-black/15 min-w-0">
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-5">
                <div>
                  <div className="text-white/50 text-[11px] uppercase tracking-[0.16em] mb-2">
                    Portfolio trajectory
                  </div>
                  <div className="flex items-baseline gap-3">
                    <span className="text-3xl sm:text-4xl font-light tracking-[-0.04em]">{fmtUsd(value)}</span>
                    <span className="text-sm font-medium" style={{ color: trajectoryPct >= 0 ? ACCENT : LOSS }}>
                      {fmtPct(trajectoryPct)}
                    </span>
                  </div>
                </div>
                <div className="self-start sm:self-auto rounded-full bg-white/10 border border-white/10 px-3 py-1.5 text-white/60 text-xs">
                  {portfolio.hasIndexedHistory ? 'Indexed history' : 'Latest indexed NAV'}
                </div>
              </div>
              <AreaChart data={series} labels={seriesLabels} accent={ACCENT} />
              <div className="flex items-center gap-2 mt-4 pt-4 border-t border-white/10 text-xs text-white/45">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-300" />
                Wallet positions valued at the latest indexed NAV.
              </div>
            </section>

            <section className="animate-fade-rise-delay-2 rounded-3xl bg-black/40 backdrop-blur-md border border-white/20 p-5 sm:p-6 shadow-2xl shadow-black/15 flex flex-col">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <div className="text-white/50 text-[11px] uppercase tracking-[0.16em] mb-1">Vaults</div>
                  <h2 className="text-xl font-semibold tracking-[-0.025em]">Your positions</h2>
                </div>
                <span className="rounded-full bg-white/10 border border-white/10 px-3 py-1 text-xs text-white/65">
                  {positions.length} active
                </span>
              </div>

              <div className="space-y-3">
                {positions.map((position) => (
                  <VaultPosition key={position.fundAddress} position={position} />
                ))}
                {portfolioStatus === 'loading' && <PortfolioNotice>Loading indexed positions...</PortfolioNotice>}
                {portfolioStatus === 'error' && (
                  <PortfolioNotice>The indexer is unavailable. No simulated balances are shown.</PortfolioNotice>
                )}
                {portfolioStatus === 'ready' && positions.length === 0 && (
                  <PortfolioNotice>This wallet has no active fund positions yet.</PortfolioNotice>
                )}
              </div>

              <button
                type="button"
                className="mt-5 w-full rounded-full bg-white/10 border border-white/15 text-white/80 hover:bg-white hover:text-gray-900 py-2.5 text-sm cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                Explore more funds
              </button>
            </section>
          </div>

          <p className="animate-fade-rise-delay-2 text-center text-white/40 text-xs mt-6">
            {portfolioStatus === 'error'
              ? 'Could not refresh the NuvemFund indexer. Financial values remain hidden.'
              : 'Live positions valued from the NuvemFund indexer and latest settled NAV.'}
          </p>
        </main>
      </div>
    </div>
  )
}

function ProfileAvatar({ username, src }: { username: string; src?: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showImage = !!src && failedSrc !== src

  return (
    <div className="w-16 h-16 sm:w-[72px] sm:h-[72px] overflow-hidden rounded-full bg-white/10 border border-white/25 flex items-center justify-center text-2xl font-semibold uppercase shadow-inner">
      {showImage ? (
        <img
          src={src}
          alt={`@${username}'s X profile picture`}
          className="h-full w-full object-cover"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        username.slice(0, 1)
      )}
    </div>
  )
}

function TwitterIdentityPill({
  username,
  onConnect,
}: {
  username?: string
  onConnect?: () => unknown
}) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectError, setConnectError] = useState(false)

  if (username) {
    return (
      <span className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-[#1d9bf0] px-3 text-[11px] font-medium text-white shadow-[0_6px_18px_rgba(29,155,240,0.2)]">
        <XMark />
        @{username}
      </span>
    )
  }

  const connect = async () => {
    if (!onConnect || isConnecting) return
    setConnectError(false)
    setIsConnecting(true)
    try {
      await Promise.resolve(onConnect())
    } catch {
      setConnectError(true)
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <button
      type="button"
      onClick={connect}
      disabled={!onConnect || isConnecting}
      title={connectError ? 'X could not be connected. Try again.' : 'Connect your X account'}
      className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-full bg-[#1d9bf0] px-3 text-[11px] font-medium text-white shadow-[0_6px_18px_rgba(29,155,240,0.2)] cursor-pointer transition-all hover:bg-[#168bd5] hover:scale-[1.02] active:scale-[0.98] disabled:cursor-wait disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7cc8f8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#2b302c]"
    >
      <XMark />
      {isConnecting ? 'Connecting...' : connectError ? 'Retry X' : 'Connect X'}
    </button>
  )
}

function XMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3 w-3" fill="currentColor">
      <path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.2l7.3-8.3L2.8 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L7.6 3.9H5.8L17.8 20z" />
    </svg>
  )
}

function FrozenProfileBackground() {
  const videoRef = useRef<HTMLVideoElement>(null)

  const seekToFinalFrame = () => {
    const video = videoRef.current
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return
    video.currentTime = Math.max(0, video.duration - 0.06)
  }

  return (
    <video
      ref={videoRef}
      className="absolute inset-0 w-full h-full object-cover"
      style={{ filter: 'blur(6px) saturate(1.15) brightness(0.78)' }}
      src={PROFILE_BACKGROUND}
      preload="auto"
      muted
      playsInline
      onLoadedMetadata={seekToFinalFrame}
      onSeeked={(event) => event.currentTarget.pause()}
    />
  )
}

function PortfolioMetric({
  label,
  value,
  detail,
  accent,
  className = '',
}: {
  label: string
  value: string
  detail?: string
  accent?: string
  className?: string
}) {
  return (
    <div className={`sm:px-6 sm:border-l sm:first:border-l-0 border-white/10 first:pl-0 ${className}`}>
      <div className="text-white/50 text-xs mb-1.5">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-xl sm:text-2xl font-light tracking-[-0.035em]" style={accent ? { color: accent } : undefined}>
          {value}
        </span>
        {detail && (
          <span className="text-xs font-medium" style={accent ? { color: accent } : undefined}>
            {detail}
          </span>
        )}
      </div>
    </div>
  )
}

function VaultPosition({ position }: { position: PortfolioPosition }) {
  return (
    <button
      type="button"
      className="group w-full rounded-2xl bg-white/[0.07] border border-white/10 p-4 text-left cursor-pointer transition-all hover:bg-white/[0.11] hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-full border border-white/20 flex items-center justify-center font-semibold text-sm text-gray-950 shrink-0"
          style={{ backgroundColor: position.accent }}
        >
          {position.symbol.slice(0, 3).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="font-medium truncate">{position.fund}</div>
          <div className="text-white/45 text-xs mt-0.5">{position.managerLabel}</div>
        </div>
        <div className="ml-auto text-right shrink-0">
          <div className="font-medium">{fmtUsd(position.value)}</div>
          <div className="text-xs mt-0.5" style={{ color: position.pnlPct >= 0 ? ACCENT : LOSS }}>
            {fmtPct(position.pnlPct)}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/10 text-[11px] text-white/45">
        <span>Invested {fmtUsd(position.invested)}</span>
        <span className="text-white/65 group-hover:text-white transition-colors">View vault -&gt;</span>
      </div>
    </button>
  )
}

function PortfolioNotice({ children }: { children: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.04] px-4 py-8 text-center text-sm text-white/50">
      {children}
    </div>
  )
}

function AreaChart({
  data,
  labels,
  accent,
  height = 272,
}: {
  data: number[]
  labels: string[]
  accent: string
  height?: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const gradientId = useId().replace(/:/g, '')
  const [width, setWidth] = useState(720)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const padLeft = width < 520 ? 42 : 52
  const padRight = 10
  const padTop = 12
  const padBottom = 25
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const geometry = useMemo(() => {
    const innerWidth = Math.max(1, width - padLeft - padRight)
    const innerHeight = height - padTop - padBottom
    const x = (index: number) => padLeft + (index / (data.length - 1)) * innerWidth
    const y = (value: number) => padTop + (1 - (value - min) / range) * innerHeight
    const points = data.map((value, index) => [x(index), y(value)] as const)
    const line = points
      .map(([pointX, pointY], index) => `${index ? 'L' : 'M'}${pointX.toFixed(1)},${pointY.toFixed(1)}`)
      .join(' ')
    const area = `${line} L${x(data.length - 1).toFixed(1)},${padTop + innerHeight} L${padLeft},${padTop + innerHeight} Z`
    return { x, points, line, area, innerHeight }
  }, [data, height, min, padLeft, range, width])

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const innerWidth = Math.max(1, width - padLeft - padRight)
    const index = Math.round(((event.clientX - rect.left - padLeft) / innerWidth) * (data.length - 1))
    setHover(Math.max(0, Math.min(data.length - 1, index)))
  }

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    fraction,
    value: max - fraction * range,
    y: padTop + fraction * geometry.innerHeight,
  }))
  const hoverPoint = hover !== null ? geometry.points[hover] : null

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Indexed portfolio value over time"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.38" />
            <stop offset="74%" stopColor={accent} stopOpacity="0.05" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((tick) => (
          <g key={tick.fraction}>
            <line
              x1={padLeft}
              y1={tick.y}
              x2={width - padRight}
              y2={tick.y}
              stroke="rgba(255,255,255,0.08)"
              strokeWidth="1"
              strokeDasharray={tick.fraction === 1 ? undefined : '3 5'}
            />
            <text x={padLeft - 8} y={tick.y + 3} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.42)">
              {fmtUsd(tick.value)}
            </text>
          </g>
        ))}

        <path d={geometry.area} fill={`url(#${gradientId})`} />
        <path
          d={geometry.line}
          fill="none"
          stroke={accent}
          strokeWidth="2.25"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {[0, Math.floor((data.length - 1) / 2), data.length - 1].map((index, tickIndex) => (
          <text
            key={index}
            x={geometry.x(index)}
            y={height - 5}
            textAnchor={tickIndex === 0 ? 'start' : tickIndex === 2 ? 'end' : 'middle'}
            fontSize="10"
            fill="rgba(255,255,255,0.42)"
          >
            {labels[index] ?? 'Indexed'}
          </text>
        ))}

        {hoverPoint && (
          <g>
            <line
              x1={hoverPoint[0]}
              y1={padTop}
              x2={hoverPoint[0]}
              y2={height - padBottom}
              stroke="rgba(255,255,255,0.28)"
              strokeWidth="1"
            />
            <circle cx={hoverPoint[0]} cy={hoverPoint[1]} r="5" fill={accent} stroke="#102b32" strokeWidth="2.5" />
          </g>
        )}
      </svg>

      {hoverPoint && hover !== null && (
        <div
          className="absolute pointer-events-none rounded-xl bg-[#0b2229]/95 backdrop-blur-md border border-white/15 px-3 py-2 text-xs shadow-xl"
          style={{
            left: Math.min(Math.max(hoverPoint[0] - 42, 4), width - 104),
            top: Math.max(hoverPoint[1] - 58, 4),
          }}
        >
          <div className="text-white font-medium">{fmtUsd(data[hover])}</div>
          <div className="text-white/50">{labels[hover] ?? 'Indexed'}</div>
        </div>
      )}
    </div>
  )
}

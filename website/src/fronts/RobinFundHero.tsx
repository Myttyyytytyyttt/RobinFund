import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { GooeyText } from '@/components/ui/gooey-text-morphing'
import { MagneticButton } from '@/components/ui/magnetic-button'
import WalletButton from '@/components/WalletButton'

// Visor de docs lazy: el markdown + react-markdown solo cargan al abrir Docs
const DocsView = lazy(() => import('@/components/DocsView'))

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260323_071151_38c3924f-c312-48af-a196-3fbb80e4226f.mp4'
const TRANSITION_VIDEO = '/ctavid2.mp4'

const NAV_LINKS = [
  { label: 'Home', active: true },
  { label: 'Funds', active: false },
  { label: 'Managers', active: false },
  { label: 'How it works', active: false },
  { label: 'Docs', active: false },
]

// Avatares locales (website/public/twitter1..5.jpg)
const AVATARS = ['/twitter1.jpg', '/twitter2.jpg', '/twitter3.jpg', '/twitter4.jpg', '/twitter5.jpg']

// Palabras de largo casi idéntico para que el titular centrado no "baile" al mutar
const MORPH_WORDS = ['Fellows.', 'Fortune.', 'Future.', 'Family.']

// Datos reales del proyecto (docs/SPEC.md §13, restricciones RHJ)
const STATS = [
  { value: '120+', label: 'Eligible countries' },
  { value: '24/7', label: 'Self-custody markets' },
  { value: '25×', label: 'Fund cap per manager stake' },
  { value: '20%', label: 'Performance fee, HWM-gated' },
]

// Mockup de fondos para la vista post-transición (solo maqueta visual)
type MockTrade = { side: 'B' | 'S'; ticker: string; size: string; ago: string }
const MOCK_FUNDS: {
  name: string
  manager: string
  perfTotal: string
  perf7d: string
  nav: string
  members: number
  coverK: number // Loss-Protection en miles de $ — decide el tier
  trades: MockTrade[]
}[] = [
  {
    name: 'Alpine Alpha',
    manager: '@sofia.eth',
    perfTotal: '+87%',
    perf7d: '+3.1%',
    nav: '$1.248',
    members: 248,
    coverK: 8,
    trades: [
      { side: 'B', ticker: 'NVDA', size: '$12.4k', ago: '2h' },
      { side: 'S', ticker: 'TSLA', size: '$8.2k', ago: '6h' },
      { side: 'B', ticker: 'AAPL', size: '$5.0k', ago: '1d' },
    ],
  },
  {
    name: 'Blue Chip Basket',
    manager: '@marchetti',
    perfTotal: '+34%',
    perf7d: '+1.8%',
    nav: '$1.091',
    members: 512,
    coverK: 40,
    trades: [
      { side: 'B', ticker: 'MSFT', size: '$22.0k', ago: '4h' },
      { side: 'B', ticker: 'SPY', size: '$15.5k', ago: '9h' },
      { side: 'S', ticker: 'NVDA', size: '$6.3k', ago: '2d' },
    ],
  },
  {
    name: 'Momentum Seven',
    manager: '@kenji_t',
    perfTotal: '+129%',
    perf7d: '+5.6%',
    nav: '$1.412',
    members: 97,
    coverK: 12,
    trades: [
      { side: 'B', ticker: 'TSLA', size: '$9.8k', ago: '1h' },
      { side: 'B', ticker: 'NVDA', size: '$14.1k', ago: '7h' },
      { side: 'S', ticker: 'MSFT', size: '$4.4k', ago: '1d' },
    ],
  },
]

// Mockup de managers (vista Managers — misma mecánica que Funds)
const MOCK_MANAGERS: {
  photo: string
  name: string
  handle: string
  perfTotal: string
  perf7d: string
  funds: { name: string; nav: string }[]
  socials: { x: string; tg: string; web: string }
}[] = [
  {
    photo: '/twitter1.jpg',
    name: 'Sofia Lindqvist',
    handle: '@sofia.eth',
    perfTotal: '+87%',
    perf7d: '+3.1%',
    funds: [
      { name: 'Alpine Alpha', nav: '$1.248' },
      { name: 'Nordic Growth', nav: '$1.062' },
    ],
    socials: { x: '#', tg: '#', web: '#' },
  },
  {
    photo: '/twitter2.jpg',
    name: 'Luca Marchetti',
    handle: '@marchetti',
    perfTotal: '+34%',
    perf7d: '+1.8%',
    funds: [{ name: 'Blue Chip Basket', nav: '$1.091' }],
    socials: { x: '#', tg: '#', web: '#' },
  },
  {
    photo: '/twitter3.jpg',
    name: 'Kenji Tanaka',
    handle: '@kenji_t',
    perfTotal: '+129%',
    perf7d: '+5.6%',
    funds: [
      { name: 'Momentum Seven', nav: '$1.412' },
      { name: 'Tokyo Overnight', nav: '$0.981' },
    ],
    socials: { x: '#', tg: '#', web: '#' },
  },
]

// Iconos sociales mínimos (inline, sin dependencias)
function SocialIcon({ kind, href }: { kind: 'x' | 'tg' | 'web'; href: string }) {
  const paths = {
    x: 'M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.2l7.3-8.3L2.8 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L7.6 3.9H5.8L17.8 20z',
    tg: 'M21.9 4.3c.3-1.1-.8-2-1.8-1.6L2.7 9.6c-1.1.4-1.1 2 .1 2.3l4.4 1.3 1.7 5.4c.3 1 1.6 1.3 2.3.5l2.4-2.5 4.5 3.3c.9.6 2.1.2 2.4-.9l3.4-14.7zM9.2 12.7l8.5-5.4c.4-.2.8.3.4.6l-6.9 6.4-.3 3.1-1.7-4.7z',
    web: 'M12 2a10 10 0 100 20 10 10 0 000-20zm7.9 9h-3a15.6 15.6 0 00-1.1-5.3A8 8 0 0119.9 11zM12 4c.9 1.2 1.9 3.6 2.1 7h-4.2C10.1 7.6 11.1 5.2 12 4zM4.1 13h3c.2 2 .6 3.8 1.1 5.3A8 8 0 014.1 13zm3-2h-3a8 8 0 014.1-5.3A15.6 15.6 0 007.1 11zm4.9 9c-.9-1.2-1.9-3.6-2.1-7h4.2c-.2 3.4-1.2 5.8-2.1 7zm3.8-1.7c.5-1.5.9-3.3 1.1-5.3h3a8 8 0 01-4.1 5.3z',
  }
  return (
    <a
      href={href}
      className="w-8 h-8 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-white/70 hover:text-white hover:bg-white/20 transition-colors"
      onClick={(e) => e.preventDefault()}
    >
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
        <path d={paths[kind]} />
      </svg>
    </a>
  )
}

// Pasos del How it works (copy simple; el detalle tecnico vive en docs)
const HOW_STEPS = [
  {
    n: '01',
    title: 'Connect & deposit',
    text: 'Link any EVM wallet and deposit USDG into the fund you pick. Your shares stay in your hands — always.',
  },
  {
    n: '02',
    title: 'Managers trade real stocks',
    text: 'Funds hold tokenized US stocks on Robinhood Chain. Markets run 24/7, fully on-chain and transparent.',
  },
  {
    n: '03',
    title: 'Losses hit the manager first',
    text: 'Every manager locks their own stake. If the fund loses, your first losses come out of it — that is the Loss-Protection tier on every card.',
  },
  {
    n: '04',
    title: 'Leave whenever you want',
    text: 'Withdraw at NAV, any day. No lock-ups, no permissions, no middlemen.',
  },
]

const TIER_LEGEND = [
  { name: 'Bronze', range: '< $5k', color: '#e5b184' },
  { name: 'Silver', range: '$5–10k', color: '#e4e4ea' },
  { name: 'Gold', range: '$10–20k', color: '#f2d77c' },
  { name: 'Diamond', range: '$20k+', color: '#cdeeff' },
]

// Tiers del Loss-Protection: <5k bronze · 5-10k silver · 10-20k gold · 20k+ diamond
function coverTier(k: number) {
  if (k >= 20)
    return { border: 'rgba(165,225,255,0.75)', text: '#cdeeff', glow: '0 0 14px rgba(165,225,255,0.28)' }
  if (k >= 10) return { border: 'rgba(255,215,0,0.6)', text: '#f2d77c', glow: '0 0 12px rgba(255,215,0,0.18)' }
  if (k >= 5) return { border: 'rgba(200,200,210,0.7)', text: '#e4e4ea', glow: 'none' }
  return { border: 'rgba(205,127,50,0.7)', text: '#e5b184', glow: 'none' }
}

// Logo de stock: primero public/stocks/<TICKER>.png (si lo añades tú), si no CDN, si no se oculta.
function StockLogo({ ticker }: { ticker: string }) {
  return (
    <img
      src={`/stocks/${ticker}.png`}
      onError={(e) => {
        const img = e.currentTarget
        if (!img.dataset.cdn) {
          img.dataset.cdn = '1'
          img.src = `https://assets.parqet.com/logos/symbol/${ticker}?format=png`
        } else {
          img.style.visibility = 'hidden'
        }
      }}
      alt={ticker}
      className="w-4 h-4 rounded-full bg-white/90 object-contain"
    />
  )
}

type Phase = 'hero' | 'transition' | 'vista'

export default function RobinFundHero() {
  const [phase, setPhase] = useState<Phase>('hero')
  const [vistaTab, setVistaTab] = useState<'funds' | 'managers' | 'how'>('funds')
  const [zoomed, setZoomed] = useState(false)
  const [blurPulse, setBlurPulse] = useState(false)
  const [par, setPar] = useState({ x: 0, y: 0 })
  const [showDocs, setShowDocs] = useState(false)
  const transVidRef = useRef<HTMLVideoElement>(null)
  const phaseRef = useRef<Phase>('hero')

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const startTransition = (target: 'funds' | 'managers' | 'how' = 'funds') => {
    if (phase !== 'hero') return
    setVistaTab(target)
    const v = transVidRef.current
    // El video arranca YA; el contenido del hero hace fade-off por encima y un pulso
    // de blur enmascara la costura entre el frame del fondo y el primer frame del clip.
    setPhase('transition')
    setBlurPulse(true)
    setTimeout(() => setBlurPulse(false), 1200)
    if (v) {
      v.currentTime = 0
      v.play().catch(() => handleEnded()) // si autoplay falla, saltamos directo a la vista final
    }
    // Red de seguridad: si el navegador pausa el video a mitad (cambio de pestaña,
    // ahorro de energía) y nunca llega el 'ended', forzamos la vista final.
    // Dinámico sobre la duración real del clip para sobrevivir a cambios de video.
    const safetyMs = (v && isFinite(v.duration) && v.duration > 0 ? v.duration + 3 : 12) * 1000
    setTimeout(() => {
      if (phaseRef.current === 'transition') handleEnded()
    }, safetyMs)
  }

  // Si el navegador auto-pausa el video durante la transición, intentamos reanudar.
  const handlePause = () => {
    const v = transVidRef.current
    if (v && phaseRef.current === 'transition' && !v.ended) v.play().catch(() => {})
  }

  const handleEnded = () => {
    // El video se queda pausado en su último frame; disparamos el zoom sutil de asentamiento
    setPhase('vista')
    setTimeout(() => setZoomed(true), 60)
  }

  const backToHero = () => {
    setPhase('hero')
    setZoomed(false)
    setPar({ x: 0, y: 0 })
    const v = transVidRef.current
    if (v) v.pause()
  }

  const onMouseMove = (e: React.MouseEvent) => {
    if (phase !== 'vista') return
    setPar({
      x: e.clientX / window.innerWidth - 0.5,
      y: e.clientY / window.innerHeight - 0.5,
    })
  }

  const showTransitionLayer = phase !== 'hero'

  return (
    <div
      className="relative min-h-screen overflow-hidden"
      style={{ backgroundColor: 'hsl(201 100% 13%)' }}
      onMouseMove={onMouseMove}
    >
      {/* Capa de vídeos — recibe el pulso de blur que tapa la intersección de frames */}
      <div className={`absolute inset-0 ${blurPulse ? 'animate-blur-pulse' : ''}`}>
        {/* Vídeo de fondo del hero */}
        <video
          className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
          style={{ opacity: showTransitionLayer ? 0 : 1 }}
          src={VIDEO_URL}
          autoPlay
          loop
          muted
          playsInline
        />

        {/* Capa de transición: zoom lento de asentamiento (wrapper exterior) + parallax de ratón (interior) */}
        <div
          className="absolute inset-0"
          style={{
            transform: zoomed ? 'scale(1.07)' : 'scale(1)',
            transition: 'transform 2200ms cubic-bezier(0.16, 1, 0.3, 1)',
            pointerEvents: 'none',
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              transform: `translate(${par.x * -16}px, ${par.y * -12}px)`,
              transition: 'transform 350ms ease-out',
            }}
          >
            {/* Siempre montado (preload); visible solo fuera del hero. Al terminar queda pausado en el
                último frame, y con el zoom de asentamiento entra un blur estilo iOS (30% ≈ 6px de ~20px
                máx.) + saturación leve, para que el mockup flote sobre fondo esmerilado. */}
            <video
              ref={transVidRef}
              className="absolute inset-0 w-full h-full object-cover"
              style={{
                opacity: showTransitionLayer ? 1 : 0,
                filter: zoomed ? 'blur(6px) saturate(1.15)' : 'blur(0px) saturate(1)',
                transition: 'opacity 700ms ease, filter 2000ms ease',
              }}
              src={TRANSITION_VIDEO}
              preload="auto"
              muted
              playsInline
              onEnded={handleEnded}
              onPause={handlePause}
            />
          </div>
        </div>
      </div>

      {/* ---------- HERO (montado durante la transición para el fade-off suave) ---------- */}
      {phase !== 'vista' && (
        <div
          className="relative z-10 min-h-screen"
          style={{
            opacity: phase === 'hero' ? 1 : 0,
            transform: phase === 'hero' ? 'scale(1)' : 'scale(1.04)',
            transition: 'opacity 600ms ease, transform 900ms ease',
            pointerEvents: phase === 'hero' ? 'auto' : 'none',
          }}
        >
          <nav className="max-w-7xl mx-auto px-6 pt-6 flex items-center justify-between">
            {/* Logo Neverless */}
            <img
              src="/logo.png"
              alt="Neverless"
              className="h-9 w-auto select-none"
              style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.25))' }}
            />

            <div className="hidden md:flex items-center gap-8">
              {NAV_LINKS.map(({ label, active }) => {
                const target =
                  label === 'Funds' ? 'funds' : label === 'Managers' ? 'managers' : label === 'How it works' ? 'how' : null
                return (
                  <a
                    key={label}
                    href="#"
                    onClick={(e) => {
                      e.preventDefault()
                      if (label === 'Docs') setShowDocs(true)
                      else if (target) startTransition(target)
                    }}
                    className={`text-sm transition-colors ${
                      active ? 'text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    {label}
                  </a>
                )
              })}
            </div>

            <WalletButton />
          </nav>

          <main className="max-w-7xl mx-auto px-6 pt-32 pb-12 flex flex-col items-center text-center">
            <div className="animate-fade-rise mb-8 rounded-full bg-white/20 backdrop-blur-sm border border-gray-900/10 pl-3 pr-5 py-2 flex items-center gap-3">
              <div className="flex -space-x-2.5">
                {AVATARS.map((src, i) => (
                  <img
                    key={i}
                    src={src}
                    alt={`Manager ${i + 1}`}
                    className="w-8 h-8 rounded-full border-2 border-white object-cover"
                  />
                ))}
              </div>
              <span className="text-sm text-gray-800">
                Top traders run social funds — backed by their own stake.
              </span>
            </div>

            <h1 className="animate-fade-rise font-bold text-5xl sm:text-6xl md:text-[4.9rem] leading-[0.95] tracking-[-1.5px] text-gray-900 max-w-5xl flex flex-wrap items-center justify-center gap-x-[0.22em]">
              <span>Finance. Freedom.</span>
              <GooeyText
                texts={MORPH_WORDS}
                morphTime={1}
                cooldownTime={2}
                className="w-[3.95em] h-[0.95em]"
                textClassName="top-0 left-0 w-full text-5xl sm:text-6xl md:text-[4.9rem] font-bold leading-[0.95] tracking-[-1.5px] text-gray-900"
              />
            </h1>

            <p className="animate-fade-rise-delay text-base sm:text-lg text-gray-800 max-w-2xl mt-6 leading-relaxed">
              Invest together. Real stocks, shared wins, protected losses.
            </p>

            {/* CTA — magnet sutil (el fade-rise va en el wrapper: framer pisa el transform del mismo nodo) */}
            <div className="animate-fade-rise-delay-2 mt-9">
              <MagneticButton distance={0.25}>
                <button
                  onClick={() => startTransition('funds')}
                  className="bg-gray-900/90 text-white rounded-full px-12 py-4 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
                >
                  Explore Funds
                </button>
              </MagneticButton>
            </div>
          </main>

          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-[calc(100%-3rem)] max-w-4xl rounded-3xl bg-white/10 backdrop-blur-sm border border-gray-900/10 px-8 py-6">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
              {STATS.map(({ value, label }) => (
                <div key={label} className="flex flex-col items-center text-center gap-1">
                  <span className="text-white text-3xl sm:text-4xl font-light tracking-tight">{value}</span>
                  <span className="text-white/70 text-sm">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---------- VISTA (post-transición): mockup sobre las montañas ---------- */}
      {phase === 'vista' && (
        <div className="relative z-10 min-h-screen flex flex-col">
          <nav className="max-w-7xl mx-auto w-full px-6 pt-6 flex items-center justify-between">
            <button
              onClick={backToHero}
              className="animate-fade-rise rounded-full bg-black/30 backdrop-blur-sm border border-white/20 text-white text-sm px-5 py-2.5 cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
            >
              ← Back
            </button>
            {/* Pills para saltar entre vistas sin repetir el vuelo */}
            <div className="animate-fade-rise flex items-center gap-1 rounded-full bg-black/30 backdrop-blur-sm border border-white/20 p-1">
              {(['funds', 'managers', 'how'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setVistaTab(tab)}
                  className={`rounded-full px-4 py-1.5 text-sm cursor-pointer transition-colors ${
                    vistaTab === tab ? 'bg-white text-gray-900 font-medium' : 'text-white/70 hover:text-white'
                  }`}
                >
                  {tab === 'funds' ? 'Funds' : tab === 'managers' ? 'Managers' : 'How it works'}
                </button>
              ))}
            </div>

            <span className="animate-fade-rise rounded-full bg-black/30 backdrop-blur-sm border border-white/20 text-white/70 text-xs px-4 py-2">
              Mockup — vista previa
            </span>
          </nav>

          <main className="max-w-6xl mx-auto w-full px-6 pt-10">
            <h2 className="animate-fade-rise text-white font-bold text-3xl sm:text-4xl md:text-5xl tracking-[-1px] mb-2 drop-shadow-lg">
              {vistaTab === 'funds' ? 'Explore Funds' : vistaTab === 'managers' ? 'Managers' : 'How it works'}
            </h2>
            <p className="animate-fade-rise-delay text-white/80 text-base sm:text-lg mb-8 drop-shadow">
              {vistaTab === 'funds'
                ? 'Managers with real skin in the game. Pick one, follow their moves.'
                : vistaTab === 'managers'
                  ? 'The people behind the funds — track record, funds and where to find them.'
                  : 'Four steps. Your keys, real stocks, and a manager who loses first.'}
            </p>

            {vistaTab === 'how' && (
              <div className="animate-fade-rise-delay-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-6">
                  {HOW_STEPS.map((s) => (
                    <div
                      key={s.n}
                      className="rounded-2xl bg-black/40 backdrop-blur-md border border-white/20 p-6 text-white transition-transform hover:scale-[1.02]"
                    >
                      <div className="text-emerald-300/80 font-mono text-sm mb-3">{s.n}</div>
                      <div className="font-semibold text-lg mb-2 leading-tight">{s.title}</div>
                      <p className="text-white/70 text-sm leading-relaxed">{s.text}</p>
                    </div>
                  ))}
                </div>

                {/* Leyenda de tiers del Loss-Protection */}
                <div className="rounded-2xl bg-black/30 backdrop-blur-md border border-white/15 px-6 py-4 flex flex-wrap items-center gap-x-8 gap-y-2">
                  <span className="text-white/50 text-[11px] uppercase tracking-wide">Loss-Protection tiers</span>
                  {TIER_LEGEND.map((t) => (
                    <span key={t.name} className="flex items-center gap-2 text-sm" style={{ color: t.color }}>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />
                      {t.name} <span className="text-white/50 text-xs">{t.range}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {vistaTab === 'managers' && (
              <div className="animate-fade-rise-delay-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {MOCK_MANAGERS.map((m) => (
                  <div
                    key={m.handle}
                    className="rounded-2xl bg-black/40 backdrop-blur-md border border-white/20 p-6 text-white cursor-pointer transition-transform hover:scale-[1.02] flex flex-col"
                  >
                    {/* Cabecera: foto + nombre + % */}
                    <div className="flex items-start justify-between mb-5">
                      <div className="flex items-center gap-3">
                        <img
                          src={m.photo}
                          alt={m.name}
                          className="w-14 h-14 rounded-full border-2 border-white/30 object-cover"
                        />
                        <div>
                          <div className="font-semibold text-lg leading-tight">{m.name}</div>
                          <div className="text-white/60 text-sm">{m.handle}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-emerald-300 font-semibold text-xl leading-none">{m.perfTotal}</div>
                        <div className="text-white/60 text-xs mt-1">
                          {m.perf7d} <span className="text-white/40">· 7d</span>
                        </div>
                      </div>
                    </div>

                    {/* Fondos que gestiona */}
                    <div className="text-white/50 text-[11px] uppercase tracking-wide mb-2">Manages</div>
                    <ul className="space-y-1.5 mb-5">
                      {m.funds.map((f) => (
                        <li
                          key={f.name}
                          className="flex items-center justify-between text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2"
                        >
                          <span className="font-medium">{f.name}</span>
                          <span className="text-white/60">NAV {f.nav}</span>
                        </li>
                      ))}
                    </ul>

                    {/* Links sociales — mt-auto: anclados abajo aunque haya pocos fondos */}
                    <div className="mt-auto flex items-center gap-2 pt-4 border-t border-white/10">
                      <SocialIcon kind="x" href={m.socials.x} />
                      <SocialIcon kind="tg" href={m.socials.tg} />
                      <SocialIcon kind="web" href={m.socials.web} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {vistaTab === 'funds' && (
            <div className="animate-fade-rise-delay-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {MOCK_FUNDS.map((f) => {
                const tier = coverTier(f.coverK)
                return (
                  <div
                    key={f.name}
                    className="rounded-2xl bg-black/40 backdrop-blur-md border border-white/20 p-6 text-white cursor-pointer transition-transform hover:scale-[1.02] flex flex-col"
                  >
                    {/* Cabecera: nombre + % general grande con 7d debajo */}
                    <div className="flex items-start justify-between mb-1">
                      <span className="font-semibold text-lg">{f.name}</span>
                      <div className="text-right">
                        <div className="text-emerald-300 font-semibold text-xl leading-none">{f.perfTotal}</div>
                        <div className="text-white/60 text-xs mt-1">
                          {f.perf7d} <span className="text-white/40">· 7d</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-white/60 text-sm mb-5">
                      {f.manager}
                      <span className="mx-2 text-white/30">·</span>
                      {f.members} investors
                    </div>

                    {/* Trades recientes, en pequeño, con logo del stock */}
                    <div className="text-white/50 text-[11px] uppercase tracking-wide mb-2">Recent trades</div>
                    <ul className="space-y-1.5 mb-5">
                      {f.trades.map((t, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs">
                          <span
                            className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
                              t.side === 'B' ? 'bg-emerald-400/25 text-emerald-300' : 'bg-red-400/25 text-red-300'
                            }`}
                          >
                            {t.side}
                          </span>
                          <StockLogo ticker={t.ticker} />
                          <span className="font-medium">{t.ticker}</span>
                          <span className="text-white/60">{t.size}</span>
                          <span className="ml-auto text-white/40">{t.ago}</span>
                        </li>
                      ))}
                    </ul>

                    {/* Pie: NAV + Loss-Protection con tier — mt-auto: siempre anclado abajo */}
                    <div className="mt-auto flex items-center justify-between text-sm pt-4 border-t border-white/10">
                      <span className="text-white/80">NAV {f.nav}</span>
                      <span
                        className="rounded-full bg-white/10 border px-3 py-1 text-xs font-medium"
                        style={{ borderColor: tier.border, color: tier.text, boxShadow: tier.glow }}
                      >
                        ${f.coverK}k Loss-Protection
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
            )}
          </main>
        </div>
      )}

      {/* ---------- DOCS (overlay, lazy) ---------- */}
      {showDocs && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[60] bg-[#0d1b24] flex items-center justify-center text-white/60 text-sm">
              Loading docs…
            </div>
          }
        >
          <DocsView onClose={() => setShowDocs(false)} />
        </Suspense>
      )}
    </div>
  )
}

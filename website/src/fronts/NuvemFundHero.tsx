import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePrivy, useWallets } from '@privy-io/react-auth'
import { GooeyText } from '@/components/ui/gooey-text-morphing'
import { MagneticButton } from '@/components/ui/magnetic-button'
import WalletButton from '@/components/WalletButton'
import { VaultAccessModal } from '@/features/vaults/VaultAccessModal'
import { VaultCommunityView } from '@/features/vaults/VaultCommunityView'
import { VaultCreatorModal } from '@/features/vaults/VaultCreatorModal'
import { AgentDashboard } from '@/features/vaults/AgentDashboard'
import { UniswapLiveStat } from '@/components/UniswapLiveStat'
import type { Vault } from '@/features/vaults/types'
import { groupVaultManagers, loadVaults } from '@/lib/vaultStore'

// Visor de docs lazy: el markdown + react-markdown solo cargan al abrir Docs
const DocsView = lazy(() => import('@/components/DocsView'))

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260323_071151_38c3924f-c312-48af-a196-3fbb80e4226f.mp4'
const TRANSITION_VIDEO = '/ctavid2.mp4'
const AMBIENT_AUDIO = '/bgeffect.mp3'
const MOVE_AUDIO = '/moveffect.mp3'

const NAV_LINKS = [
  { label: 'Home', active: true },
  { label: 'Funds', active: false },
  { label: 'Managers', active: false },
  { label: 'How it works', active: false },
  { label: 'Docs', active: false },
]

// Palabras de largo casi idéntico para que el titular centrado no "baile" al mutar
const MORPH_WORDS = ['Fellows.', 'Fortune.', 'Future.', 'Family.']

// Datos reales del proyecto; el acceso al protocolo es permissionless.
const STATS = [
  { value: 'Open', label: 'Permissionless access' },
  { value: '24/7', label: 'Self-custody markets' },
  { value: '25×', label: 'Fund cap per manager stake' },
]

// Pasos del How it works (copy simple; el detalle tecnico vive en docs)
const HOW_STEPS = [
  {
    n: '01',
    title: 'Connect & queue USDG',
    text: 'Connect an EVM wallet, approve USDG and submit a forward-priced deposit request to the Fund contract.',
  },
  {
    n: '02',
    title: 'Managers allocate onchain',
    text: 'Managers can trade only through protocol-approved adapters. Assets remain inside the Fund custody contracts.',
  },
  {
    n: '03',
    title: 'Manager capital absorbs first loss',
    text: 'At settlement, eligible losses are funded from the manager stake up to the protection still available.',
  },
  {
    n: '04',
    title: 'Withdraw through the queue',
    text: 'Shares are self-custodied. Withdrawals execute after the configured cooldown and only against a valid NAV.',
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

function compactUsd(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
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

type NuvemFundHeroProps = {
  audioDisabled?: boolean
}

export default function NuvemFundHero({ audioDisabled = false }: NuvemFundHeroProps) {
  const { user } = usePrivy()
  const { wallets } = useWallets()
  const [phase, setPhase] = useState<Phase>('hero')
  const [vistaTab, setVistaTab] = useState<'funds' | 'managers' | 'how'>('funds')
  const [zoomed, setZoomed] = useState(false)
  const [blurPulse, setBlurPulse] = useState(false)
  const [par, setPar] = useState({ x: 0, y: 0 })
  const [showDocs, setShowDocs] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [selectedVault, setSelectedVault] = useState<Vault | null>(null)
  const [community, setCommunity] = useState<Vault | null>(null)
  const [creatorOpen, setCreatorOpen] = useState(false)
  const [vaults, setVaults] = useState<Vault[]>([])
  const [vaultStatus, setVaultStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [vaultError, setVaultError] = useState<string | null>(null)
  const transVidRef = useRef<HTMLVideoElement>(null)
  const ambientAudioRef = useRef<HTMLAudioElement>(null)
  const moveAudioRef = useRef<HTMLAudioElement>(null)
  const phaseRef = useRef<Phase>('hero')
  const activeExternalWallet = wallets.find((wallet) => wallet.walletClientType !== 'privy')
  const walletAddress = activeExternalWallet?.address || user?.wallet?.address
  const managers = groupVaultManagers(vaults)

  const refreshVaults = useCallback(async () => {
    setVaultStatus((current) => current === 'idle' ? 'loading' : current)
    try {
      const nextVaults = await loadVaults(walletAddress)
      setVaults(nextVaults)
      setVaultError(null)
      setVaultStatus('ready')
    } catch (error) {
      setVaultError(error instanceof Error ? error.message : 'Could not load registered vaults.')
      setVaultStatus('error')
    }
  }, [walletAddress])

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    if (phase === 'hero') return
    void refreshVaults()
    const interval = window.setInterval(() => void refreshVaults(), 12_000)
    return () => window.clearInterval(interval)
  }, [phase, refreshVaults])

  const ambientEnabled = phase === 'hero' && !showDocs && !profileOpen && !audioDisabled

  useEffect(() => {
    const ambient = ambientAudioRef.current
    if (!ambient) return

    if (!ambientEnabled) {
      ambient.pause()
      return
    }

    ambient.volume = 0.35

    const removeUnlockListeners = () => {
      window.removeEventListener('pointerdown', unlockAmbient)
      window.removeEventListener('keydown', unlockAmbient)
    }

    const tryPlayAmbient = () => {
      void ambient.play().then(removeUnlockListeners).catch(() => {})
    }

    const unlockAmbient = (event: Event) => {
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest('[data-audio-skip-ambient]')) return
      tryPlayAmbient()
    }

    // Audible autoplay is commonly blocked. Try immediately, then retry on the
    // first user gesture that is not itself opening a silent view or the camera.
    window.addEventListener('pointerdown', unlockAmbient)
    window.addEventListener('keydown', unlockAmbient)
    tryPlayAmbient()

    return removeUnlockListeners
  }, [ambientEnabled])

  useEffect(() => {
    if (!showDocs && !profileOpen && !audioDisabled) return
    ambientAudioRef.current?.pause()
    const moveAudio = moveAudioRef.current
    if (moveAudio) {
      moveAudio.pause()
      moveAudio.currentTime = 0
    }
  }, [audioDisabled, profileOpen, showDocs])

  useEffect(
    () => () => {
      ambientAudioRef.current?.pause()
      moveAudioRef.current?.pause()
    },
    [],
  )

  const startTransition = (target: 'funds' | 'managers' | 'how' = 'funds') => {
    if (phase !== 'hero') return
    setVistaTab(target)
    const v = transVidRef.current
    const ambientAudio = ambientAudioRef.current
    const moveAudio = moveAudioRef.current
    if (ambientAudio) {
      ambientAudio.pause()
      ambientAudio.currentTime = 0
    }
    if (moveAudio) {
      moveAudio.volume = 0.85
      moveAudio.currentTime = 0
      void moveAudio.play().catch(() => {})
    }
    // El video arranca YA; el contenido del hero hace fade-off por encima y un pulso
    // de blur enmascara la costura entre el frame del fondo y el primer frame del clip.
    setPhase('transition')
    setBlurPulse(true)
    setTimeout(() => setBlurPulse(false), 1200)
    if (v) {
      v.currentTime = 0
      v.play().catch(() => {
        moveAudio?.pause()
        handleEnded()
      }) // si autoplay falla, saltamos directo a la vista final
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
    const moveAudio = moveAudioRef.current
    if (moveAudio) {
      moveAudio.pause()
      moveAudio.currentTime = 0
    }
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
      className={`relative min-h-screen ${phase === 'vista' ? 'overflow-x-hidden overflow-y-auto' : 'overflow-hidden'}`}
      style={{ backgroundColor: 'hsl(201 100% 13%)' }}
      onMouseMove={onMouseMove}
    >
      <audio ref={ambientAudioRef} src={AMBIENT_AUDIO} loop preload="auto" aria-hidden="true" />
      <audio ref={moveAudioRef} src={MOVE_AUDIO} preload="auto" aria-hidden="true" />

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
            {/* NuvemFund logo */}
            <img
              src="/logo.png"
              alt="NuvemFund"
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
                    data-audio-skip-ambient={label === 'Docs' || !!target ? true : undefined}
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

            <WalletButton
              onProfileVisibilityChange={setProfileOpen}
              onCreateVault={() => setCreatorOpen(true)}
              canCreateVault
            />
          </nav>

          <main className="max-w-7xl mx-auto px-6 pt-32 pb-12 flex flex-col items-center text-center">
            <div className="animate-fade-rise mb-8 rounded-full bg-white/20 backdrop-blur-sm border border-gray-900/10 px-5 py-2.5 flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
              <span className="text-sm text-gray-800">Onchain funds. Manager-funded protection.</span>
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
                  data-audio-skip-ambient
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
              <UniswapLiveStat />
            </div>
          </div>
        </div>
      )}

      {/* ---------- VISTA (post-transición): protocolo real sobre las montañas ---------- */}
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

            <WalletButton
              onProfileVisibilityChange={setProfileOpen}
              onCreateVault={() => setCreatorOpen(true)}
              canCreateVault
            />
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
                <AgentDashboard sponsor={walletAddress} />
                {vaultStatus === 'loading' && managers.length === 0 && (
                  <div className="sm:col-span-2 lg:col-span-3 rounded-2xl border border-white/15 bg-black/35 px-6 py-12 text-center text-sm text-white/55 backdrop-blur-md">
                    Reading managers from FundRegistry…
                  </div>
                )}
                {vaultStatus === 'error' && managers.length === 0 && (
                  <div className="sm:col-span-2 lg:col-span-3 rounded-2xl border border-red-200/20 bg-black/40 px-6 py-10 text-center backdrop-blur-md">
                    <div className="text-sm text-red-100">Registered managers could not be loaded.</div>
                    <div className="mt-2 break-words font-mono text-[10px] text-white/35">{vaultError}</div>
                    <button type="button" onClick={() => void refreshVaults()} className="mt-4 cursor-pointer rounded-full border border-white/15 px-4 py-2 text-xs text-white/70 hover:bg-white/10">Retry</button>
                  </div>
                )}
                {vaultStatus === 'ready' && managers.length === 0 && (
                  <div className="sm:col-span-2 lg:col-span-3 rounded-2xl border border-dashed border-white/20 bg-black/30 px-6 py-12 text-center text-sm text-white/55 backdrop-blur-md">
                    No manager has registered a vault on this network yet.
                  </div>
                )}
                {managers.map((m) => (
                  <div
                    key={m.address}
                    className="rounded-2xl bg-black/40 backdrop-blur-md border border-white/20 p-6 text-white transition-transform hover:scale-[1.02] flex flex-col"
                  >
                    <div className="flex items-start justify-between mb-5">
                      <div className="flex items-center gap-3">
                        {m.avatar ? (
                          <img src={m.avatar} alt={m.name} className="w-14 h-14 rounded-full border-2 border-white/30 object-cover" />
                        ) : (
                          <div className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-white/20 bg-white/10 text-lg font-semibold uppercase">
                            {m.name.replace('@', '').slice(0, 1)}
                          </div>
                        )}
                        <div>
                          <div className="font-semibold text-lg leading-tight">{m.name}</div>
                          <div className="text-white/50 font-mono text-[11px]">{m.handle || `${m.address.slice(0, 6)}…${m.address.slice(-4)}`}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-emerald-300 font-semibold text-base leading-none">{m.performance}</div>
                        <div className="text-white/45 text-xs mt-1">{compactUsd(m.protectionUsd)} protected</div>
                      </div>
                    </div>

                    <div className="text-white/50 text-[11px] uppercase tracking-wide mb-2">Manages</div>
                    <ul className="space-y-1.5 mb-5">
                      {m.funds.map((f) => (
                        <li
                          key={f.address}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedVault(f)}
                            className="flex w-full cursor-pointer items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-xs transition-colors hover:bg-white/10"
                          >
                            <span className="font-medium">{f.name}</span>
                            <span className="text-white/60">NAV {f.nav}</span>
                          </button>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-auto flex items-center gap-2 pt-4 border-t border-white/10">
                      {m.xUrl ? (
                        <a href={m.xUrl} target="_blank" rel="noreferrer" className="rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs text-white/65 transition-colors hover:bg-white/12 hover:text-white">
                          X profile
                        </a>
                      ) : (
                        <span className="text-[11px] text-white/35">No public social profile</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {vistaTab === 'funds' && (
              <div className="animate-fade-rise-delay-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 pb-10">
                {vaultStatus === 'loading' && vaults.length === 0 && (
                  <div className="sm:col-span-2 lg:col-span-3 rounded-2xl border border-white/15 bg-black/35 px-6 py-12 text-center text-sm text-white/55 backdrop-blur-md">
                    Reading FundRegistry and indexed activity…
                  </div>
                )}
                {vaultStatus === 'error' && vaults.length === 0 && (
                  <div className="sm:col-span-2 lg:col-span-3 rounded-2xl border border-red-200/20 bg-black/40 px-6 py-10 text-center backdrop-blur-md">
                    <div className="text-sm text-red-100">Registered vaults could not be loaded.</div>
                    <div className="mt-2 break-words font-mono text-[10px] text-white/35">{vaultError}</div>
                    <button type="button" onClick={() => void refreshVaults()} className="mt-4 cursor-pointer rounded-full border border-white/15 px-4 py-2 text-xs text-white/70 hover:bg-white/10">Retry</button>
                  </div>
                )}
                {vaultStatus === 'ready' && vaults.length === 0 && (
                  <div className="sm:col-span-2 lg:col-span-3 rounded-2xl border border-dashed border-white/20 bg-black/30 px-6 py-12 text-center text-sm text-white/55 backdrop-blur-md">
                    <div>No vault is registered on this network yet.</div>
                    <button type="button" onClick={() => setCreatorOpen(true)} className="mt-4 cursor-pointer rounded-full bg-white px-5 py-2.5 text-xs font-medium text-gray-950 transition-transform hover:scale-[1.02]">
                      Create the first vault
                    </button>
                  </div>
                )}
                {vaults.map((f) => {
                  const tier = coverTier(f.coverK)
                  return (
                    <div
                      key={f.address}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${f.name}`}
                      onClick={() => setSelectedVault(f)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelectedVault(f)
                        }
                      }}
                      className="group rounded-2xl bg-black/40 backdrop-blur-md border border-white/20 p-6 text-white cursor-pointer transition-all hover:scale-[1.02] hover:border-white/35 flex flex-col focus:outline-none focus:ring-2 focus:ring-emerald-200/45"
                    >
                      <div className="flex items-start justify-between mb-1 gap-4">
                        <div>
                          <div className="font-semibold text-lg">{f.name}</div>
                          <div className="mt-1 font-mono text-[10px] text-white/35">{f.symbol} · {f.address.slice(0, 6)}…{f.address.slice(-4)}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-emerald-300 font-semibold text-xl leading-none">{f.perfTotal}</div>
                          <div className="text-white/60 text-xs mt-1">{f.perf7d} <span className="text-white/40">· 7d</span></div>
                        </div>
                      </div>
                      <div className="text-white/60 text-sm mb-5">
                        {f.manager.handle || f.manager.name}
                        <span className="mx-2 text-white/30">·</span>
                        {f.members} investors
                      </div>

                      <div className="text-white/50 text-[11px] uppercase tracking-wide mb-2">Recent trades</div>
                      <ul className="space-y-1.5 mb-5 min-h-[54px]">
                        {f.trades.length === 0 && (
                          <li className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-[11px] text-white/35">No indexed trades yet</li>
                        )}
                        {f.trades.map((t) => (
                          <li key={t.id} className="flex items-center gap-2 text-xs">
                            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${t.side === 'B' ? 'bg-emerald-400/25 text-emerald-300' : 'bg-red-400/25 text-red-300'}`}>{t.side}</span>
                            <StockLogo ticker={t.ticker} />
                            <span className="font-medium">{t.ticker}</span>
                            <span className="text-white/60">{t.size}</span>
                            <span className="ml-auto text-white/40">{t.ago}</span>
                          </li>
                        ))}
                      </ul>

                      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 text-sm pt-4 border-t border-white/10">
                        <span className="text-white/80">NAV {f.nav}</span>
                        <div className="flex items-center justify-end gap-2">
                          {f.access.hasAccess && <span className="rounded-full border border-emerald-200/20 bg-emerald-200/10 px-2.5 py-1 text-[10px] font-medium text-emerald-100">Member</span>}
                          {f.access.status === 'setup' && <span className="rounded-full border border-amber-200/20 bg-amber-200/10 px-2.5 py-1 text-[10px] font-medium text-amber-100">Setup</span>}
                          <span className="rounded-full bg-white/10 border px-3 py-1 text-xs font-medium" style={{ borderColor: tier.border, color: tier.text, boxShadow: tier.glow }}>
                            {compactUsd(f.coverK * 1000)} Loss-Protection
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </main>
        </div>
      )}

      <VaultAccessModal
        vault={selectedVault}
        onClose={() => setSelectedVault(null)}
        onOpenCommunity={(vault) => {
          setSelectedVault(null)
          setCommunity(vault)
        }}
        onChanged={() => void refreshVaults()}
      />

      <VaultCommunityView
        vault={community}
        onClose={() => setCommunity(null)}
      />

      <VaultCreatorModal
        open={creatorOpen}
        onClose={() => setCreatorOpen(false)}
        onCreated={() => {
          void refreshVaults()
          window.setTimeout(() => void refreshVaults(), 1_500)
        }}
      />

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

import { useEffect, useRef, useState } from 'react'
import { GooeyText } from '@/components/ui/gooey-text-morphing'
import { MagneticButton } from '@/components/ui/magnetic-button'

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

const AVATARS = [
  'https://i.pravatar.cc/64?img=12',
  'https://i.pravatar.cc/64?img=32',
  'https://i.pravatar.cc/64?img=45',
  'https://i.pravatar.cc/64?img=5',
  'https://i.pravatar.cc/64?img=68',
]

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
const MOCK_FUNDS = [
  { name: 'Alpine Alpha', manager: '@sofia.eth', perf: '+12.4%', nav: '$1.248', cover: '$25k first-loss' },
  { name: 'Blue Chip Basket', manager: '@marchetti', perf: '+7.1%', nav: '$1.091', cover: '$40k first-loss' },
  { name: 'Momentum Seven', manager: '@kenji_t', perf: '+18.9%', nav: '$1.412', cover: '$12k first-loss' },
]

type Phase = 'hero' | 'transition' | 'vista'

export default function RobinFundHero() {
  const [phase, setPhase] = useState<Phase>('hero')
  const [zoomed, setZoomed] = useState(false)
  const [blurPulse, setBlurPulse] = useState(false)
  const [par, setPar] = useState({ x: 0, y: 0 })
  const transVidRef = useRef<HTMLVideoElement>(null)
  const phaseRef = useRef<Phase>('hero')

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const startTransition = () => {
    if (phase !== 'hero') return
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
            <div
              className="h-10 w-10 rounded-full flex items-center justify-center select-none"
              style={{ background: 'linear-gradient(135deg, #ff6a3d 0%, #e6382b 100%)' }}
            >
              <span className="text-white font-bold text-lg" style={{ transform: 'skewX(-8deg)' }}>
                R
              </span>
            </div>

            <div className="hidden md:flex items-center gap-8">
              {NAV_LINKS.map(({ label, active }) => (
                <a
                  key={label}
                  href="#"
                  className={`text-sm transition-colors ${
                    active ? 'text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {label}
                </a>
              ))}
            </div>

            <button
              onClick={startTransition}
              className="bg-gray-900 text-white rounded-full px-6 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
            >
              Explore Funds
            </button>
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
                  onClick={startTransition}
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
            <span className="animate-fade-rise rounded-full bg-black/30 backdrop-blur-sm border border-white/20 text-white/70 text-xs px-4 py-2">
              Mockup — vista previa
            </span>
          </nav>

          <main className="max-w-6xl mx-auto w-full px-6 flex-1 flex flex-col justify-end pb-14">
            <h2 className="animate-fade-rise text-white font-bold text-3xl sm:text-4xl md:text-5xl tracking-[-1px] mb-2 drop-shadow-lg">
              Explore Funds
            </h2>
            <p className="animate-fade-rise-delay text-white/80 text-base sm:text-lg mb-8 drop-shadow">
              Managers with real skin in the game. Pick one, follow their moves.
            </p>

            <div className="animate-fade-rise-delay-2 grid grid-cols-1 sm:grid-cols-3 gap-4">
              {MOCK_FUNDS.map((f) => (
                <div
                  key={f.name}
                  className="rounded-2xl bg-black/25 backdrop-blur-md border border-white/20 p-5 text-white cursor-pointer transition-transform hover:scale-[1.02]"
                >
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="font-semibold">{f.name}</span>
                    <span className="text-emerald-300 font-medium text-sm">{f.perf} · 30d</span>
                  </div>
                  <div className="text-white/60 text-sm mb-4">{f.manager}</div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/80">NAV {f.nav}</span>
                    <span className="rounded-full bg-white/15 border border-white/20 px-3 py-1 text-xs">
                      {f.cover}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </main>
        </div>
      )}
    </div>
  )
}

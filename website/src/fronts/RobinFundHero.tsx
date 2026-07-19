const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260323_071151_38c3924f-c312-48af-a196-3fbb80e4226f.mp4'

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

// Datos reales del proyecto (docs/SPEC.md): cap 25× por stake (§13 K_MAX),
// 120+ países elegibles (emisor RHJ), mercados on-chain self-custody 24/7,
// performance fee default 20% con high-water mark (§7.2/§13).
const STATS = [
  { value: '120+', label: 'Eligible countries' },
  { value: '24/7', label: 'Self-custody markets' },
  { value: '25×', label: 'Fund cap per manager stake' },
  { value: '20%', label: 'Performance fee, HWM-gated' },
]

export default function RobinFundHero() {
  return (
    <div
      className="relative min-h-screen overflow-hidden"
      style={{ backgroundColor: 'hsl(201 100% 13%)' }}
    >
      {/* Vídeo de fondo a pantalla completa */}
      <video
        className="absolute inset-0 w-full h-full object-cover"
        src={VIDEO_URL}
        autoPlay
        loop
        muted
        playsInline
      />

      {/* min-h-screen: el bottom-8 de la barra de stats ancla al fondo del viewport */}
      <div className="relative z-10 min-h-screen">
        {/* Navegación */}
        <nav className="max-w-7xl mx-auto px-6 pt-6 flex items-center justify-between">
          {/* Logo RobinFund */}
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

          <button className="bg-gray-900 text-white rounded-full px-6 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]">
            Explore Funds
          </button>
        </nav>

        {/* Hero centrado */}
        <main className="max-w-7xl mx-auto px-6 pt-32 pb-12 flex flex-col items-center text-center">
          {/* Badge de social proof */}
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

          {/* Headline — la tesis del protocolo (SPEC D3) */}
          <h1 className="animate-fade-rise font-bold text-5xl sm:text-6xl md:text-[4.9rem] leading-[0.95] tracking-[-1.5px] text-gray-900 max-w-5xl">
            Stocks. Social. Skin in the game.
          </h1>

          {/* Subtexto */}
          <p className="animate-fade-rise-delay text-base sm:text-lg text-gray-800 max-w-2xl mt-6 leading-relaxed">
            Social funds on tokenized stocks. Your first losses come out of the manager's stake.
          </p>

          {/* CTA */}
          <button className="animate-fade-rise-delay-2 mt-9 bg-gray-900 text-white rounded-full px-12 py-4 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]">
            Explore Funds
          </button>
        </main>

        {/* Barra de stats */}
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
    </div>
  )
}

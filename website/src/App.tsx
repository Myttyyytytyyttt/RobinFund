import { useEffect, useState } from 'react'
import VexHero from './fronts/VexHero'
import ClubXHero from './fronts/ClubXHero'

const FRONTS = {
  vex: { title: 'VEX', component: VexHero },
  clubx: { title: 'ClubX', component: ClubXHero },
} as const

type FrontKey = keyof typeof FRONTS
const KEYS = Object.keys(FRONTS) as FrontKey[]

function initialFront(): FrontKey {
  const q = new URLSearchParams(window.location.search).get('front')
  if (q && q in FRONTS) return q as FrontKey
  const saved = localStorage.getItem('front')
  if (saved && saved in FRONTS) return saved as FrontKey
  return 'vex'
}

/**
 * Shell de comparación de fronts: cambia con la tecla F, con el selector
 * escondido (esquina inferior derecha, aparece al pasar el ratón) o por URL
 * (?front=vex | ?front=clubx). La elección persiste en localStorage.
 */
export default function App() {
  const [front, setFront] = useState<FrontKey>(initialFront)

  useEffect(() => {
    localStorage.setItem('front', front)
    document.title = FRONTS[front].title
  }, [front])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      setFront((f) => KEYS[(KEYS.indexOf(f) + 1) % KEYS.length])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const Front = FRONTS[front].component

  return (
    <>
      <Front key={front} />

      {/* Selector escondido: invisible hasta hover; también tecla F */}
      <div className="fixed bottom-3 right-3 z-50 opacity-0 hover:opacity-100 transition-opacity duration-200">
        <div className="flex items-center gap-1 rounded-full bg-black/70 backdrop-blur-sm px-2 py-1.5 border border-white/20">
          {KEYS.map((k) => (
            <button
              key={k}
              onClick={() => setFront(k)}
              className={`px-3 py-1 rounded-full text-xs cursor-pointer transition-colors ${
                k === front ? 'bg-white text-black' : 'text-white/70 hover:text-white'
              }`}
            >
              {FRONTS[k].title}
            </button>
          ))}
          <span className="text-white/40 text-[10px] px-1 select-none">F</span>
        </div>
      </div>
    </>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const BG_VIDEO =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260323_071151_38c3924f-c312-48af-a196-3fbb80e4226f.mp4'

// Fuente única de verdad: los .md reales del repo (../docs), importados raw por Vite.
const RAW = import.meta.glob('../../../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

type Doc = { id: string; title: string; content: string; headings: Heading[] }
type Heading = { level: 2 | 3; text: string; slug: string }

// Orden y títulos legibles de las páginas
const PAGE_META: Record<string, string> = {
  'SPEC.md': 'Protocol Spec',
  'ROADMAP.md': 'Build Roadmap',
}
const PAGE_ORDER = ['SPEC.md', 'ROADMAP.md']

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
}

/** Extrae ## y ### del markdown, ignorando lo que hay dentro de fences ``` */
function parseHeadings(md: string): Heading[] {
  const out: Heading[] = []
  const seen = new Set<string>()
  let inFence = false
  for (const line of md.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{2,3})\s+(.*)$/.exec(line)
    if (!m) continue
    const level = m[1].length as 2 | 3
    const text = m[2].replace(/\s*#+\s*$/, '').trim()
    let slug = slugify(text)
    let i = 1
    while (seen.has(slug)) slug = `${slugify(text)}-${i++}`
    seen.add(slug)
    out.push({ level, text, slug })
  }
  return out
}

const DOCS: Doc[] = PAGE_ORDER.map((file) => {
  const key = Object.keys(RAW).find((k) => k.endsWith('/' + file))
  const content = key ? RAW[key] : ''
  return { id: file, title: PAGE_META[file] ?? file, content, headings: parseHeadings(content) }
}).filter((d) => d.content)

function textOf(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as any).props.children)
  return ''
}

type SearchHit = { docId: string; docTitle: string; heading: string; slug: string; snippet: string }

export default function DocsView({ onClose }: { onClose: () => void }) {
  const [activeDoc, setActiveDoc] = useState(DOCS[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [activeSlug, setActiveSlug] = useState('')
  const [toc, setToc] = useState<Heading[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const articleRef = useRef<HTMLElement>(null)

  const doc = useMemo(() => DOCS.find((d) => d.id === activeDoc) ?? DOCS[0], [activeDoc])

  // Índice del sidebar derivado del DOM ya renderizado (ids = los anclajes reales,
  // sin re-parsear markdown, que se desincroniza con los fences de código)
  useEffect(() => {
    const art = articleRef.current
    if (!art) return
    const nodes = art.querySelectorAll('h2, h3')
    setToc(
      Array.from(nodes).map((el) => ({
        level: el.tagName === 'H3' ? 3 : 2,
        text: el.textContent ?? '',
        slug: el.id,
      })),
    )
  }, [activeDoc])

  // Búsqueda global sobre todos los docs, agrupada por heading
  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const res: SearchHit[] = []
    for (const d of DOCS) {
      const lines = d.content.split('\n')
      let current: Heading | null = null
      let inFence = false
      for (const line of lines) {
        if (line.trimStart().startsWith('```')) inFence = !inFence
        const hm = !inFence && /^(#{2,3})\s+(.*)$/.exec(line)
        if (hm) {
          const text = hm[2].replace(/\s*#+\s*$/, '').trim()
          current = d.headings.find((h) => h.text === text) ?? null
          continue
        }
        if (line.toLowerCase().includes(q)) {
          const idx = line.toLowerCase().indexOf(q)
          const snippet = line.slice(Math.max(0, idx - 30), idx + 60).trim()
          res.push({
            docId: d.id,
            docTitle: d.title,
            heading: current?.text ?? d.title,
            slug: current?.slug ?? '',
            snippet,
          })
          if (res.length >= 40) return res
        }
      }
    }
    return res
  }, [query])

  const goTo = (docId: string, slug: string) => {
    setActiveDoc(docId)
    setQuery('')
    setActiveSlug(slug)
    requestAnimationFrame(() => {
      const el = slug ? document.getElementById(slug) : null
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      else scrollRef.current?.scrollTo({ top: 0 })
    })
  }

  // Reset del scroll al cambiar de página
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [activeDoc])

  const headingComponent =
    (Tag: 'h1' | 'h2' | 'h3' | 'h4') =>
    ({ children }: { children?: React.ReactNode }) => {
      const id = slugify(textOf(children))
      return <Tag id={id}>{children}</Tag>
    }

  return (
    <div className="fixed inset-0 z-[60] text-gray-200 flex flex-col overflow-hidden">
      {/* Fondo: mismo vídeo del lago, muy oscurecido para máxima legibilidad */}
      <video
        className="absolute inset-0 w-full h-full object-cover -z-10"
        src={BG_VIDEO}
        autoPlay
        loop
        muted
        playsInline
        style={{ filter: 'brightness(0.22) saturate(0.85)' }}
      />
      <div className="absolute inset-0 -z-10 bg-[#050d12]/85 backdrop-blur-xl" />

      {/* Topbar */}
      <header className="flex items-center gap-4 px-4 sm:px-6 h-16 border-b border-white/10 shrink-0 bg-black/20">
        <button onClick={onClose} className="flex items-center gap-2 cursor-pointer group shrink-0">
          <img src="/logo.png" alt="Neverless" className="h-7 w-auto" />
          <span className="font-semibold text-white group-hover:text-white/80 transition-colors">Neverless Docs</span>
        </button>

        <div className="relative flex-1 max-w-md ml-auto">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the docs…"
            className="w-full bg-white/5 border border-white/15 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/40"
          />
          <svg className="absolute left-3 top-2.5 w-4 h-4 text-white/40" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>

          {hits.length > 0 && (
            <div className="absolute top-11 left-0 right-0 max-h-96 overflow-y-auto rounded-lg bg-[#12242f] border border-white/15 shadow-2xl py-1 z-10">
              {hits.map((h, i) => (
                <button
                  key={i}
                  onClick={() => goTo(h.docId, h.slug)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 transition-colors block"
                >
                  <div className="text-xs text-emerald-300/80">
                    {h.heading && h.heading !== h.docTitle ? `${h.docTitle} · ${h.heading}` : h.docTitle}
                  </div>
                  <div className="text-sm text-white/70 truncate">…{h.snippet}…</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="shrink-0 rounded-full border border-white/20 text-white/70 hover:text-white text-sm px-4 py-1.5 cursor-pointer transition-colors"
        >
          ← Back to site
        </button>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar: índices y subíndices */}
        <aside className="hidden md:block w-72 shrink-0 border-r border-white/10 overflow-y-auto py-6 px-4">
          {DOCS.map((d) => (
            <div key={d.id} className="mb-6">
              <button
                onClick={() => goTo(d.id, '')}
                className={`w-full text-left text-sm font-semibold mb-2 transition-colors ${
                  d.id === activeDoc ? 'text-white' : 'text-white/70 hover:text-white'
                }`}
              >
                {d.title}
              </button>
              {d.id === activeDoc && (
                <ul className="space-y-0.5 border-l border-white/10">
                  {toc.map((h) => (
                    <li key={h.slug}>
                      <button
                        onClick={() => goTo(d.id, h.slug)}
                        className={`block w-full text-left text-[13px] py-1 pr-2 transition-colors border-l -ml-px ${
                          h.level === 3 ? 'pl-7' : 'pl-4'
                        } ${
                          activeSlug === h.slug
                            ? 'border-emerald-300 text-white'
                            : 'border-transparent text-white/50 hover:text-white/90'
                        }`}
                      >
                        {h.text}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </aside>

        {/* Contenido */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <article
            ref={articleRef}
            className="prose prose-invert max-w-3xl mx-auto px-5 sm:px-8 py-10
                       prose-headings:scroll-mt-20 prose-headings:font-semibold
                       prose-h1:text-3xl prose-h2:text-2xl prose-h2:mt-12 prose-h2:pb-2 prose-h2:border-b prose-h2:border-white/10
                       prose-a:text-emerald-300 prose-code:text-emerald-200 prose-code:before:content-none prose-code:after:content-none
                       prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
                       prose-pre:bg-black/40 prose-pre:border prose-pre:border-white/10
                       prose-th:text-white prose-strong:text-white prose-blockquote:border-emerald-400/40"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: headingComponent('h1'),
                h2: headingComponent('h2'),
                h3: headingComponent('h3'),
                h4: headingComponent('h4'),
                // Los links internos entre docs (SPEC.md, ROADMAP.md…) navegan dentro del visor
                a: ({ href, children }) => {
                  const file = href?.split('/').pop()?.split('#')[0]
                  if (file && DOCS.some((d) => d.id === file)) {
                    const anchor = href?.split('#')[1] ?? ''
                    return (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault()
                          goTo(file, anchor)
                        }}
                      >
                        {children}
                      </a>
                    )
                  }
                  // Enlace a un .md que ya no está en el visor (p. ej. REVIEW.md): texto plano
                  if (file && /\.md$/i.test(file)) {
                    return <span className="text-white/80">{children}</span>
                  }
                  return (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  )
                },
              }}
            >
              {doc?.content ?? ''}
            </ReactMarkdown>
          </article>
        </div>
      </div>
    </div>
  )
}

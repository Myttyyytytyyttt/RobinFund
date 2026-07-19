import { useEffect, useState, type ReactNode } from 'react'

interface FadeInProps {
  delay?: number
  duration?: number
  className?: string
  children: ReactNode
}

/**
 * Wrapper que arranca en opacity 0 y transiciona a 1 tras `delay` ms
 * (setTimeout + estado), con duración configurable vía transitionDuration inline.
 */
export default function FadeIn({ delay = 0, duration = 1000, className = '', children }: FadeInProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay)
    return () => clearTimeout(t)
  }, [delay])

  return (
    <div
      className={`transition-opacity ${className}`}
      style={{ opacity: visible ? 1 : 0, transitionDuration: `${duration}ms` }}
    >
      {children}
    </div>
  )
}

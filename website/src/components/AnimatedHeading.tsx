import { useEffect, useState } from 'react'

interface AnimatedHeadingProps {
  text: string
  className?: string
  initialDelay?: number
  charDelay?: number
}

/**
 * Divide `text` por \n en líneas y cada línea en caracteres. Cada carácter es un
 * <span> inline-block que entra desde opacity 0 / translateX(-18px) con delay
 * escalonado: (lineIndex * lineLength * charDelay) + (charIndex * charDelay).
 * Los espacios se renderizan como  .
 */
export default function AnimatedHeading({
  text,
  className = '',
  initialDelay = 200,
  charDelay = 30,
}: AnimatedHeadingProps) {
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setAnimate(true), initialDelay)
    return () => clearTimeout(t)
  }, [initialDelay])

  const lines = text.split('\n')

  return (
    <h1 className={className} style={{ letterSpacing: '-0.04em' }}>
      {lines.map((line, lineIndex) => (
        <span key={lineIndex} className="block">
          {line.split('').map((char, charIndex) => (
            <span
              key={charIndex}
              className="inline-block"
              style={{
                opacity: animate ? 1 : 0,
                transform: animate ? 'translateX(0)' : 'translateX(-18px)',
                transitionProperty: 'opacity, transform',
                transitionDuration: '500ms',
                transitionDelay: `${lineIndex * line.length * charDelay + charIndex * charDelay}ms`,
              }}
            >
              {char === ' ' ? ' ' : char}
            </span>
          ))}
        </span>
      ))}
    </h1>
  )
}

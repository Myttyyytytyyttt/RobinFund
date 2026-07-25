import { useEffect, useState } from 'react'
import {
  loadUniswapLiveSnapshot,
  uniswapExplorerUrl,
  type UniswapLiveSnapshot,
} from '@/lib/uniswapLive'

const compactBlock = (value: bigint) => {
  if (value >= 1_000_000n) return `#${(Number(value) / 1_000_000).toFixed(2)}m`
  if (value >= 1_000n) return `#${(Number(value) / 1_000).toFixed(1)}k`
  return `#${value}`
}

export function UniswapLiveStat() {
  const [snapshot, setSnapshot] = useState<UniswapLiveSnapshot | null>(null)

  useEffect(() => {
    let active = true
    const refresh = async () => {
      const next = await loadUniswapLiveSnapshot().catch(() => null)
      if (active && next) setSnapshot(next)
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 12_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const href = snapshot ? uniswapExplorerUrl(snapshot) : null
  const ready = snapshot?.integrationReady ?? false
  const supportedChain = snapshot?.chainId === 4663
  const value = !supportedChain && snapshot
    ? 'Standby'
    : snapshot?.executedSwaps
    ? `${snapshot.executedSwaps} swap${snapshot.executedSwaps === 1 ? '' : 's'}`
    : ready
      ? 'Ready'
      : snapshot?.latestBlock != null
        ? compactBlock(snapshot.latestBlock)
        : 'Live'
  const label = snapshot
    ? !supportedChain
      ? 'Uniswap requires Robinhood mainnet'
      : snapshot.lastExecution
      ? `Uniswap · confirmed on ${snapshot.network}`
      : ready
        ? `Uniswap CLASSIC · ${snapshot.network}`
        : `Uniswap data · ${snapshot.network}`
    : 'Loading Uniswap data…'

  const content = (
    <>
      <span className="flex items-center gap-2 text-white text-3xl sm:text-4xl font-light tracking-tight">
        <span
          className={`h-2 w-2 rounded-full ${snapshot?.latestBlock != null ? 'bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.9)]' : 'bg-white/35'}`}
          aria-hidden="true"
        />
        {value}
      </span>
      <span className="text-white/70 text-sm">{label}</span>
      {snapshot?.latestBlock != null && snapshot.executedSwaps > 0 && (
        <span className="text-[10px] text-white/45">block {snapshot.latestBlock.toString()}</span>
      )}
    </>
  )

  return href
    ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="flex flex-col items-center text-center gap-1 rounded-xl outline-none transition-colors hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/70"
          aria-label={`${label}. Open the latest confirmed swap.`}
        >
          {content}
        </a>
      )
    : (
        <div className="flex flex-col items-center text-center gap-1" aria-live="polite">
          {content}
        </div>
      )
}

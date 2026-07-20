import { usePrivy } from '@privy-io/react-auth'

const short = (addr?: string) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '')

/** Botón de conexión de wallet (Privy, solo EVM, Robinhood Chain por defecto). */
export default function ConnectButton() {
  const { ready, authenticated, login, logout, user } = usePrivy()

  if (!ready) {
    return (
      <button
        disabled
        className="bg-gray-900/60 text-white/70 rounded-full px-6 py-2.5 text-sm cursor-wait"
      >
        …
      </button>
    )
  }

  if (authenticated) {
    return (
      <button
        onClick={logout}
        title="Disconnect"
        className="group bg-gray-900 text-white rounded-full px-6 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
      >
        <span className="group-hover:hidden font-mono">{short(user?.wallet?.address)}</span>
        <span className="hidden group-hover:inline">Disconnect</span>
      </button>
    )
  }

  return (
    <button
      onClick={login}
      className="bg-gray-900 text-white rounded-full px-6 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
    >
      Connect
    </button>
  )
}

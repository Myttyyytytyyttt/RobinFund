import { useEffect, useState } from 'react'
import { usePrivy, useLogin, useWallets } from '@privy-io/react-auth'
import { profileStore, validateUsername, type Profile } from '@/lib/profileStore'

const short = (addr?: string) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '')

export default function WalletButton() {
  const { ready, authenticated, logout, user, linkTwitter } = usePrivy()
  const address = user?.wallet?.address

  // Cuenta ACTIVA en la extensión (Rabby/MetaMask…): useWallets es reactivo a
  // accountsChanged, mientras que user.wallet.address es la que FIRMÓ el login.
  // Si difieren, la sesión está desincronizada de la extensión.
  const { wallets } = useWallets()
  const injected = wallets.find((w) => w.walletClientType !== 'privy')
  const activeAddr = injected?.address
  const walletMismatch =
    authenticated && !!activeAddr && !!address && activeAddr.toLowerCase() !== address.toLowerCase()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [showReg, setShowReg] = useState(false)
  const [firstTime, setFirstTime] = useState(false)

  // Cargar el perfil local cuando cambia la wallet conectada
  useEffect(() => {
    setProfile(profileStore.get(address))
  }, [address])

  // Abre el registro tras el login SOLO si aún no tiene username guardado.
  // `isNewUser` de Privy es la señal cross-device de "¿ya estuvo aquí?".
  const { login } = useLogin({
    onComplete: ({ user, isNewUser }) => {
      const addr = user?.wallet?.address
      const existing = profileStore.get(addr)
      setProfile(existing)
      if (!existing) {
        setFirstTime(isNewUser)
        setShowReg(true)
      }
    },
  })

  // Cambio de cuenta en la extensión → re-autenticar con la wallet nueva.
  // logout + login: la sesión de Privy pertenece a la wallet que firmó; no es
  // transferible, así que la nueva cuenta debe firmar su propio login.
  const switchToActive = async () => {
    await logout()
    setProfile(null)
    login()
  }

  if (!ready) {
    return <button disabled className="bg-gray-900/60 text-white/70 rounded-full px-6 py-2.5 text-sm cursor-wait">…</button>
  }

  // La extensión cambió de cuenta: la sesión ya no representa a la wallet activa
  if (walletMismatch) {
    return (
      <button
        onClick={switchToActive}
        title={`Session: ${short(address)} — extension: ${short(activeAddr)}`}
        className="flex items-center gap-2 rounded-full border border-amber-400/60 bg-amber-400/10 text-amber-200 px-5 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
      >
        <span className="w-2 h-2 rounded-full bg-amber-300 animate-pulse" />
        Switch to {short(activeAddr)}
      </button>
    )
  }

  // No conectado
  if (!authenticated) {
    return (
      <button
        onClick={login}
        className="bg-gray-900 text-white rounded-full px-6 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
      >
        Connect
      </button>
    )
  }

  // Conectado pero sin perfil completado → invita a terminar
  if (!profile) {
    return (
      <>
        <button
          onClick={() => setShowReg(true)}
          className="bg-gray-900 text-white rounded-full px-6 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
        >
          Finish setup
        </button>
        {showReg && (
          <RegisterModal
            firstTime={firstTime}
            address={address!}
            currentTwitter={user?.twitter?.username ?? undefined}
            onLinkTwitter={linkTwitter}
            onDone={(p) => {
              setProfile(p)
              setShowReg(false)
            }}
            onCancel={() => setShowReg(false)}
          />
        )}
      </>
    )
  }

  // Conectado y registrado → muestra el username; hover para desconectar
  return (
    <button
      onClick={logout}
      title="Disconnect"
      className="group flex items-center gap-2 bg-gray-900 text-white rounded-full pl-2 pr-5 py-1.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
    >
      <span className="w-6 h-6 rounded-full bg-white/15 flex items-center justify-center text-xs font-semibold uppercase">
        {profile.username.slice(0, 1)}
      </span>
      <span className="group-hover:hidden">@{profile.username}</span>
      <span className="hidden group-hover:inline">Disconnect</span>
    </button>
  )
}

function RegisterModal({
  firstTime,
  address,
  currentTwitter,
  onLinkTwitter,
  onDone,
  onCancel,
}: {
  firstTime: boolean
  address: string
  currentTwitter?: string
  onLinkTwitter: () => unknown
  onDone: (p: Profile) => void
  onCancel: () => void
}) {
  const [username, setUsername] = useState('')
  const [twitter, setTwitter] = useState<string | undefined>(currentTwitter)
  const [twitterErr, setTwitterErr] = useState<string | null>(null)
  const err = username ? validateUsername(username) : null
  const valid = !err && username.trim().length >= 3

  const linkX = async () => {
    setTwitterErr(null)
    try {
      await Promise.resolve(onLinkTwitter())
      // El handle enlazado aparece en user.twitter tras el flujo; lo leemos del store de Privy
      // vía un pequeño delay optimista; si no, se guardará en el siguiente render.
    } catch {
      setTwitterErr('X sign-in isn’t enabled for this app yet.')
    }
  }

  // Si Privy actualiza el twitter enlazado mientras el modal está abierto
  useEffect(() => {
    if (currentTwitter) setTwitter(currentTwitter)
  }, [currentTwitter])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-2xl bg-[#0d1b24] border border-white/15 p-7 text-white shadow-2xl">
        <div className="flex items-center gap-2 mb-1">
          <img src="/logo.png" alt="Neverless" className="h-6 w-auto" />
          <span className="text-white/50 text-xs font-mono">{short(address)}</span>
        </div>
        <h2 className="text-xl font-semibold mb-1">
          {firstTime ? 'Welcome to Neverless' : 'Complete your profile'}
        </h2>
        <p className="text-white/60 text-sm mb-6">Pick a username so managers and investors can find you.</p>

        {/* Username */}
        <label className="block text-sm text-white/70 mb-1">Username</label>
        <div className="flex items-center rounded-lg bg-white/5 border border-white/15 focus-within:border-white/40 px-3">
          <span className="text-white/40">@</span>
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="yourname"
            className="flex-1 bg-transparent py-2.5 px-1 text-sm focus:outline-none placeholder-white/30"
          />
        </div>
        <div className="h-5 mt-1 text-xs">
          {err && username ? <span className="text-red-300">{err}</span> : <span className="text-white/30">3–20 chars · letters, numbers, _</span>}
        </div>

        {/* X (Twitter) opcional */}
        <label className="block text-sm text-white/70 mt-3 mb-1">
          X account <span className="text-white/40">(optional)</span>
        </label>
        {twitter ? (
          <div className="flex items-center gap-2 rounded-lg bg-white/5 border border-white/15 px-3 py-2.5 text-sm">
            <XIcon />
            <span>@{twitter}</span>
            <span className="ml-auto text-emerald-300 text-xs">Linked</span>
          </div>
        ) : (
          <button
            onClick={linkX}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-white/5 border border-white/15 hover:bg-white/10 px-3 py-2.5 text-sm cursor-pointer transition-colors"
          >
            <XIcon /> Connect X
          </button>
        )}
        {twitterErr && <div className="text-xs text-amber-300/80 mt-1">{twitterErr}</div>}

        {/* Acciones */}
        <div className="flex gap-3 mt-7">
          <button
            onClick={onCancel}
            className="flex-1 rounded-full border border-white/15 text-white/70 hover:text-white py-2.5 text-sm cursor-pointer transition-colors"
          >
            Later
          </button>
          <button
            disabled={!valid}
            onClick={() => onDone(profileStore.save(address, { username: username.trim(), twitter }))}
            className="flex-1 rounded-full bg-white text-gray-900 font-medium py-2.5 text-sm cursor-pointer transition-transform enabled:hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create profile
          </button>
        </div>
      </div>
    </div>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.2l7.3-8.3L2.8 2h6.4l4.4 5.9L18.9 2zm-1.1 18h1.7L7.6 3.9H5.8L17.8 20z" />
    </svg>
  )
}

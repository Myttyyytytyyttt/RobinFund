import { useCallback, useEffect, useRef, useState } from 'react'
import { usePrivy, useLogin, useWallets } from '@privy-io/react-auth'
import { profileStore, validateUsername, type Profile } from '@/lib/profileStore'
import type { EthereumProvider } from '@/lib/supabase'
import ProfileView from './ProfileView'

const short = (addr?: string) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '')

type WalletButtonProps = {
  onProfileVisibilityChange?: (visible: boolean) => void
  onCreateVault?: () => void
  canCreateVault?: boolean
}

export default function WalletButton({
  onProfileVisibilityChange,
  onCreateVault,
  canCreateVault = false,
}: WalletButtonProps) {
  const { ready, authenticated, logout, user, linkTwitter } = usePrivy()
  const address = user?.wallet?.address
  const twitterAvatarUrl = user?.twitter?.profilePictureUrl?.replace('_normal', '')

  const [menuOpen, setMenuOpen] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onProfileVisibilityChange?.(showProfile)
  }, [onProfileVisibilityChange, showProfile])

  // Cerrar el dropdown al clicar fuera
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  // Cuenta ACTIVA en la extensión (Rabby/MetaMask…): useWallets es reactivo a
  // accountsChanged, mientras que user.wallet.address es la que FIRMÓ el login.
  // Si difieren, la sesión está desincronizada de la extensión.
  const { wallets } = useWallets()
  const injected = wallets.find((w) => w.walletClientType !== 'privy')
  const activeAddr = injected?.address
  const profileWallet = wallets.find(
    (wallet) => wallet.address.toLowerCase() === address?.toLowerCase(),
  )
  const getProfileProvider = useCallback(async (): Promise<EthereumProvider> => {
    if (!profileWallet) throw new Error('The wallet used to sign in is not connected.')
    const provider = await profileWallet.getEthereumProvider()
    return {
      address: profileWallet.address,
      request: provider.request.bind(provider),
      on: provider.on.bind(provider),
      removeListener: provider.removeListener.bind(provider),
    } as EthereumProvider
  }, [profileWallet])
  const walletMismatch =
    authenticated && !!activeAddr && !!address && activeAddr.toLowerCase() !== address.toLowerCase()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [showReg, setShowReg] = useState(false)
  const [firstTime, setFirstTime] = useState(false)

  // Pinta la caché primero y reconcilia después con el perfil cross-device.
  useEffect(() => {
    let cancelled = false
    setProfile(profileStore.get(address))
    void profileStore.load(address).then((loaded) => {
      if (!cancelled) setProfile(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [address])

  // Privy is the source of truth for the linked X account. When OAuth finishes
  // (or an existing Privy user returns), mirror the handle into our app profile.
  useEffect(() => {
    const twitter = user?.twitter?.username
    if (
      !address ||
      !profile ||
      profile.address.toLowerCase() !== address.toLowerCase() ||
      !twitter ||
      profile.twitter === twitter
    ) return
    const next = profileStore.saveLocal(address, { username: profile.username, twitter })
    setProfile(next)
    let cancelled = false
    void profileStore
      .saveIfAuthenticated(address, { username: profile.username, twitter })
      .then((saved) => {
        if (!cancelled) setProfile(saved)
      })
      .catch((error: unknown) => {
        console.warn(
          'NuvemFund X sync will retry after the next authenticated profile write.',
          error instanceof Error ? error.message : error,
        )
      })
    return () => {
      cancelled = true
    }
  }, [address, profile?.address, profile?.twitter, profile?.username, user?.twitter?.username])

  // Abre el registro tras el login SOLO si aún no tiene username guardado.
  // `isNewUser` de Privy es la señal cross-device de "¿ya estuvo aquí?".
  const { login } = useLogin({
    onComplete: ({ user, isNewUser }) => {
      setLoginError(null)
      const addr = user?.wallet?.address
      const existing = profileStore.get(addr)
      setProfile(existing)
      void profileStore.load(addr).then((loaded) => {
        setProfile(loaded)
        if (!loaded) {
          setFirstTime(isNewUser)
          setShowReg(true)
        }
      })
    },
    onError: (error) => {
      setLoginError(String(error))
    },
  })

  // Cambio de cuenta en la extensión → re-autenticar con la wallet nueva.
  // logout + login: la sesión de Privy pertenece a la wallet que firmó; no es
  // transferible, así que la nueva cuenta debe firmar su propio login.
  const switchToActive = async () => {
    await Promise.allSettled([logout(), profileStore.signOut()])
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
      <div className="relative">
        <button
          onClick={() => {
            setLoginError(null)
            login()
          }}
          className="bg-gray-900 text-white rounded-full px-6 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
        >
          Connect
        </button>
        {loginError && (
          <div role="alert" className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-amber-200/30 bg-[#111b21]/95 px-3 py-2.5 text-left text-[11px] leading-4 text-amber-50 shadow-2xl backdrop-blur-xl">
            Wallet connection failed. Use an external wallet that supports custom EVM networks, such as MetaMask or Rabby, for Robinhood Chain.
            {import.meta.env.DEV && <div className="mt-1 text-white/45">Localhost must also be listed in this Privy app&apos;s allowed origins.</div>}
          </div>
        )}
      </div>
    )
  }

  // El perfil social es opcional para el protocolo: una wallet conectada puede
  // crear un vault aunque todavía no haya elegido username.
  if (!profile) {
    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((value) => !value)}
          className="flex items-center gap-2 bg-gray-900 text-white rounded-full px-4 py-2.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
        >
          <span className="h-2 w-2 rounded-full bg-emerald-300" />
          {short(address)}
          <svg viewBox="0 0 24 24" className={`w-3.5 h-3.5 text-white/60 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none">
            <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {menuOpen && (
          <div className="absolute right-0 mt-2 w-52 rounded-xl bg-[#0d1b24] border border-white/15 shadow-2xl overflow-hidden py-1 z-50">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                setShowReg(true)
              }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-white/90 hover:bg-white/5 cursor-pointer transition-colors"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-white/60" fill="none">
                <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
                <path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Complete profile
            </button>
            {canCreateVault && onCreateVault && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onCreateVault()
                }}
                className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-white/90 hover:bg-white/5 cursor-pointer transition-colors"
              >
                <VaultIcon />
                Create a vault
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                void Promise.allSettled([logout(), profileStore.signOut()])
              }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-300/90 hover:bg-white/5 cursor-pointer transition-colors"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none">
                <path d="M15 17l5-5-5-5M20 12H9M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Disconnect
            </button>
          </div>
        )}
        {showReg && (
          <RegisterModal
            firstTime={firstTime}
            address={address!}
            currentTwitter={user?.twitter?.username ?? undefined}
            onLinkTwitter={linkTwitter}
            onSave={async (data) =>
              profileStore.save(address!, data, await getProfileProvider())
            }
            onDone={(p) => {
              setProfile(p)
              setShowReg(false)
            }}
            onCancel={() => setShowReg(false)}
          />
        )}
      </div>
    )
  }

  // Conectado y registrado → trigger de ancho fijo (no layout-shift) + dropdown
  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-2 bg-gray-900 text-white rounded-full pl-2 pr-4 py-1.5 text-sm cursor-pointer transition-transform hover:scale-[1.03] active:scale-[0.97]"
      >
        <span className="w-6 h-6 rounded-full bg-white/15 flex items-center justify-center text-xs font-semibold uppercase">
          {profile.username.slice(0, 1)}
        </span>
        <span>@{profile.username}</span>
        <svg
          viewBox="0 0 24 24"
          className={`w-3.5 h-3.5 text-white/60 transition-transform ${menuOpen ? 'rotate-180' : ''}`}
          fill="none"
        >
          <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {menuOpen && (
        <div className="absolute right-0 mt-2 w-48 rounded-xl bg-[#0d1b24] border border-white/15 shadow-2xl overflow-hidden py-1 z-50">
          <button
            onClick={() => {
              setMenuOpen(false)
              setShowProfile(true)
            }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-white/90 hover:bg-white/5 cursor-pointer transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-white/60" fill="none">
              <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
              <path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Profile
          </button>
          {canCreateVault && onCreateVault && (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onCreateVault()
              }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-white/90 hover:bg-white/5 cursor-pointer transition-colors"
            >
              <VaultIcon />
              Create a vault
            </button>
          )}
          <button
            onClick={() => {
              setMenuOpen(false)
              setProfile(null)
              void Promise.allSettled([logout(), profileStore.signOut()])
            }}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-300/90 hover:bg-white/5 cursor-pointer transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none">
              <path d="M15 17l5-5-5-5M20 12H9M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Disconnect
          </button>
        </div>
      )}

      {showProfile && (
        <ProfileView
          profile={profile}
          avatarUrl={twitterAvatarUrl}
          onClose={() => setShowProfile(false)}
          onConnectTwitter={linkTwitter}
        />
      )}
    </div>
  )
}

function VaultIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 text-emerald-200/80" fill="none">
      <path d="M4 7.5h16v11H4zM7 7.5V5h10v2.5M12 11v4M10 13h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RegisterModal({
  firstTime,
  address,
  currentTwitter,
  onLinkTwitter,
  onSave,
  onDone,
  onCancel,
}: {
  firstTime: boolean
  address: string
  currentTwitter?: string
  onLinkTwitter: () => unknown
  onSave: (data: { username: string; twitter?: string }) => Promise<Profile>
  onDone: (p: Profile) => void
  onCancel: () => void
}) {
  const [username, setUsername] = useState('')
  const [twitter, setTwitter] = useState<string | undefined>(currentTwitter)
  const [twitterErr, setTwitterErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
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

  const save = async () => {
    if (!valid || saving) return
    setSaveErr(null)
    setSaving(true)
    try {
      onDone(await onSave({ username: username.trim(), twitter }))
    } catch (error) {
      setSaveErr(error instanceof Error ? error.message : 'Profile could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-2xl bg-[#0d1b24] border border-white/15 p-7 text-white shadow-2xl">
        <div className="flex items-center gap-2 mb-1">
          <img src="/logo.png" alt="NuvemFund" className="h-6 w-auto" />
          <span className="text-white/50 text-xs font-mono">{short(address)}</span>
        </div>
        <h2 className="text-xl font-semibold mb-1">
          {firstTime ? 'Welcome to NuvemFund' : 'Complete your profile'}
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
        {saveErr && <div className="text-xs text-red-300 mt-3">{saveErr}</div>}

        {/* Acciones */}
        <div className="flex gap-3 mt-7">
          <button
            onClick={onCancel}
            className="flex-1 rounded-full border border-white/15 text-white/70 hover:text-white py-2.5 text-sm cursor-pointer transition-colors"
          >
            Later
          </button>
          <button
            disabled={!valid || saving}
            onClick={() => void save()}
            className="flex-1 rounded-full bg-white text-gray-900 font-medium py-2.5 text-sm cursor-pointer transition-transform enabled:hover:scale-[1.02] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Securing profile…' : 'Create profile'}
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

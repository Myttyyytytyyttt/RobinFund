// Perfil de usuario de Neverless (username + X opcional), ligado a la wallet.
//
// IMPORTANTE — persistencia: hoy es localStorage (por-dispositivo). El "¿ya se
// registró?" REAL y cross-device lo da Privy (`isNewUser` en el login) porque
// Privy recuerda la wallet en sus servidores. El USERNAME en cambio es dato de
// nuestra app: para que sea cross-device y con unicidad garantizada necesita el
// backend (Fase 2). Toda la app habla con esta interfaz, así que en Fase 2 se
// sustituye la implementación por llamadas a la API sin tocar los componentes.

export type Profile = {
  address: string
  username: string
  twitter?: string // handle de X si lo enlazó
  createdAt: number
}

const KEY = 'neverless.profiles'

function readAll(): Record<string, Profile> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, Profile>) {
  localStorage.setItem(KEY, JSON.stringify(all))
}

const norm = (addr: string) => addr.toLowerCase()

export const profileStore = {
  get(address?: string | null): Profile | null {
    if (!address) return null
    return readAll()[norm(address)] ?? null
  },

  has(address?: string | null): boolean {
    return !!profileStore.get(address)
  },

  save(address: string, data: { username: string; twitter?: string }): Profile {
    const all = readAll()
    const key = norm(address)
    const profile: Profile = {
      address: key,
      username: data.username.trim(),
      twitter: data.twitter,
      createdAt: all[key]?.createdAt ?? Date.now(),
    }
    all[key] = profile
    writeAll(all)
    return profile
  },
}

// Validación de username (misma regla que deberá aplicar el backend en Fase 2).
export function validateUsername(name: string): string | null {
  const v = name.trim()
  if (v.length < 3) return 'At least 3 characters'
  if (v.length > 20) return 'At most 20 characters'
  if (!/^[a-zA-Z0-9_]+$/.test(v)) return 'Letters, numbers and _ only'
  return null
}

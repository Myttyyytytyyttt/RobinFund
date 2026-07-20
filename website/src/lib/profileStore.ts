// Perfil social de NuvemFund, ligado criptográficamente a la wallet.
//
// Supabase es la persistencia cross-device y aplica unicidad + RLS. La pequeña
// caché de localStorage conserva compatibilidad con perfiles creados antes de la
// migración y permite pintar instantáneamente mientras llega la lectura remota.

import {
  currentSupabaseWalletAddress,
  ensureSupabaseWalletSession,
  getSupabaseClient,
  isSupabaseConfigured,
  signOutSupabase,
  type EthereumProvider,
} from './supabase'
import type { Database } from './database.types'

export type Profile = {
  address: string
  username: string
  twitter?: string
  twitterVerified?: boolean
  createdAt: number
}

const KEY = 'nuvemfund.profiles'
const PREVIOUS_KEY = ['never', 'less.profiles'].join('')

function readAll(): Record<string, Profile> {
  try {
    let stored = localStorage.getItem(KEY)
    if (!stored) {
      stored = localStorage.getItem(PREVIOUS_KEY)
      if (stored) {
        localStorage.setItem(KEY, stored)
        localStorage.removeItem(PREVIOUS_KEY)
      }
    }
    return JSON.parse(stored ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, Profile>) {
  localStorage.setItem(KEY, JSON.stringify(all))
}

const norm = (address: string) => address.toLowerCase()

type ProfileRow = Pick<
  Database['public']['Tables']['profiles']['Row'],
  'wallet_address' | 'username' | 'twitter_username' | 'twitter_verified' | 'created_at'
>

function fromRow(row: ProfileRow): Profile {
  return {
    address: norm(row.wallet_address),
    username: row.username,
    twitter: row.twitter_username ?? undefined,
    twitterVerified: row.twitter_verified,
    createdAt: Date.parse(row.created_at),
  }
}

function normalizeTwitter(twitter?: string): string | undefined {
  const value = twitter?.trim().replace(/^@/, '')
  return value || undefined
}

function saveLocal(
  address: string,
  data: {
    username: string
    twitter?: string
    twitterVerified?: boolean
    createdAt?: number
  },
): Profile {
  const all = readAll()
  const key = norm(address)
  const profile: Profile = {
    address: key,
    username: data.username.trim(),
    twitter: normalizeTwitter(data.twitter),
    twitterVerified: data.twitterVerified ?? all[key]?.twitterVerified ?? false,
    createdAt: data.createdAt ?? all[key]?.createdAt ?? Date.now(),
  }
  all[key] = profile
  writeAll(all)
  return profile
}

async function saveRemote(
  address: string,
  data: { username: string; twitter?: string },
): Promise<Profile> {
  const client = getSupabaseClient()
  if (!client) return saveLocal(address, data)

  const walletAddress = norm(address)
  const values = {
    username: data.username.trim(),
    twitter_username: normalizeTwitter(data.twitter) ?? null,
  }

  // PostgREST's ON CONFLICT path requires broader table privileges than our
  // deliberately restricted column grants. Use the separately verified
  // INSERT/UPDATE paths and keep owner_id private.
  const { data: existing, error: lookupError } = await client
    .from('profiles')
    .select('wallet_address')
    .eq('wallet_address', walletAddress)
    .maybeSingle()

  if (lookupError) throw new Error(lookupError.message)

  const { error: writeError } = existing
    ? await client.from('profiles').update(values).eq('wallet_address', walletAddress)
    : await client.from('profiles').insert({ wallet_address: walletAddress, ...values })

  if (writeError) {
    if (writeError.code === '23505') throw new Error('That username is already taken.')
    if (writeError.code === '23514') throw new Error('The profile contains an invalid value.')
    throw new Error(writeError.message)
  }

  const { data: row, error: readError } = await client
    .from('profiles')
    .select('wallet_address, username, twitter_username, twitter_verified, created_at')
    .eq('wallet_address', walletAddress)
    .single()

  if (readError) {
    throw new Error(readError.message)
  }

  const profile = fromRow(row as ProfileRow)
  saveLocal(profile.address, profile)
  return profile
}

export const profileStore = {
  get(address?: string | null): Profile | null {
    if (!address) return null
    return readAll()[norm(address)] ?? null
  },

  has(address?: string | null): boolean {
    return !!profileStore.get(address)
  },

  /** Public read: no wallet signature required. Falls back to the legacy cache. */
  async load(address?: string | null): Promise<Profile | null> {
    if (!address) return null
    const cached = profileStore.get(address)
    const client = getSupabaseClient()
    if (!client) return cached

    const { data, error } = await client
      .from('profiles')
      .select('wallet_address, username, twitter_username, twitter_verified, created_at')
      .eq('wallet_address', norm(address))
      .maybeSingle()

    if (error) {
      console.warn('NuvemFund profile read failed; using local cache.', error.message)
      return cached
    }
    if (!data) return cached

    const profile = fromRow(data as ProfileRow)
    saveLocal(profile.address, profile)
    return profile
  },

  saveLocal,

  /** Explicit write: establishes a Supabase SIWE session if needed. */
  async save(
    address: string,
    data: { username: string; twitter?: string },
    wallet?: EthereumProvider,
  ): Promise<Profile> {
    if (!isSupabaseConfigured) return saveLocal(address, data)
    if (!wallet) throw new Error('The connected wallet provider is unavailable.')
    await ensureSupabaseWalletSession(address, wallet)
    return saveRemote(address, data)
  },

  /** Background OAuth sync: writes only when a matching SIWE session already exists. */
  async saveIfAuthenticated(
    address: string,
    data: { username: string; twitter?: string },
  ): Promise<Profile> {
    const local = saveLocal(address, data)
    if (!isSupabaseConfigured) return local
    if ((await currentSupabaseWalletAddress()) !== norm(address)) return local
    return saveRemote(address, data)
  },

  async signOut(): Promise<void> {
    await signOutSupabase()
  },
}

export function validateUsername(name: string): string | null {
  const value = name.trim()
  if (value.length < 3) return 'At least 3 characters'
  if (value.length > 20) return 'At most 20 characters'
  if (!/^[a-zA-Z0-9_]+$/.test(value)) return 'Letters, numbers and _ only'
  return null
}

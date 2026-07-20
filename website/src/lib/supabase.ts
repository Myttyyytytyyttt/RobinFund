import { createClient, type User } from '@supabase/supabase-js'
import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const isSupabaseConfigured = Boolean(url && publishableKey)

export type EthereumProvider = {
  address: string
  request<T = unknown>(args: {
    method: string
    params?: unknown
  }): Promise<T>
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

const supabase = isSupabaseConfigured
  ? createClient<Database>(url!, publishableKey!, {
      auth: {
        storageKey: 'nuvemfund.supabase.auth',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

const normalizeAddress = (address: string) => address.toLowerCase()

function web3Address(user?: User | null): string | null {
  const identity = user?.identities?.find((candidate) => candidate.provider === 'web3')
  const customClaims = identity?.identity_data?.custom_claims
  const address =
    identity?.identity_data?.address ??
    (typeof customClaims === 'object' && customClaims
      ? (customClaims as Record<string, unknown>).address
      : undefined) ??
    (identity?.id?.startsWith('web3:ethereum:') ? identity.id.split(':')[2] : undefined)
  return typeof address === 'string' ? normalizeAddress(address) : null
}

const pendingSessions = new Map<string, Promise<User>>()

async function establishWalletSession(
  address: string,
  wallet: EthereumProvider,
): Promise<User> {
  if (!supabase) throw new Error('Supabase is not configured for this environment.')

  const expected = normalizeAddress(address)
  const { data: current } = await supabase.auth.getUser()
  if (web3Address(current.user) === expected && current.user) return current.user

  if (current.user) await supabase.auth.signOut({ scope: 'local' })

  const { data, error } = await supabase.auth.signInWithWeb3({
    chain: 'ethereum',
    wallet,
    statement: 'Sign in to NuvemFund to securely manage your profile.',
    options: {
      signInWithEthereum: { chainId: 4663 },
    },
  })

  if (error) throw error
  if (!data.user || web3Address(data.user) !== expected) {
    await supabase.auth.signOut({ scope: 'local' })
    throw new Error('The Supabase session does not match the connected wallet.')
  }
  return data.user
}

/**
 * Ensures Data API writes run under a SIWE session for exactly this wallet.
 * Concurrent profile/X effects share one promise, preventing duplicate prompts.
 */
export async function ensureSupabaseWalletSession(
  address: string,
  wallet: EthereumProvider,
): Promise<User> {
  const key = normalizeAddress(address)
  const existing = pendingSessions.get(key)
  if (existing) return existing

  const pending = establishWalletSession(key, wallet).finally(() => {
    pendingSessions.delete(key)
  })
  pendingSessions.set(key, pending)
  return pending
}

export async function currentSupabaseWalletAddress(): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return web3Address(data.user)
}

export async function signOutSupabase(): Promise<void> {
  if (!supabase) return
  await supabase.auth.signOut({ scope: 'local' })
}

export function getSupabaseClient() {
  return supabase
}

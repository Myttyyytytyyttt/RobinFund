import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

const RUN = process.env.SUPABASE_E2E === '1'
const describeE2E = RUN ? describe : describe.skip

describeE2E('Supabase SIWE + profile RLS', () => {
  it(
    'creates a wallet session, writes only its profile, and allows public reads',
    async () => {
      const url = process.env.SUPABASE_E2E_URL ?? import.meta.env.VITE_SUPABASE_URL
      const key =
        process.env.SUPABASE_E2E_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
      if (!url || !key) throw new Error('Missing SUPABASE_E2E_URL or SUPABASE_E2E_KEY.')

      const account = privateKeyToAccount(generatePrivateKey())
      const wallet = {
        address: account.address,
        request: async ({ method, params }: { method: string; params?: unknown }) => {
          if (method === 'eth_requestAccounts') return [account.address]
          if (method === 'eth_chainId') return '0x1237'
          if (method === 'personal_sign') {
            const [message] = params as [Hex, string]
            return account.signMessage({ message: { raw: message } })
          }
          throw new Error(`Unsupported test-wallet method: ${method}`)
        },
        on: () => undefined,
        removeListener: () => undefined,
      }

      const authenticated = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const visitor = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      })

      const { data: auth, error: authError } = await authenticated.auth.signInWithWeb3({
        chain: 'ethereum',
        wallet,
        statement: 'NuvemFund local integration test.',
        options: {
          url: 'http://localhost:5173/',
          signInWithEthereum: { chainId: 4663 },
        },
      })
      expect(authError).toBeNull()
      const identityData = auth.user?.identities?.[0]?.identity_data
      const authenticatedAddress =
        identityData?.address ?? identityData?.custom_claims?.address
      expect(authenticatedAddress?.toLowerCase()).toBe(account.address.toLowerCase())

      const walletAddress = account.address.toLowerCase()
      const username = `e2e_${walletAddress.slice(2, 10)}`
      const renamed = `ok_${walletAddress.slice(2, 10)}`

      const { error: insertError } = await authenticated
        .from('profiles')
        .insert({ wallet_address: walletAddress, username })
      expect(insertError).toBeNull()

      const { error: updateError } = await authenticated
        .from('profiles')
        .update({ username: renamed })
        .eq('wallet_address', walletAddress)
      expect(updateError).toBeNull()

      const { data: publicProfile, error: readError } = await visitor
        .from('profiles')
        .select('wallet_address, username')
        .eq('wallet_address', walletAddress)
        .single()
      expect(readError).toBeNull()
      expect(publicProfile).toEqual({ wallet_address: walletAddress, username: renamed })

      const { error: impersonationError } = await authenticated.from('profiles').insert({
        wallet_address: '0x3333333333333333333333333333333333333333',
        username: `bad_${walletAddress.slice(2, 10)}`,
      })
      expect(impersonationError?.code).toBe('42501')

      const { error: deleteError } = await authenticated
        .from('profiles')
        .delete()
        .eq('wallet_address', walletAddress)
      expect(deleteError).toBeNull()
      await authenticated.auth.signOut({ scope: 'local' })
    },
    20_000,
  )
})

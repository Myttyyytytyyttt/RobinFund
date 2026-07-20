# NuvemFund data layer

Supabase persists application state that does **not** belong on-chain. It does not replace
Robinhood Chain or Ponder as the source of financial truth.

| Data | Owner | Browser access |
|---|---|---|
| Funds, shares, orders, settlements, NAV | Contracts + Ponder | Read through Ponder GraphQL |
| Profiles, follows, fund chat, reactions | Supabase `public` | RLS-protected Data API |
| Notifications | Supabase `public` | Recipient only through RLS |
| KYC decisions and wallet bindings | Supabase `compliance_private` | Never; backend service role/direct Postgres only |
| Rebuildable indexed chain state in production | Supabase `ponder` | Ponder owns the schema; frontend still uses GraphQL |

## Hosted project

- Organization: `Zerobetgg`
- Project: `NuvemFund`
- Region: `eu-west-1`
- Migration: `migrations/20260720181337_initial_nuvemfund_platform.sql`

The hosted project must enable **Authentication > Providers > Web3 Wallet > Ethereum** and allow
the frontend origins. Locally, equivalent settings live in `config.toml`.

Use `http://localhost:5173` (not the numeric `127.0.0.1` alias) when testing profile writes. The
current GoTrue SIWE parser rejects an IP literal in the EIP-4361 domain line even though both local
origins remain allowlisted for ordinary redirects.

## Authentication boundary

Privy remains the application's login and X-account UX. A profile write additionally asks the
same connected wallet for one EIP-4361/SIWE signature. Supabase verifies that signature and RLS
derives the wallet from `auth.identities`; a browser-supplied address is never trusted as proof of
ownership.

Public profile reads require no signature. Profile writes reuse the Supabase wallet session until
it expires or the wallet is disconnected.

## Frontend variables

Copy `website/.env.example` to `website/.env` and set only the publishable values:

```dotenv
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_INDEXER_GRAPHQL_URL=http://127.0.0.1:42069/graphql
VITE_RH_RPC_URL=http://127.0.0.1:8545
```

Never put a service-role key, database password, compliance signer key, Privy secret, or Alchemy
credential in `website/.env` or in any `VITE_*` variable. Backend secrets stay in the root `.env`
or in the deployment platform's secret store.

## Production processes

Ponder already accepts a direct Postgres connection through `DATABASE_URL`; set
`DATABASE_SCHEMA=ponder` so its rebuildable tables stay isolated. The compliance signer currently
keeps its fail-closed single-process JSON store; `compliance_private` is the target schema for the
Postgres adapter before running multiple signer replicas.

## Local commands

```bash
pnpm dlx supabase@2.109.1 start
pnpm dlx supabase@2.109.1 db reset
pnpm dlx supabase@2.109.1 test db --local
pnpm --dir website test
pnpm --dir website test:supabase
pnpm --dir website build
```

Supabase local development requires Docker Desktop. Hosted migrations are applied through the
Supabase integration and should be followed by both security and performance advisor checks.

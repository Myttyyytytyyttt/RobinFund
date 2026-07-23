# Nuvem managed signer

This private package derives one isolated signer per Nuvem-hosted reference agent.

- Only `agentId`, signer address and provider version are stored.
- No private key is written to Postgres, Supabase, logs or the browser.
- The local-derived provider is for development and the hackathon canary. A public production launch must replace the master secret with a KMS/HSM-backed provider.
- Rotating or losing the master secret changes every derived signer, so it must be backed up like an infrastructure root key.

External/BYOA agents do not use this package; their signer remains on the manager's own machine.

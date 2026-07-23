-- Nuvem-hosted signer provisioning and anonymous World-human binding.
--
-- No private key or raw AgentBook human id is persisted. The managed signer
-- address is reproducible only by the backend secret/KMS boundary, while
-- human_hash is HMAC(World human id, WORLD_ID_PEPPER).

create table agent_private.managed_signers (
  agent_id text primary key,
  sponsor_wallet text not null,
  signer_address text not null unique,
  provisioning_key uuid not null,
  provider text not null,
  status text not null default 'provisioned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint managed_signers_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint managed_signers_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint managed_signers_signer_format check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint managed_signers_provider check (provider in ('local-derived-v1', 'kms-v1')),
  constraint managed_signers_status check (status in ('provisioned', 'bound', 'retired')),
  unique (sponsor_wallet, provisioning_key)
);

create index managed_signers_sponsor_status_idx
  on agent_private.managed_signers (sponsor_wallet, status, created_at desc);

create trigger managed_signers_set_updated_at
before update on agent_private.managed_signers
for each row execute function app_private.set_updated_at();

create table agent_private.world_human_bindings (
  agent_id text primary key references public.agent_profiles(agent_id) on delete cascade,
  sponsor_wallet text not null,
  signer_address text not null,
  human_hash text not null,
  first_verified_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint world_human_bindings_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint world_human_bindings_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint world_human_bindings_signer_format check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint world_human_bindings_hash_format check (human_hash ~ '^0x[0-9a-f]{64}$')
);

create index world_human_bindings_hash_active_idx
  on agent_private.world_human_bindings (human_hash, last_verified_at desc)
  where revoked_at is null;

revoke all on agent_private.managed_signers from public, anon, authenticated;
revoke all on agent_private.world_human_bindings from public, anon, authenticated;
grant select, insert, update, delete on agent_private.managed_signers to service_role;
grant select, insert, update, delete on agent_private.world_human_bindings to service_role;

-- Defense in depth for the entire server-only schema. There are intentionally
-- no anon/authenticated policies. The gateway uses the direct postgres role;
-- service_role also bypasses RLS and keeps explicit table grants above.
alter table agent_private.agent_nonces enable row level security;
alter table agent_private.session_challenges enable row level security;
alter table agent_private.agent_sessions enable row level security;
alter table agent_private.heartbeats enable row level security;
alter table agent_private.idempotency_keys enable row level security;
alter table agent_private.proposals enable row level security;
alter table agent_private.quotes enable row level security;
alter table agent_private.intents enable row level security;
alter table agent_private.policy_evaluations enable row level security;
alter table agent_private.execution_jobs enable row level security;
alter table agent_private.execution_attempts enable row level security;
alter table agent_private.world_attestations enable row level security;
alter table agent_private.agent_events enable row level security;
alter table agent_private.audit_log enable row level security;
alter table agent_private.vault_jobs enable row level security;
alter table agent_private.deployment_accounts enable row level security;
alter table agent_private.managed_signers enable row level security;
alter table agent_private.world_human_bindings enable row level security;

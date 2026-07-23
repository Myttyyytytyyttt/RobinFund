-- Nuvem World ID 4.0 sponsor gate for public AI vault activation.
--
-- Only HMACs/hashes are persisted. Raw World proofs, RP nonces, World human
-- identifiers and signing keys never enter Postgres.

create table agent_private.world_id_sponsors (
  sponsor_wallet text primary key,
  human_hash text not null unique,
  nullifier_hash text not null unique,
  action text not null,
  first_verified_at timestamptz not null default now(),
  last_verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint world_id_sponsors_wallet_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint world_id_sponsors_human_hash_format check (human_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_id_sponsors_nullifier_hash_format check (nullifier_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_id_sponsors_action_length check (char_length(action) between 1 and 128),
  unique (sponsor_wallet, human_hash)
);

create table agent_private.world_id_requests (
  id uuid primary key,
  agent_id text not null references public.agent_profiles(agent_id) on delete cascade,
  sponsor_wallet text not null,
  signer_address text not null,
  rp_nonce_hash text not null unique,
  signal_hash text not null,
  action text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  proof_hash text,
  created_at timestamptz not null default now(),
  constraint world_id_requests_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint world_id_requests_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint world_id_requests_signer_format check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint world_id_requests_nonce_hash_format check (rp_nonce_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_id_requests_signal_hash_format check (signal_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_id_requests_proof_hash_format check (proof_hash is null or proof_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_id_requests_action_length check (char_length(action) between 1 and 128),
  constraint world_id_requests_expiry_after_creation check (expires_at > created_at)
);

create index world_id_requests_agent_pending_idx
  on agent_private.world_id_requests (agent_id, created_at desc)
  where consumed_at is null;

create index world_id_requests_expiry_idx
  on agent_private.world_id_requests (expires_at)
  where consumed_at is null;

create table agent_private.world_id_agent_bindings (
  agent_id text primary key references public.agent_profiles(agent_id) on delete cascade,
  sponsor_wallet text not null,
  signer_address text not null,
  human_hash text not null,
  source_request_id uuid references agent_private.world_id_requests(id) on delete set null,
  verified_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint world_id_agent_bindings_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint world_id_agent_bindings_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint world_id_agent_bindings_signer_format check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint world_id_agent_bindings_human_hash_format check (human_hash ~ '^0x[0-9a-f]{64}$'),
  foreign key (sponsor_wallet, human_hash)
    references agent_private.world_id_sponsors(sponsor_wallet, human_hash)
);

create index world_id_agent_bindings_human_active_idx
  on agent_private.world_id_agent_bindings (human_hash, verified_at desc)
  where revoked_at is null;

revoke all on agent_private.world_id_sponsors from public, anon, authenticated;
revoke all on agent_private.world_id_requests from public, anon, authenticated;
revoke all on agent_private.world_id_agent_bindings from public, anon, authenticated;
grant select, insert, update, delete on agent_private.world_id_sponsors to service_role;
grant select, insert, update, delete on agent_private.world_id_requests to service_role;
grant select, insert, update, delete on agent_private.world_id_agent_bindings to service_role;

alter table agent_private.world_id_sponsors enable row level security;
alter table agent_private.world_id_requests enable row level security;
alter table agent_private.world_id_agent_bindings enable row level security;

comment on table agent_private.world_id_sponsors is
  'One Nuvem sponsor wallet bound to one anonymous World ID 4.0 human hash.';
comment on table agent_private.world_id_requests is
  'Single-use RP requests; stores only nonce/signal/proof hashes.';
comment on table agent_private.world_id_agent_bindings is
  'World-verified sponsor-to-agent bindings used before AgentRegistry backing.';

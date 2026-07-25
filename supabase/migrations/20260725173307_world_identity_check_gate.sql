-- World ID 4.0 Identity Check gate for AI vault activation.
--
-- This is deliberately separate from the legacy Proof-of-Human sponsor gate.
-- It stores only server-selected policy metadata and keyed hashes; raw World
-- proofs, RP nonces, identity attributes and signing keys never enter Postgres.

create table agent_private.world_identity_requests (
  id uuid primary key,
  agent_id text not null references public.agent_profiles(agent_id) on delete cascade,
  sponsor_wallet text not null,
  signer_address text not null,
  rp_nonce_hash text not null unique,
  signal_hash text not null,
  app_id text not null,
  rp_id text not null,
  environment text not null,
  policy_id text not null,
  policy_version integer not null,
  policy_hash text not null,
  attributes jsonb not null,
  attributes_hash text not null,
  action text not null,
  require_user_presence boolean not null default false,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  proof_hash text,
  created_at timestamptz not null default now(),
  constraint world_identity_requests_agent_id_format
    check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_requests_sponsor_format
    check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint world_identity_requests_signer_format
    check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint world_identity_requests_nonce_hash_format
    check (rp_nonce_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_requests_signal_hash_format
    check (signal_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_requests_app_id_format
    check (app_id ~ '^app_(staging_)?[0-9a-z]+$'),
  constraint world_identity_requests_rp_id_format
    check (rp_id ~ '^rp_[0-9a-z]+$'),
  constraint world_identity_requests_environment
    check (environment in ('staging', 'production')),
  constraint world_identity_requests_app_environment
    check (
      (environment = 'staging' and app_id ~ '^app_staging_[0-9a-z]+$')
      or
      (environment = 'production' and app_id ~ '^app_[0-9a-z]+$')
    ),
  constraint world_identity_requests_policy_id_length
    check (char_length(policy_id) between 1 and 128),
  constraint world_identity_requests_policy_version
    check (policy_version > 0),
  constraint world_identity_requests_policy_hash_format
    check (policy_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_requests_attributes_array
    check (jsonb_typeof(attributes) = 'array' and jsonb_array_length(attributes) > 0),
  constraint world_identity_requests_attributes_hash_format
    check (attributes_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_requests_action_length
    check (char_length(action) between 1 and 128),
  constraint world_identity_requests_proof_hash_format
    check (proof_hash is null or proof_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_requests_expiry_after_creation
    check (expires_at > created_at),
  constraint world_identity_requests_consumed_after_creation
    check (consumed_at is null or consumed_at >= created_at)
);

create index world_identity_requests_agent_pending_idx
  on agent_private.world_identity_requests (agent_id, created_at desc)
  where consumed_at is null;

create index world_identity_requests_expiry_idx
  on agent_private.world_identity_requests (expires_at)
  where consumed_at is null;

create table agent_private.world_identity_sponsors (
  id uuid primary key,
  sponsor_wallet text not null,
  subject_hash text not null,
  nullifier_hash text not null,
  app_id text not null,
  rp_id text not null,
  environment text not null,
  policy_id text not null,
  policy_version integer not null,
  policy_hash text not null,
  attributes_hash text not null,
  action text not null,
  credential_identifier text not null,
  issuer_schema_id bigint not null,
  first_verified_at timestamptz not null,
  last_verified_at timestamptz not null,
  valid_until timestamptz not null,
  revoked_at timestamptz,
  constraint world_identity_sponsors_scope_unique unique (
    sponsor_wallet, app_id, rp_id, environment, action,
    policy_id, policy_version, policy_hash
  ),
  constraint world_identity_sponsors_sponsor_format
    check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint world_identity_sponsors_subject_hash_format
    check (subject_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_sponsors_nullifier_hash_format
    check (nullifier_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_sponsors_app_id_format
    check (app_id ~ '^app_(staging_)?[0-9a-z]+$'),
  constraint world_identity_sponsors_rp_id_format
    check (rp_id ~ '^rp_[0-9a-z]+$'),
  constraint world_identity_sponsors_environment
    check (environment in ('staging', 'production')),
  constraint world_identity_sponsors_app_environment
    check (
      (environment = 'staging' and app_id ~ '^app_staging_[0-9a-z]+$')
      or
      (environment = 'production' and app_id ~ '^app_[0-9a-z]+$')
    ),
  constraint world_identity_sponsors_policy_id_length
    check (char_length(policy_id) between 1 and 128),
  constraint world_identity_sponsors_policy_version
    check (policy_version > 0),
  constraint world_identity_sponsors_policy_hash_format
    check (policy_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_sponsors_attributes_hash_format
    check (attributes_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_sponsors_action_length
    check (char_length(action) between 1 and 128),
  constraint world_identity_sponsors_credential_length
    check (char_length(credential_identifier) between 1 and 64),
  constraint world_identity_sponsors_issuer_schema
    check (issuer_schema_id > 0),
  constraint world_identity_sponsors_validity
    check (
      last_verified_at >= first_verified_at
      and valid_until > last_verified_at
    ),
  constraint world_identity_sponsors_revocation
    check (revoked_at is null or revoked_at >= first_verified_at)
);

create unique index world_identity_sponsors_subject_owner_idx
  on agent_private.world_identity_sponsors (
    environment, app_id, rp_id, action, policy_id, policy_version,
    policy_hash, subject_hash
  )
  where revoked_at is null;

create unique index world_identity_sponsors_nullifier_owner_idx
  on agent_private.world_identity_sponsors (
    environment, app_id, rp_id, action, policy_id, policy_version,
    policy_hash, nullifier_hash
  )
  where revoked_at is null;

create index world_identity_sponsors_valid_until_idx
  on agent_private.world_identity_sponsors (valid_until)
  where revoked_at is null;

create table agent_private.world_identity_agent_bindings (
  agent_id text primary key references public.agent_profiles(agent_id) on delete cascade,
  sponsor_binding_id uuid not null
    references agent_private.world_identity_sponsors(id) on delete restrict,
  sponsor_wallet text not null,
  signer_address text not null,
  subject_hash text not null,
  nullifier_hash text not null,
  app_id text not null,
  rp_id text not null,
  environment text not null,
  policy_id text not null,
  policy_version integer not null,
  policy_hash text not null,
  attributes_hash text not null,
  action text not null,
  credential_identifier text not null,
  issuer_schema_id bigint not null,
  source_request_id uuid unique
    references agent_private.world_identity_requests(id) on delete restrict,
  verified_at timestamptz not null,
  valid_until timestamptz not null,
  revoked_at timestamptz,
  constraint world_identity_bindings_agent_id_format
    check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_bindings_sponsor_format
    check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint world_identity_bindings_signer_format
    check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint world_identity_bindings_subject_hash_format
    check (subject_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_bindings_nullifier_hash_format
    check (nullifier_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_bindings_app_id_format
    check (app_id ~ '^app_(staging_)?[0-9a-z]+$'),
  constraint world_identity_bindings_rp_id_format
    check (rp_id ~ '^rp_[0-9a-z]+$'),
  constraint world_identity_bindings_environment
    check (environment in ('staging', 'production')),
  constraint world_identity_bindings_app_environment
    check (
      (environment = 'staging' and app_id ~ '^app_staging_[0-9a-z]+$')
      or
      (environment = 'production' and app_id ~ '^app_[0-9a-z]+$')
    ),
  constraint world_identity_bindings_policy_id_length
    check (char_length(policy_id) between 1 and 128),
  constraint world_identity_bindings_policy_version
    check (policy_version > 0),
  constraint world_identity_bindings_policy_hash_format
    check (policy_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_bindings_attributes_hash_format
    check (attributes_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_identity_bindings_action_length
    check (char_length(action) between 1 and 128),
  constraint world_identity_bindings_credential_length
    check (char_length(credential_identifier) between 1 and 64),
  constraint world_identity_bindings_issuer_schema
    check (issuer_schema_id > 0),
  constraint world_identity_bindings_validity
    check (valid_until > verified_at),
  constraint world_identity_bindings_revocation
    check (revoked_at is null or revoked_at >= verified_at)
);

create index world_identity_bindings_policy_active_idx
  on agent_private.world_identity_agent_bindings (
    environment, app_id, rp_id, action, policy_id, policy_version, policy_hash
  )
  where revoked_at is null;

create index world_identity_bindings_valid_until_idx
  on agent_private.world_identity_agent_bindings (valid_until)
  where revoked_at is null;

revoke all on agent_private.world_identity_requests from public, anon, authenticated;
revoke all on agent_private.world_identity_sponsors from public, anon, authenticated;
revoke all on agent_private.world_identity_agent_bindings from public, anon, authenticated;
grant select, insert, update, delete on agent_private.world_identity_requests to service_role;
grant select, insert, update, delete on agent_private.world_identity_sponsors to service_role;
grant select, insert, update, delete on agent_private.world_identity_agent_bindings to service_role;

alter table agent_private.world_identity_requests enable row level security;
alter table agent_private.world_identity_sponsors enable row level security;
alter table agent_private.world_identity_agent_bindings enable row level security;

comment on table agent_private.world_identity_requests is
  'Single-use World ID 4.0 Identity Check requests. Contains only server policy metadata and hashes.';
comment on table agent_private.world_identity_sponsors is
  'One sponsor owner per anonymous World Identity subject and exact app/RP/environment/action/policy scope.';
comment on table agent_private.world_identity_agent_bindings is
  'Policy- and environment-specific Identity Check bindings used by the AI vault backing gate.';

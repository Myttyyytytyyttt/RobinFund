-- Nuvem Agents control plane.
--
-- Boundaries:
--   public.agent_profiles / public.agent_decisions: sanitized, RLS-protected read model.
--   agent_private: sessions, World proofs, quotes, intents, jobs and append-only audit.
--
-- No private key, provider API key, raw human identifier or private prompt belongs here.

create schema if not exists agent_private;

revoke all on schema agent_private from public, anon, authenticated;
grant usage on schema agent_private to service_role;

alter default privileges for role postgres in schema agent_private
  revoke select, insert, update, delete on tables from public, anon, authenticated;
alter default privileges for role postgres in schema agent_private
  revoke usage, select on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema agent_private
  revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sanitized public read model
-- ---------------------------------------------------------------------------

create table public.agent_profiles (
  agent_id text primary key,
  sponsor_wallet text not null,
  signer_address text not null,
  vault_address text,
  controller_address text,
  display_name text not null,
  avatar_url text,
  strategy_summary text not null default '',
  metadata_uri text not null default '',
  policy jsonb not null default '{}'::jsonb,
  policy_hash text,
  world_backed boolean not null default false,
  world_backed_until timestamptz,
  runtime_kind text not null default 'external',
  status text not null default 'pending_backing',
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_profiles_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint agent_profiles_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint agent_profiles_signer_format check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint agent_profiles_vault_format check (vault_address is null or vault_address ~ '^0x[0-9a-f]{40}$'),
  constraint agent_profiles_controller_format check (
    controller_address is null or controller_address ~ '^0x[0-9a-f]{40}$'
  ),
  constraint agent_profiles_policy_hash_format check (
    policy_hash is null or policy_hash ~ '^0x[0-9a-f]{64}$'
  ),
  constraint agent_profiles_display_name_length check (length(display_name) between 2 and 64),
  constraint agent_profiles_strategy_length check (length(strategy_summary) <= 1000),
  constraint agent_profiles_runtime_kind check (runtime_kind in ('external', 'nuvem_reference')),
  constraint agent_profiles_status check (
    status in ('pending_backing', 'active', 'paused', 'offline', 'retired')
  )
);

create index agent_profiles_sponsor_created_idx
  on public.agent_profiles (sponsor_wallet, created_at desc);
create index agent_profiles_status_updated_idx
  on public.agent_profiles (status, updated_at desc);
create unique index agent_profiles_vault_unique_idx
  on public.agent_profiles (vault_address)
  where vault_address is not null;
create unique index agent_profiles_controller_unique_idx
  on public.agent_profiles (controller_address)
  where controller_address is not null;

create trigger agent_profiles_set_updated_at
before update on public.agent_profiles
for each row execute function app_private.set_updated_at();

alter table public.agent_profiles enable row level security;

create policy agent_profiles_public_read
on public.agent_profiles
for select
to anon, authenticated
using (true);

create policy agent_profiles_sponsor_update
on public.agent_profiles
for update
to authenticated
using (sponsor_wallet = (select app_private.current_web3_address()))
with check (sponsor_wallet = (select app_private.current_web3_address()));

grant select on public.agent_profiles to anon, authenticated;
grant update (display_name, avatar_url, strategy_summary, metadata_uri)
  on public.agent_profiles to authenticated;
grant select, insert, update, delete on public.agent_profiles to service_role;

create table public.agent_decisions (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agent_profiles(agent_id) on delete cascade,
  vault_address text not null,
  decision text not null,
  summary text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  policy_result text not null,
  token_in text,
  token_out text,
  amount_in text,
  min_amount_out text,
  quoted_amount_out text,
  slippage_bps integer,
  transaction_hash text,
  chain_id bigint not null,
  block_number numeric(78, 0),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint agent_decisions_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint agent_decisions_vault_format check (vault_address ~ '^0x[0-9a-f]{40}$'),
  constraint agent_decisions_decision check (
    decision in ('hold', 'rejected', 'approved', 'executed', 'failed')
  ),
  constraint agent_decisions_policy_result check (
    policy_result in ('not_evaluated', 'approved', 'rejected')
  ),
  constraint agent_decisions_summary_length check (length(summary) between 1 and 2000),
  constraint agent_decisions_token_in_format check (token_in is null or token_in ~ '^0x[0-9a-f]{40}$'),
  constraint agent_decisions_token_out_format check (token_out is null or token_out ~ '^0x[0-9a-f]{40}$'),
  constraint agent_decisions_tx_format check (
    transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  constraint agent_decisions_slippage_range check (slippage_bps is null or slippage_bps between 0 and 10000)
);

create index agent_decisions_agent_time_idx
  on public.agent_decisions (agent_id, occurred_at desc);
create index agent_decisions_vault_time_idx
  on public.agent_decisions (vault_address, occurred_at desc);
create index agent_decisions_decision_time_idx
  on public.agent_decisions (decision, occurred_at desc);

alter table public.agent_decisions enable row level security;

create policy agent_decisions_public_read
on public.agent_decisions
for select
to anon, authenticated
using (true);

grant select on public.agent_decisions to anon, authenticated;
grant select, insert, update, delete on public.agent_decisions to service_role;

-- ---------------------------------------------------------------------------
-- Private identity/session boundary
-- ---------------------------------------------------------------------------

create table agent_private.agent_nonces (
  agent_id text primary key,
  next_nonce numeric(78, 0) not null default 0,
  updated_at timestamptz not null default now(),
  constraint agent_nonces_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint agent_nonces_nonnegative check (next_nonce >= 0)
);

create table agent_private.session_challenges (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  signer_address text not null,
  challenge_hash bytea not null unique,
  agentkit_nonce text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  unique (agentkit_nonce),
  constraint session_challenges_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint session_challenges_signer_format check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint session_challenges_expiry check (expires_at > issued_at)
);

create index session_challenges_agent_expiry_idx
  on agent_private.session_challenges (agent_id, expires_at desc);

create table agent_private.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  signer_address text not null,
  sponsor_wallet text not null,
  token_hash bytea not null unique,
  agentkit_proof_hash text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  constraint agent_sessions_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint agent_sessions_signer_format check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint agent_sessions_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint agent_sessions_proof_hash_format check (agentkit_proof_hash ~ '^0x[0-9a-f]{64}$'),
  constraint agent_sessions_expiry check (expires_at > issued_at)
);

create index agent_sessions_agent_expiry_idx
  on agent_private.agent_sessions (agent_id, expires_at desc);
create index agent_sessions_active_idx
  on agent_private.agent_sessions (token_hash, expires_at)
  where revoked_at is null;

create table agent_private.heartbeats (
  id bigint generated always as identity primary key,
  agent_id text not null,
  session_id uuid references agent_private.agent_sessions(id) on delete set null,
  runtime_version text not null,
  capabilities jsonb not null default '[]'::jsonb,
  observed_at timestamptz not null default now(),
  constraint heartbeats_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint heartbeats_runtime_version_length check (length(runtime_version) between 1 and 128)
);

create index heartbeats_agent_time_idx
  on agent_private.heartbeats (agent_id, observed_at desc);

create table agent_private.agent_events (
  id bigint generated always as identity primary key,
  agent_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint agent_events_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint agent_events_type check (event_type in ('heartbeat', 'intent', 'receipt', 'policy', 'agent'))
);

create index agent_events_agent_cursor_idx
  on agent_private.agent_events (agent_id, id);

-- ---------------------------------------------------------------------------
-- Durable creation, quote and intent state machines
-- ---------------------------------------------------------------------------

create table agent_private.idempotency_keys (
  scope text not null,
  idempotency_key text not null,
  request_hash bytea not null,
  state text not null default 'processing',
  status_code integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  primary key (scope, idempotency_key),
  constraint idempotency_state check (state in ('processing', 'completed', 'failed')),
  constraint idempotency_key_length check (length(idempotency_key) between 8 and 128)
);

create index idempotency_expiry_idx on agent_private.idempotency_keys (expires_at);

create table agent_private.vault_jobs (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  sponsor_wallet text not null,
  request jsonb not null,
  state text not null default 'requested',
  controller_address text,
  fund_address text,
  stake_escrow_address text,
  transaction_hashes jsonb not null default '[]'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vault_jobs_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint vault_jobs_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint vault_jobs_controller_format check (
    controller_address is null or controller_address ~ '^0x[0-9a-f]{40}$'
  ),
  constraint vault_jobs_fund_format check (fund_address is null or fund_address ~ '^0x[0-9a-f]{40}$'),
  constraint vault_jobs_state check (
    state in ('requested', 'deploying_controller', 'deploying_fund', 'binding', 'awaiting_stake', 'ready', 'failed')
  )
);

create index vault_jobs_sponsor_time_idx
  on agent_private.vault_jobs (sponsor_wallet, created_at desc);
create index vault_jobs_state_time_idx
  on agent_private.vault_jobs (state, created_at);

create table agent_private.proposals (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  vault_address text not null,
  proposal jsonb not null,
  evidence_hash text not null,
  reasoning_hash text not null,
  graph_deployment_id text not null,
  graph_block_number numeric(78, 0) not null,
  graph_block_timestamp timestamptz not null,
  graph_chain_head_block numeric(78, 0) not null,
  graph_observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint proposals_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint proposals_vault_format check (vault_address ~ '^0x[0-9a-f]{40}$'),
  constraint proposals_evidence_hash_format check (evidence_hash ~ '^0x[0-9a-f]{64}$'),
  constraint proposals_reasoning_hash_format check (reasoning_hash ~ '^0x[0-9a-f]{64}$')
);

create index proposals_agent_time_idx on agent_private.proposals (agent_id, created_at desc);

create table agent_private.quotes (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references agent_private.proposals(id) on delete cascade,
  provider text not null default 'uniswap',
  route_type text not null,
  chain_id bigint not null,
  token_in text not null,
  token_out text not null,
  amount_in numeric(78, 0) not null,
  quoted_amount_out numeric(78, 0) not null,
  min_amount_out numeric(78, 0) not null,
  approval_proxy text not null,
  adapter_address text not null,
  adapter_id numeric(78, 0) not null,
  fund_address text not null,
  controller_address text not null,
  route_calldata text not null,
  adapter_data text not null,
  quote_hash text not null unique,
  execution_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint quotes_route_type check (route_type = 'CLASSIC'),
  constraint quotes_token_in_format check (token_in ~ '^0x[0-9a-f]{40}$'),
  constraint quotes_token_out_format check (token_out ~ '^0x[0-9a-f]{40}$'),
  constraint quotes_proxy_format check (approval_proxy ~ '^0x[0-9a-f]{40}$'),
  constraint quotes_adapter_format check (adapter_address ~ '^0x[0-9a-f]{40}$'),
  constraint quotes_fund_format check (fund_address ~ '^0x[0-9a-f]{40}$'),
  constraint quotes_controller_format check (controller_address ~ '^0x[0-9a-f]{40}$'),
  constraint quotes_calldata_format check (route_calldata ~ '^0x[0-9a-f]*$'),
  constraint quotes_adapter_data_format check (adapter_data ~ '^0x[0-9a-f]*$'),
  constraint quotes_hash_format check (quote_hash ~ '^0x[0-9a-f]{64}$'),
  constraint quotes_execution_hash_format check (execution_hash ~ '^0x[0-9a-f]{64}$'),
  constraint quotes_positive_amounts check (
    amount_in > 0 and quoted_amount_out > 0 and min_amount_out > 0
  )
);

create index quotes_proposal_time_idx on agent_private.quotes (proposal_id, created_at desc);
create index quotes_expiry_idx on agent_private.quotes (expires_at);

create table agent_private.intents (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references agent_private.proposals(id) on delete restrict,
  quote_id uuid not null references agent_private.quotes(id) on delete restrict,
  agent_id text not null,
  sponsor_wallet text not null,
  controller_address text not null,
  fund_address text not null,
  chain_id bigint not null,
  onchain_nonce numeric(78, 0) not null,
  typed_data jsonb not null,
  signature text,
  policy_hash text not null,
  execution_hash text not null,
  evidence_hash text not null,
  state text not null default 'proposed',
  transaction_hash text,
  block_number numeric(78, 0),
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint intents_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint intents_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint intents_controller_format check (controller_address ~ '^0x[0-9a-f]{40}$'),
  constraint intents_fund_format check (fund_address ~ '^0x[0-9a-f]{40}$'),
  constraint intents_signature_format check (signature is null or signature ~ '^0x[0-9a-f]+$'),
  constraint intents_policy_hash_format check (policy_hash ~ '^0x[0-9a-f]{64}$'),
  constraint intents_execution_hash_format check (execution_hash ~ '^0x[0-9a-f]{64}$'),
  constraint intents_evidence_hash_format check (evidence_hash ~ '^0x[0-9a-f]{64}$'),
  constraint intents_tx_format check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
  constraint intents_state check (
    state in ('proposed', 'quoted', 'signed', 'queued', 'submitted', 'confirmed', 'rejected', 'expired', 'failed')
  ),
  constraint intents_nonce_nonnegative check (onchain_nonce >= 0),
  unique (chain_id, controller_address, onchain_nonce)
);

create index intents_agent_time_idx on agent_private.intents (agent_id, created_at desc);
create index intents_state_time_idx on agent_private.intents (state, created_at);
create index intents_tx_idx on agent_private.intents (transaction_hash)
  where transaction_hash is not null;

create table agent_private.policy_evaluations (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null references agent_private.intents(id) on delete cascade,
  approved boolean not null,
  policy_hash text not null,
  checks jsonb not null,
  rejection_code text,
  evaluated_at timestamptz not null default now(),
  constraint policy_evaluations_hash_format check (policy_hash ~ '^0x[0-9a-f]{64}$')
);

create index policy_evaluations_intent_time_idx
  on agent_private.policy_evaluations (intent_id, evaluated_at desc);

create table agent_private.execution_jobs (
  id uuid primary key default gen_random_uuid(),
  intent_id uuid not null unique references agent_private.intents(id) on delete cascade,
  state text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  transaction_hash text,
  signed_transaction text,
  chain_nonce numeric(78, 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint execution_jobs_state check (
    state in ('queued', 'processing', 'submitted', 'confirmed', 'failed', 'dead_letter')
  ),
  constraint execution_jobs_attempts check (attempts between 0 and 20),
  constraint execution_jobs_tx_format check (
    transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  constraint execution_jobs_signed_tx_format check (
    signed_transaction is null or signed_transaction ~ '^0x[0-9a-f]+$'
  )
);

create index execution_jobs_claim_idx
  on agent_private.execution_jobs (state, available_at, created_at)
  where state in ('queued', 'processing', 'submitted');

create table agent_private.execution_attempts (
  id bigint generated always as identity primary key,
  job_id uuid not null references agent_private.execution_jobs(id) on delete cascade,
  attempt integer not null,
  phase text not null,
  simulation_block numeric(78, 0),
  transaction_hash text,
  receipt_status text,
  error_code text,
  created_at timestamptz not null default now(),
  constraint execution_attempts_phase check (
    phase in ('claimed', 'simulated', 'broadcast', 'receipt', 'reorg_check', 'failed')
  ),
  constraint execution_attempts_receipt_status check (
    receipt_status is null or receipt_status in ('success', 'reverted', 'not_found')
  ),
  constraint execution_attempts_tx_format check (
    transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  unique (job_id, attempt, phase)
);

create index execution_attempts_job_time_idx
  on agent_private.execution_attempts (job_id, created_at desc);

create table agent_private.world_attestations (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  sponsor_wallet text not null,
  signer_address text not null,
  backing_hash text not null,
  agentbook_block numeric(78, 0) not null,
  valid_until timestamptz not null,
  verifier_signature text not null,
  registry_transaction_hash text,
  verified_at timestamptz not null default now(),
  constraint world_attestations_agent_id_format check (agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint world_attestations_sponsor_format check (sponsor_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint world_attestations_signer_format check (signer_address ~ '^0x[0-9a-f]{40}$'),
  constraint world_attestations_backing_hash_format check (backing_hash ~ '^0x[0-9a-f]{64}$'),
  constraint world_attestations_signature_format check (verifier_signature ~ '^0x[0-9a-f]+$'),
  constraint world_attestations_tx_format check (
    registry_transaction_hash is null or registry_transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  unique (agent_id, backing_hash)
);

create index world_attestations_agent_time_idx
  on agent_private.world_attestations (agent_id, verified_at desc);

create table agent_private.audit_log (
  id bigint generated always as identity primary key,
  actor_type text not null,
  actor_id text not null,
  action text not null,
  agent_id text,
  intent_id uuid,
  request_id uuid,
  payload_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint agent_audit_actor_type check (
    actor_type in ('agent', 'sponsor', 'gateway', 'worker', 'world_verifier', 'system')
  ),
  constraint agent_audit_agent_id_format check (agent_id is null or agent_id ~ '^0x[0-9a-f]{64}$'),
  constraint agent_audit_payload_hash_format check (payload_hash ~ '^0x[0-9a-f]{64}$')
);

create index agent_audit_agent_time_idx
  on agent_private.audit_log (agent_id, occurred_at desc)
  where agent_id is not null;
create index agent_audit_intent_time_idx
  on agent_private.audit_log (intent_id, occurred_at desc)
  where intent_id is not null;

-- Atomic non-blocking claim for concurrent relayer workers.
create or replace function agent_private.claim_execution_jobs(worker text, batch_size integer default 10)
returns setof agent_private.execution_jobs
language sql
volatile
security definer
set search_path = ''
as $$
  with candidates as (
    select job.id
    from agent_private.execution_jobs as job
    where job.attempts < 20
      and (
        (job.state = 'queued' and job.available_at <= now())
        or (job.state = 'processing' and job.locked_at < now() - interval '2 minutes')
        or (job.state = 'submitted' and job.updated_at < now() - interval '15 seconds')
      )
    order by job.available_at, job.created_at
    limit greatest(1, least(batch_size, 100))
    for update skip locked
  )
  update agent_private.execution_jobs as job
  set state = 'processing',
      attempts = job.attempts + 1,
      locked_by = worker,
      locked_at = now(),
      updated_at = now()
  from candidates
  where job.id = candidates.id
  returning job.*
$$;

revoke all on function agent_private.claim_execution_jobs(text, integer)
  from public, anon, authenticated;
grant execute on function agent_private.claim_execution_jobs(text, integer) to service_role;

create or replace function agent_private.reject_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'agent_private.audit_log is append-only';
end
$$;

revoke all on function agent_private.reject_audit_mutation()
  from public, anon, authenticated, service_role;

create trigger agent_audit_append_only
before update or delete on agent_private.audit_log
for each row execute function agent_private.reject_audit_mutation();

-- Explicit private privileges. audit_log intentionally has no UPDATE/DELETE grant.
grant select, insert, update, delete on
  agent_private.agent_nonces,
  agent_private.session_challenges,
  agent_private.agent_sessions,
  agent_private.heartbeats,
  agent_private.agent_events,
  agent_private.idempotency_keys,
  agent_private.vault_jobs,
  agent_private.proposals,
  agent_private.quotes,
  agent_private.intents,
  agent_private.policy_evaluations,
  agent_private.execution_jobs,
  agent_private.execution_attempts,
  agent_private.world_attestations
to service_role;

grant select, insert on agent_private.audit_log to service_role;
grant usage, select on all sequences in schema agent_private to service_role;

revoke all on all tables in schema agent_private from anon, authenticated;
revoke all on all sequences in schema agent_private from anon, authenticated;
revoke all on all functions in schema agent_private from anon, authenticated;

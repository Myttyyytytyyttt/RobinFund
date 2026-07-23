-- Durable, restart-safe deployment queue for AI vaults.

alter table agent_private.vault_jobs
  add column attempts integer not null default 0,
  add column available_at timestamptz not null default now(),
  add column locked_by text,
  add column locked_at timestamptz,
  add column deployment_account text,
  add column nonce_start bigint,
  add column deployment_plan jsonb;

alter table agent_private.vault_jobs
  drop constraint vault_jobs_state;

alter table agent_private.vault_jobs
  add constraint vault_jobs_state check (
    state in (
      'requested', 'preparing', 'deploying_controller', 'deploying_fund',
      'registering', 'awaiting_sponsor_bind', 'ready', 'failed'
    )
  ),
  add constraint vault_jobs_attempts check (attempts between 0 and 20),
  add constraint vault_jobs_deployment_account_format check (
    deployment_account is null or deployment_account ~ '^0x[0-9a-f]{40}$'
  ),
  add constraint vault_jobs_nonce_start check (nonce_start is null or nonce_start >= 0);

create unique index vault_jobs_agent_live_idx
  on agent_private.vault_jobs (agent_id)
  where state <> 'failed';

create index vault_jobs_claim_idx
  on agent_private.vault_jobs (available_at, created_at)
  where state in ('requested', 'preparing', 'deploying_controller', 'deploying_fund', 'registering');

create table agent_private.deployment_accounts (
  chain_id integer not null,
  account_address text not null,
  next_nonce bigint not null,
  updated_at timestamptz not null default now(),
  primary key (chain_id, account_address),
  constraint deployment_accounts_chain check (chain_id > 0),
  constraint deployment_accounts_address check (account_address ~ '^0x[0-9a-f]{40}$'),
  constraint deployment_accounts_nonce check (next_nonce >= 0)
);

-- Claims only World-backed profiles. Stale locks are recoverable by another worker.
create or replace function agent_private.claim_vault_jobs(worker text, batch_size integer default 1)
returns setof agent_private.vault_jobs
language sql
volatile
security definer
set search_path = ''
as $$
  with candidates as (
    select job.id
    from agent_private.vault_jobs as job
    join public.agent_profiles as profile on profile.agent_id = job.agent_id
    where job.attempts < 20
      and job.state in ('requested', 'preparing', 'deploying_controller', 'deploying_fund', 'registering')
      and job.available_at <= now()
      and (job.locked_at is null or job.locked_at < now() - interval '2 minutes')
      and profile.status = 'active'
      and profile.world_backed = true
      and profile.world_backed_until > now()
    order by job.available_at, job.created_at
    limit greatest(1, least(batch_size, 10))
    for update of job skip locked
  )
  update agent_private.vault_jobs as job
  set locked_by = worker,
      locked_at = now(),
      attempts = job.attempts + 1,
      updated_at = now()
  from candidates
  where job.id = candidates.id
  returning job.*
$$;

-- Reserves three contiguous nonces (controller CREATE, Fund CREATE, registry CALL)
-- atomically. A restart gets the same range rather than producing a second vault.
create or replace function agent_private.reserve_vault_nonce_range(
  job_id uuid,
  target_chain_id integer,
  deployer text,
  observed_nonce bigint
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing_nonce bigint;
  reserved_nonce bigint;
begin
  if target_chain_id <= 0 or deployer !~ '^0x[0-9a-f]{40}$' or observed_nonce < 0 then
    raise exception 'invalid deployment nonce request';
  end if;

  select nonce_start into existing_nonce
  from agent_private.vault_jobs
  where id = job_id
  for update;

  if not found then raise exception 'unknown vault job'; end if;
  if existing_nonce is not null then return existing_nonce; end if;

  insert into agent_private.deployment_accounts (chain_id, account_address, next_nonce)
  values (target_chain_id, deployer, observed_nonce)
  on conflict (chain_id, account_address) do nothing;

  select greatest(next_nonce, observed_nonce) into reserved_nonce
  from agent_private.deployment_accounts
  where chain_id = target_chain_id and account_address = deployer
  for update;

  update agent_private.deployment_accounts
  set next_nonce = reserved_nonce + 3, updated_at = now()
  where chain_id = target_chain_id and account_address = deployer;

  update agent_private.vault_jobs
  set nonce_start = reserved_nonce,
      deployment_account = deployer,
      state = 'preparing',
      updated_at = now()
  where id = job_id;

  return reserved_nonce;
end
$$;

revoke all on function agent_private.claim_vault_jobs(text, integer)
  from public, anon, authenticated;
revoke all on function agent_private.reserve_vault_nonce_range(uuid, integer, text, bigint)
  from public, anon, authenticated;
grant execute on function agent_private.claim_vault_jobs(text, integer) to service_role;
grant execute on function agent_private.reserve_vault_nonce_range(uuid, integer, text, bigint) to service_role;

revoke all on table agent_private.deployment_accounts from public, anon, authenticated;
grant select, insert, update on table agent_private.deployment_accounts to service_role;


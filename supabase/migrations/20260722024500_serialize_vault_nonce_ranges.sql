-- A dedicated deployment account must never reserve a later nonce range while an
-- earlier range is waiting for retry. This avoids nonce gaps across worker replicas.

create or replace function agent_private.claim_vault_jobs(worker text, batch_size integer default 1)
returns setof agent_private.vault_jobs
language sql
volatile
security definer
set search_path = ''
as $$
  with reserved as (
    select job.id
    from agent_private.vault_jobs as job
    where job.nonce_start is not null
      and job.state in ('preparing', 'deploying_controller', 'deploying_fund', 'registering')
    order by job.nonce_start
    limit 1
  ),
  candidates as (
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
      and (
        not exists (select 1 from reserved)
        or job.id = (select id from reserved)
      )
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

create or replace function agent_private.release_unused_vault_nonce_range(
  job_id uuid,
  target_chain_id integer,
  deployer text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reserved_nonce bigint;
  account_next_nonce bigint;
  has_plan boolean;
begin
  select nonce_start, deployment_plan is not null
  into reserved_nonce, has_plan
  from agent_private.vault_jobs
  where id = job_id
  for update;
  if not found then raise exception 'unknown vault job'; end if;
  if reserved_nonce is null then return; end if;
  if has_plan then raise exception 'cannot release persisted deployment transactions'; end if;

  select next_nonce into account_next_nonce
  from agent_private.deployment_accounts
  where chain_id = target_chain_id and account_address = deployer
  for update;
  if account_next_nonce <> reserved_nonce + 3 then
    raise exception 'a later deployment nonce range already exists';
  end if;

  update agent_private.deployment_accounts
  set next_nonce = reserved_nonce, updated_at = now()
  where chain_id = target_chain_id and account_address = deployer;
  update agent_private.vault_jobs
  set nonce_start = null, deployment_account = null, updated_at = now()
  where id = job_id;
end
$$;

revoke all on function agent_private.release_unused_vault_nonce_range(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function agent_private.release_unused_vault_nonce_range(uuid, integer, text)
  to service_role;


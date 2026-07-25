-- Serialize request-driven vault claims until the current worker either
-- reserves its nonce range or releases the job. Successful receipt polling
-- must not consume the retry budget: attempts now counts worker failures only.

create or replace function agent_private.claim_vault_jobs(
  worker text,
  batch_size integer default 1
)
returns setof agent_private.vault_jobs
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- A transaction-scoped lock gives concurrent serverless isolates a fresh
  -- snapshot after the previous claim commits.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('agent_private.claim_vault_jobs', 0)
  );

  return query
  with blocker as (
    select job.id
    from agent_private.vault_jobs as job
    where job.state in (
      'requested',
      'preparing',
      'deploying_controller',
      'deploying_fund',
      'registering'
    )
      and (
        job.nonce_start is not null
        or (
          job.locked_at is not null
          and job.locked_at >= pg_catalog.now() - interval '2 minutes'
        )
      )
    order by
      case when job.nonce_start is not null then 0 else 1 end,
      job.nonce_start nulls last,
      job.locked_at nulls last,
      job.created_at
    limit 1
  ),
  candidates as (
    select job.id
    from agent_private.vault_jobs as job
    join public.agent_profiles as profile on profile.agent_id = job.agent_id
    where job.attempts < 20
      and job.state in (
        'requested',
        'preparing',
        'deploying_controller',
        'deploying_fund',
        'registering'
      )
      and job.available_at <= pg_catalog.now()
      and (
        job.locked_at is null
        or job.locked_at < pg_catalog.now() - interval '2 minutes'
      )
      and profile.status = 'active'
      and profile.world_backed = true
      and profile.world_backed_until > pg_catalog.now()
      and (
        not exists (select 1 from blocker)
        or job.id = (select id from blocker)
      )
    order by job.available_at, job.created_at
    limit greatest(1, least(batch_size, 10))
    for update of job skip locked
  )
  update agent_private.vault_jobs as job
  set locked_by = worker,
      locked_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  from candidates
  where job.id = candidates.id
  returning job.*;
end
$$;

-- Old values counted successful polls, so they cannot safely be reused as a
-- failure budget after this migration.
update agent_private.vault_jobs
set attempts = 0,
    updated_at = pg_catalog.now()
where state in (
  'requested',
  'preparing',
  'deploying_controller',
  'deploying_fund',
  'registering'
)
  and attempts <> 0;

revoke all on function agent_private.claim_vault_jobs(text, integer)
  from public, anon, authenticated;
grant execute on function agent_private.claim_vault_jobs(text, integer)
  to service_role;

-- Cover foreign keys used by session cleanup and intent lifecycle joins.
-- agent_private remains isolated by schema/table ACLs; only service_role has access.

create index if not exists heartbeats_session_idx
  on agent_private.heartbeats (session_id)
  where session_id is not null;

create index if not exists intents_proposal_idx
  on agent_private.intents (proposal_id);

create index if not exists intents_quote_idx
  on agent_private.intents (quote_id);

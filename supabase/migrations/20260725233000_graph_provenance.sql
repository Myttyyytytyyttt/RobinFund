alter table agent_private.proposals
  add column if not exists graph_chain_id integer not null default 4663,
  add column if not exists graph_block_hash text,
  add column if not exists graph_block_lag numeric(78, 0) not null default 0,
  add column if not exists graph_indexing_errors boolean not null default false,
  add column if not exists graph_age_seconds double precision not null default 0;

alter table agent_private.proposals
  drop constraint if exists proposals_graph_block_hash_format;

alter table agent_private.proposals
  add constraint proposals_graph_block_hash_format
  check (graph_block_hash is null or graph_block_hash ~ '^0x[0-9a-f]{64}$');

alter table agent_private.proposals
  drop constraint if exists proposals_graph_indexing_errors_false;

alter table agent_private.proposals
  add constraint proposals_graph_indexing_errors_false
  check (graph_indexing_errors = false);

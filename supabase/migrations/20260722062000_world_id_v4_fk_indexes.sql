-- Cover World ID private-table foreign keys used by cleanup and sponsor joins.

create index world_id_agent_bindings_source_request_idx
  on agent_private.world_id_agent_bindings (source_request_id)
  where source_request_id is not null;

create index world_id_agent_bindings_sponsor_human_idx
  on agent_private.world_id_agent_bindings (sponsor_wallet, human_hash);

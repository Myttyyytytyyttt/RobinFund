-- World ID 4.0 scopes staging vs production on the proof request/action.
-- Unlike legacy World ID applications, an RP can use the same app_* identifier
-- in both environments. Keep the app/rp format and environment allow-list
-- constraints, but remove the obsolete prefix coupling.

alter table agent_private.world_identity_requests
  drop constraint world_identity_requests_app_environment;

alter table agent_private.world_identity_sponsors
  drop constraint world_identity_sponsors_app_environment;

alter table agent_private.world_identity_agent_bindings
  drop constraint world_identity_bindings_app_environment;

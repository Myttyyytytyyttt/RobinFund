-- RP nonces and their signatures are short-lived capabilities. The gateway
-- returns them once and persists only a safe replay response.

update agent_private.idempotency_keys
set
  status_code = 409,
  response_body = jsonb_build_object(
    'error',
    jsonb_build_object(
      'code', 'WORLD_ID_REQUEST_ALREADY_ISSUED',
      'message', 'Request a fresh World ID challenge'
    )
  )
where scope like 'world-id-request:%';

alter table agent_private.idempotency_keys
  add constraint idempotency_world_id_request_has_no_rp_context
  check (
    scope not like 'world-id-request:%'
    or response_body #> '{worldId,rpContext}' is null
  );

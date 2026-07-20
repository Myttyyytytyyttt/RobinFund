-- NuvemFund v1.0 launches permissionless. Keep the previously reviewed schema only as an
-- inert historical module and make the browser boundary explicit.

comment on schema compliance_private is
  'ARCHIVED 2026-07-20: NuvemFund launches permissionless. Not used by website, indexer, keeper, or contracts.';

comment on table compliance_private.subjects is
  'ARCHIVED: legacy compliance signer data model; inactive in permissionless mode.';
comment on table compliance_private.wallet_bindings is
  'ARCHIVED: legacy compliance signer data model; inactive in permissionless mode.';
comment on table compliance_private.decisions is
  'ARCHIVED: legacy compliance signer data model; inactive in permissionless mode.';
comment on table compliance_private.audit_log is
  'ARCHIVED: legacy compliance signer data model; inactive in permissionless mode.';

revoke all on schema compliance_private from anon, authenticated;
revoke all on all tables in schema compliance_private from anon, authenticated;
revoke all on all sequences in schema compliance_private from anon, authenticated;
revoke all on all functions in schema compliance_private from anon, authenticated;

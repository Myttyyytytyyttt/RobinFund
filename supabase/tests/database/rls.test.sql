begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(20);

select extensions.ok(
  not has_schema_privilege('anon', 'compliance_private', 'usage'),
  'anon cannot enter the compliance schema'
);
select extensions.ok(
  not has_schema_privilege('authenticated', 'compliance_private', 'usage'),
  'authenticated clients cannot enter the compliance schema'
);
select extensions.ok(
  not has_table_privilege('anon', 'agent_private.world_identity_requests', 'select'),
  'anonymous clients cannot read World Identity requests'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'agent_private.world_identity_requests', 'select'),
  'authenticated clients cannot read World Identity requests'
);
select extensions.ok(
  not has_table_privilege('anon', 'agent_private.world_identity_sponsors', 'select'),
  'anonymous clients cannot read World Identity sponsor ownership'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'agent_private.world_identity_sponsors', 'select'),
  'authenticated clients cannot read World Identity sponsor ownership'
);
select extensions.ok(
  not has_table_privilege('anon', 'agent_private.world_identity_agent_bindings', 'select'),
  'anonymous clients cannot read World Identity bindings'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'agent_private.world_identity_agent_bindings', 'select'),
  'authenticated clients cannot read World Identity bindings'
);
select extensions.ok(
  not has_function_privilege('anon', 'agent_private.claim_vault_jobs(text, integer)', 'execute'),
  'anonymous clients cannot trigger the serialized vault worker claim'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'agent_private.claim_vault_jobs(text, integer)', 'execute'),
  'authenticated clients cannot trigger the serialized vault worker claim'
);
select extensions.ok(
  has_function_privilege('service_role', 'agent_private.claim_vault_jobs(text, integer)', 'execute'),
  'only the backend service role can trigger the serialized vault worker claim'
);

insert into auth.users (
  id, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '11111111-1111-1111-1111-111111111111',
    'authenticated', 'authenticated', '{}'::jsonb,
    '{"address":"0x9999999999999999999999999999999999999999"}'::jsonb,
    now(), now()
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb,
    now(), now()
  );

insert into auth.identities (
  provider_id, user_id, identity_data, provider, created_at, updated_at
) values
  (
    'web3:ethereum:0x1111111111111111111111111111111111111111',
    '11111111-1111-1111-1111-111111111111',
    '{"address":"0x1111111111111111111111111111111111111111","chain":"ethereum"}'::jsonb,
    'web3', now(), now()
  ),
  (
    'web3:ethereum:0x2222222222222222222222222222222222222222',
    '22222222-2222-2222-2222-222222222222',
    '{"address":"0x2222222222222222222222222222222222222222","chain":"ethereum"}'::jsonb,
    'web3', now(), now()
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

select extensions.is(
  app_private.current_web3_address(),
  '0x1111111111111111111111111111111111111111',
  'RLS derives the wallet from the Web3 identity, not editable metadata'
);

select extensions.lives_ok(
  $$insert into public.profiles (wallet_address, username)
    values ('0x1111111111111111111111111111111111111111', 'alice')$$,
  'a SIWE user can create the profile for its own wallet'
);

select extensions.throws_like(
  $$insert into public.profiles (wallet_address, username)
    values ('0x3333333333333333333333333333333333333333', 'mallory')$$,
  '%row-level security%',
  'a SIWE user cannot claim another wallet'
);

reset role;
set local role anon;

select extensions.is(
  (select count(*) from public.profiles),
  1::bigint,
  'public profile reads work for anonymous visitors'
);

select extensions.throws_like(
  $$insert into public.profiles (wallet_address, username)
    values ('0x4444444444444444444444444444444444444444', 'anonymous')$$,
  '%permission denied%',
  'anonymous visitors cannot create profiles'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

select extensions.lives_ok(
  $$insert into public.profiles (wallet_address, username)
    values ('0x2222222222222222222222222222222222222222', 'bob')$$,
  'a second SIWE identity can create its own profile'
);

select extensions.lives_ok(
  $$update public.profiles
    set username = 'stolen'
    where wallet_address = '0x1111111111111111111111111111111111111111'$$,
  'an update targeting another wallet is filtered without leaking row existence'
);

select extensions.is(
  (select username::text from public.profiles
   where wallet_address = '0x1111111111111111111111111111111111111111'),
  'alice',
  'one wallet cannot change another wallet profile'
);

select extensions.throws_like(
  $$update public.profiles
    set username = 'alice'
    where wallet_address = '0x2222222222222222222222222222222222222222'$$,
  '%duplicate key%',
  'usernames remain globally unique under concurrent clients'
);

select * from extensions.finish();
rollback;

-- NuvemFund application database.
--
-- Boundaries:
--   public             Social/profile data exposed through the Data API under RLS.
--   compliance_private Opaque compliance records; never exposed to browser roles.
--   ponder             Reserved for Ponder's derived on-chain read model.
--
-- Financial truth remains on Robinhood Chain. Ponder is a rebuildable projection;
-- Supabase stores only application/social state and private compliance metadata.

create extension if not exists citext with schema extensions;

create schema if not exists app_private;
create schema if not exists compliance_private;
create schema if not exists ponder;

revoke all on schema app_private from public, anon, authenticated;
revoke all on schema compliance_private from public, anon, authenticated;
revoke all on schema ponder from public, anon, authenticated;

grant usage on schema app_private to authenticated, service_role;
grant usage on schema compliance_private to service_role;
grant usage on schema ponder to service_role;

-- New public objects must be explicitly granted. This keeps a forgotten table
-- from becoming reachable through PostgREST/GraphQL by accident.
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

-- Derive the wallet from the immutable Web3 identity created by Supabase SIWE.
-- provider_id has the form web3:ethereum:<address>. GoTrue has moved the same
-- address between identity_data.address and identity_data.custom_claims.address
-- across releases, so provider_id is the stable source. Never trust editable
-- user metadata.
create or replace function app_private.current_web3_address()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(split_part(identity.provider_id, ':', 3))
  from auth.identities as identity
  where identity.user_id = (select auth.uid())
    and identity.provider = 'web3'
    and identity.provider_id ~ '^web3:ethereum:0x[0-9A-Fa-f]{40}$'
  order by identity.created_at asc
  limit 1
$$;

revoke all on function app_private.current_web3_address() from public, anon;
grant execute on function app_private.current_web3_address() to authenticated, service_role;

create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

revoke all on function app_private.set_updated_at() from public, anon, authenticated;
grant execute on function app_private.set_updated_at() to service_role;

-- ---------------------------------------------------------------------------
-- Public application model
-- ---------------------------------------------------------------------------

create table public.profiles (
  wallet_address text primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  username extensions.citext not null,
  twitter_username extensions.citext,
  twitter_verified boolean not null default false,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_owner_unique unique (owner_id),
  constraint profiles_wallet_format check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  constraint profiles_username_format check (username::text ~ '^[A-Za-z0-9_]{3,20}$'),
  constraint profiles_twitter_format check (
    twitter_username is null or twitter_username::text ~ '^[A-Za-z0-9_]{1,15}$'
  ),
  constraint profiles_avatar_url_length check (avatar_url is null or length(avatar_url) <= 2048),
  constraint profiles_bio_length check (bio is null or length(bio) <= 280)
);

create unique index profiles_username_unique_idx on public.profiles (username);
create unique index profiles_verified_twitter_unique_idx
  on public.profiles (twitter_username)
  where twitter_verified and twitter_username is not null;
create index profiles_created_at_idx on public.profiles (created_at desc);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function app_private.set_updated_at();

alter table public.profiles enable row level security;

create policy profiles_public_read
on public.profiles
for select
to anon, authenticated
using (true);

create policy profiles_insert_own_verified_wallet
on public.profiles
for insert
to authenticated
with check (
  owner_id = (select auth.uid())
  and wallet_address = (select app_private.current_web3_address())
);

create policy profiles_update_own_verified_wallet
on public.profiles
for update
to authenticated
using (owner_id = (select auth.uid()))
with check (
  owner_id = (select auth.uid())
  and wallet_address = (select app_private.current_web3_address())
);

create policy profiles_delete_own
on public.profiles
for delete
to authenticated
using (owner_id = (select auth.uid()));

revoke all on public.profiles from anon, authenticated;
grant select (
  wallet_address, username, twitter_username, twitter_verified,
  avatar_url, bio, created_at, updated_at
) on public.profiles to anon, authenticated;
grant insert (
  wallet_address, username, twitter_username, avatar_url, bio
) on public.profiles to authenticated;
grant update (
  username, twitter_username, avatar_url, bio
) on public.profiles to authenticated;
grant delete on public.profiles to authenticated;
grant all on public.profiles to service_role;

create table public.follows (
  follower_wallet text not null references public.profiles(wallet_address) on delete cascade,
  followed_wallet text not null references public.profiles(wallet_address) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_wallet, followed_wallet),
  constraint follows_not_self check (follower_wallet <> followed_wallet)
);

create index follows_followed_created_idx
  on public.follows (followed_wallet, created_at desc);

alter table public.follows enable row level security;

create policy follows_public_read
on public.follows
for select
to anon, authenticated
using (true);

create policy follows_insert_own
on public.follows
for insert
to authenticated
with check (follower_wallet = (select app_private.current_web3_address()));

create policy follows_delete_own
on public.follows
for delete
to authenticated
using (follower_wallet = (select app_private.current_web3_address()));

revoke all on public.follows from anon, authenticated;
grant select on public.follows to anon, authenticated;
grant insert, delete on public.follows to authenticated;
grant all on public.follows to service_role;

create table public.fund_channels (
  fund_address text primary key,
  title text not null,
  manager_wallet text not null,
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fund_channels_fund_format check (fund_address ~ '^0x[0-9a-f]{40}$'),
  constraint fund_channels_manager_format check (manager_wallet ~ '^0x[0-9a-f]{40}$'),
  constraint fund_channels_title_length check (length(title) between 1 and 100)
);

create index fund_channels_manager_idx on public.fund_channels (manager_wallet);

create trigger fund_channels_set_updated_at
before update on public.fund_channels
for each row execute function app_private.set_updated_at();

alter table public.fund_channels enable row level security;

create policy fund_channels_public_read
on public.fund_channels
for select
to anon, authenticated
using (is_public);

revoke all on public.fund_channels from anon, authenticated;
grant select on public.fund_channels to anon, authenticated;
grant all on public.fund_channels to service_role;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  fund_address text not null references public.fund_channels(fund_address) on delete cascade,
  author_wallet text not null references public.profiles(wallet_address) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint messages_body_length check (length(body) between 1 and 2000)
);

create index messages_fund_created_idx
  on public.messages (fund_address, created_at desc)
  where deleted_at is null;
create index messages_author_created_idx
  on public.messages (author_wallet, created_at desc);

create trigger messages_set_updated_at
before update on public.messages
for each row execute function app_private.set_updated_at();

alter table public.messages enable row level security;

create policy messages_public_read
on public.messages
for select
to anon, authenticated
using (
  deleted_at is null
  and exists (
    select 1
    from public.fund_channels as channel
    where channel.fund_address = messages.fund_address
      and channel.is_public
  )
);

create policy messages_insert_own
on public.messages
for insert
to authenticated
with check (
  author_wallet = (select app_private.current_web3_address())
  and exists (
    select 1
    from public.fund_channels as channel
    where channel.fund_address = messages.fund_address
      and channel.is_public
  )
);

create policy messages_update_own
on public.messages
for update
to authenticated
using (author_wallet = (select app_private.current_web3_address()))
with check (author_wallet = (select app_private.current_web3_address()));

create policy messages_delete_own
on public.messages
for delete
to authenticated
using (author_wallet = (select app_private.current_web3_address()));

revoke all on public.messages from anon, authenticated;
grant select on public.messages to anon, authenticated;
grant insert (fund_address, author_wallet, body) on public.messages to authenticated;
grant update (body, deleted_at) on public.messages to authenticated;
grant delete on public.messages to authenticated;
grant all on public.messages to service_role;

create table public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  reactor_wallet text not null references public.profiles(wallet_address) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, reactor_wallet, emoji),
  constraint message_reactions_emoji_length check (length(emoji) between 1 and 16)
);

create index message_reactions_reactor_idx
  on public.message_reactions (reactor_wallet, created_at desc);

alter table public.message_reactions enable row level security;

create policy message_reactions_public_read
on public.message_reactions
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.messages as message
    join public.fund_channels as channel
      on channel.fund_address = message.fund_address
    where message.id = message_reactions.message_id
      and message.deleted_at is null
      and channel.is_public
  )
);

create policy message_reactions_insert_own
on public.message_reactions
for insert
to authenticated
with check (
  reactor_wallet = (select app_private.current_web3_address())
  and exists (
    select 1
    from public.messages as message
    join public.fund_channels as channel
      on channel.fund_address = message.fund_address
    where message.id = message_reactions.message_id
      and message.deleted_at is null
      and channel.is_public
  )
);

create policy message_reactions_delete_own
on public.message_reactions
for delete
to authenticated
using (reactor_wallet = (select app_private.current_web3_address()));

revoke all on public.message_reactions from anon, authenticated;
grant select on public.message_reactions to anon, authenticated;
grant insert, delete on public.message_reactions to authenticated;
grant all on public.message_reactions to service_role;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_wallet text not null references public.profiles(wallet_address) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_kind_length check (length(kind) between 1 and 64),
  constraint notifications_payload_object check (jsonb_typeof(payload) = 'object')
);

create index notifications_recipient_unread_idx
  on public.notifications (recipient_wallet, created_at desc)
  where read_at is null;

alter table public.notifications enable row level security;

create policy notifications_read_own
on public.notifications
for select
to authenticated
using (recipient_wallet = (select app_private.current_web3_address()));

create policy notifications_update_own
on public.notifications
for update
to authenticated
using (recipient_wallet = (select app_private.current_web3_address()))
with check (recipient_wallet = (select app_private.current_web3_address()));

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- ---------------------------------------------------------------------------
-- Private compliance model (opaque identifiers only; no browser grants)
-- ---------------------------------------------------------------------------

create table compliance_private.subjects (
  id uuid primary key default gen_random_uuid(),
  provider_subject text not null unique,
  status text not null default 'pending',
  jurisdiction text,
  us_person boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint compliance_subject_status check (status in ('pending', 'admitted', 'revoked', 'rejected')),
  constraint compliance_provider_subject_length check (length(provider_subject) between 1 and 255)
);

create table compliance_private.wallet_bindings (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references compliance_private.subjects(id) on delete restrict,
  wallet_address text not null,
  admitted_at timestamptz not null default now(),
  released_at timestamptz,
  release_cause text,
  constraint compliance_wallet_format check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  constraint compliance_release_cause check (
    release_cause is null or release_cause in ('revoked', 'rotated')
  ),
  constraint compliance_release_pair check (
    (released_at is null and release_cause is null)
    or (released_at is not null and release_cause is not null)
  )
);

create unique index compliance_one_active_wallet_per_subject_idx
  on compliance_private.wallet_bindings (subject_id)
  where released_at is null;
create unique index compliance_one_subject_per_active_wallet_idx
  on compliance_private.wallet_bindings (wallet_address)
  where released_at is null;
create index compliance_wallet_history_idx
  on compliance_private.wallet_bindings (wallet_address, admitted_at desc);

create table compliance_private.decisions (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references compliance_private.subjects(id) on delete restrict,
  wallet_address text not null,
  decision text not null,
  reason_codes text[] not null default '{}',
  policy_version text not null,
  request_id text,
  occurred_at timestamptz not null default now(),
  constraint compliance_decision_wallet_format check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  constraint compliance_decision_value check (decision in ('admit', 'renew', 'revoke', 'reject')),
  constraint compliance_policy_version_length check (length(policy_version) between 1 and 64)
);

create index compliance_decisions_subject_time_idx
  on compliance_private.decisions (subject_id, occurred_at desc);
create index compliance_decisions_wallet_time_idx
  on compliance_private.decisions (wallet_address, occurred_at desc);

create table compliance_private.audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  subject_id uuid references compliance_private.subjects(id) on delete restrict,
  wallet_address text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint compliance_audit_details_object check (jsonb_typeof(details) = 'object'),
  constraint compliance_audit_wallet_format check (
    wallet_address is null or wallet_address ~ '^0x[0-9a-f]{40}$'
  )
);

create index compliance_audit_subject_time_idx
  on compliance_private.audit_log (subject_id, occurred_at desc);
create index compliance_audit_wallet_time_idx
  on compliance_private.audit_log (wallet_address, occurred_at desc)
  where wallet_address is not null;

alter table compliance_private.subjects enable row level security;
alter table compliance_private.wallet_bindings enable row level security;
alter table compliance_private.decisions enable row level security;
alter table compliance_private.audit_log enable row level security;

revoke all on all tables in schema compliance_private from public, anon, authenticated;
revoke all on all sequences in schema compliance_private from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema compliance_private to service_role;
grant usage, select on all sequences in schema compliance_private to service_role;

comment on schema ponder is
  'Ponder-managed, rebuildable on-chain projection. Configure Ponder with DATABASE_SCHEMA=ponder.';
comment on schema compliance_private is
  'Private compliance metadata. Never expose this schema through the browser Data API.';
comment on table public.profiles is
  'Wallet-bound social profiles. Wallet ownership is enforced from Supabase Web3 identities.';

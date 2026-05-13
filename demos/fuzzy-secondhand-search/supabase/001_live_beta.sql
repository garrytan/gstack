create schema if not exists fuzzy_secondhand;
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists fuzzy_secondhand.listing_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  name text not null,
  homepage_url text,
  adapter text not null,
  enabled boolean not null default true,
  crawl_delay_seconds integer not null default 10 check (crawl_delay_seconds >= 0),
  terms_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fuzzy_secondhand.listings (
  id text primary key,
  source_id uuid references fuzzy_secondhand.listing_sources(id) on delete set null,
  source_listing_id text,
  source_url text not null unique,
  source_name text not null,
  category text not null check (category in ('car', 'motorcycle', 'house', 'electronics', 'furniture')),
  title text not null,
  description text,
  price integer not null check (price >= 0),
  currency text not null default 'Rp',
  location text not null default 'Indonesia',
  condition integer not null default 72 check (condition between 0 and 100),
  seller_risk integer not null default 28 check (seller_risk between 0 and 100),
  market_low integer not null check (market_low >= 0),
  market_high integer not null check (market_high >= 0),
  image_url text,
  image_gradient text,
  attributes jsonb not null default '{}'::jsonb,
  raw_record jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'stale', 'hidden')),
  first_seen_at timestamptz not null default now(),
  seen_at timestamptz not null default now(),
  stale_after timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, source_listing_id)
);

create table if not exists fuzzy_secondhand.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  status text not null check (status in ('running', 'complete', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched_count integer not null default 0 check (fetched_count >= 0),
  upserted_count integer not null default 0 check (upserted_count >= 0),
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists fuzzy_secondhand.beta_invites (
  email text primary key,
  user_id uuid unique,
  role text not null default 'beta_user',
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  notes text
);

create table if not exists fuzzy_secondhand.saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email text not null,
  query text not null,
  cadence text not null default 'daily' check (cadence in ('instant', 'daily', 'weekly')),
  active boolean not null default true,
  last_sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists fuzzy_secondhand.search_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email text not null,
  query text not null,
  intent jsonb not null default '{}'::jsonb,
  result_count integer not null default 0,
  top_listing_id text,
  created_at timestamptz not null default now()
);

create index if not exists idx_fuzzy_listings_status_stale on fuzzy_secondhand.listings (status, stale_after desc);
create index if not exists idx_fuzzy_listings_category_price on fuzzy_secondhand.listings (category, price);
create index if not exists idx_fuzzy_listings_title_trgm on fuzzy_secondhand.listings using gin (title gin_trgm_ops);
create index if not exists idx_fuzzy_listings_attributes on fuzzy_secondhand.listings using gin (attributes);
create index if not exists idx_fuzzy_search_events_user_created on fuzzy_secondhand.search_events (user_id, created_at desc);
create index if not exists idx_fuzzy_saved_searches_user_active on fuzzy_secondhand.saved_searches (user_id, active);

alter table fuzzy_secondhand.listing_sources enable row level security;
alter table fuzzy_secondhand.listings enable row level security;
alter table fuzzy_secondhand.ingestion_runs enable row level security;
alter table fuzzy_secondhand.beta_invites enable row level security;
alter table fuzzy_secondhand.saved_searches enable row level security;
alter table fuzzy_secondhand.search_events enable row level security;

drop policy if exists saved_searches_owner_select on fuzzy_secondhand.saved_searches;
create policy saved_searches_owner_select
  on fuzzy_secondhand.saved_searches
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists saved_searches_owner_update on fuzzy_secondhand.saved_searches;
create policy saved_searches_owner_update
  on fuzzy_secondhand.saved_searches
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function fuzzy_secondhand.claim_beta_invite(p_email text, p_user_id uuid)
returns table(email text, user_id uuid, accepted_at timestamptz)
language plpgsql
security definer
set search_path = fuzzy_secondhand, public
as $$
declare
  accepted_count integer;
begin
  select count(*) into accepted_count
  from beta_invites
  where beta_invites.accepted_at is not null;

  if accepted_count >= 100 and not exists (
    select 1
    from beta_invites
    where lower(beta_invites.email) = lower(p_email)
      and beta_invites.accepted_at is not null
  ) then
    raise exception 'beta user limit reached' using errcode = 'P0001';
  end if;

  update beta_invites
  set user_id = coalesce(beta_invites.user_id, p_user_id),
      accepted_at = coalesce(beta_invites.accepted_at, now())
  where lower(beta_invites.email) = lower(p_email)
    and (beta_invites.user_id is null or beta_invites.user_id = p_user_id)
  returning beta_invites.email, beta_invites.user_id, beta_invites.accepted_at
  into email, user_id, accepted_at;

  if email is null then
    raise exception 'beta invite required' using errcode = 'P0001';
  end if;

  return next;
end;
$$;

revoke all on schema fuzzy_secondhand from anon, authenticated;
grant usage on schema fuzzy_secondhand to service_role;
grant all on all tables in schema fuzzy_secondhand to service_role;
grant execute on function fuzzy_secondhand.claim_beta_invite(text, uuid) to service_role;

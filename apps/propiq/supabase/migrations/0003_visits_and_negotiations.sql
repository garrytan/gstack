-- ---------------------------------------------------------------------------
-- Site visits and negotiations.
--
-- Both are user-owned and private. A site visit is the only first-party
-- evidence in the product, so it is kept per user rather than pooled: what one
-- buyer saw on one morning is their observation, not a market fact, and must
-- not leak into another user's score.
-- ---------------------------------------------------------------------------

create type visit_status as enum ('scheduled', 'completed', 'cancelled');

create type negotiation_status as enum (
  'preparing', 'offerMade', 'countered', 'agreed', 'walkedAway', 'lost'
);

create table site_visits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  property_id   text not null references properties(id) on delete cascade,
  scheduled_for date not null,
  status        visit_status not null default 'scheduled',
  completed_at  timestamptz,
  -- Observations are a variable-length list keyed by checklist id and are
  -- never filtered on, so JSONB rather than a child table.
  observations  jsonb not null default '[]'::jsonb,
  overall_note  text,
  created_at    timestamptz not null default now(),
  -- A visit cannot be complete without a completion time.
  constraint site_visits_completed_has_time check (
    status <> 'completed' or completed_at is not null
  )
);

create index site_visits_user_idx on site_visits (user_id, scheduled_for desc);
create index site_visits_property_idx on site_visits (user_id, property_id);

create table negotiations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  property_id     text not null references properties(id) on delete cascade,
  asking_price    numeric(14, 2) not null,
  fair_value_mid  numeric(14, 2),
  target_price    numeric(14, 2) not null,
  -- The number set while calm. Recording it before the first offer is the
  -- entire point of the model, so it is NOT NULL.
  walk_away_price numeric(14, 2) not null,
  status          negotiation_status not null default 'preparing',
  offers          jsonb not null default '[]'::jsonb,
  outcome_price   numeric(14, 2),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One live negotiation per property per user.
  unique (user_id, property_id),
  constraint negotiations_walkaway_at_least_target check (walk_away_price >= target_price)
);

create index negotiations_user_idx on negotiations (user_id, updated_at desc);

-- RLS: owner-only, every verb. Same rule as every other user-owned table.

alter table site_visits  enable row level security;
alter table negotiations enable row level security;

create policy "own visits: read"   on site_visits for select using (auth.uid() = user_id);
create policy "own visits: insert" on site_visits for insert with check (auth.uid() = user_id);
create policy "own visits: update" on site_visits for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own visits: delete" on site_visits for delete using (auth.uid() = user_id);

create policy "own negotiations: read"   on negotiations for select using (auth.uid() = user_id);
create policy "own negotiations: insert" on negotiations for insert with check (auth.uid() = user_id);
create policy "own negotiations: update" on negotiations for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own negotiations: delete" on negotiations for delete using (auth.uid() = user_id);

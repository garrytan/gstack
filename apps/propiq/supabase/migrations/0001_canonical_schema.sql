-- ---------------------------------------------------------------------------
-- PropIQ canonical schema.
--
-- Design notes:
--  * Real tables and real foreign keys. The property hierarchy is relational,
--    so it is modelled relationally rather than as a JSON document dump.
--  * `data_status` appears on every table that can carry a fact, and is the
--    column production queries filter on to exclude demo rows.
--  * Reference data (cities, projects, properties) is world-readable; anything
--    user-owned is locked behind RLS on auth.uid().
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

-- Shared enums -------------------------------------------------------------

create type data_status as enum ('verified', 'derived', 'estimated', 'demo');

create type source_type as enum (
  'rera', 'registry', 'developer', 'listing', 'transaction', 'survey',
  'government', 'partner', 'user', 'model', 'fixture'
);

create type review_state as enum ('unreviewed', 'machine_checked', 'human_verified', 'disputed');

create type property_kind as enum ('apartment', 'villa', 'plot', 'rowHouse', 'studio', 'penthouse');

create type construction_status as enum (
  'preLaunch', 'underConstruction', 'nearingPossession', 'readyToMove', 'resale'
);

create type area_basis as enum ('carpet', 'builtUp', 'superBuiltUp');

create type rera_status as enum ('registered', 'expired', 'lapsed', 'notRegistered', 'unknown');

create type pipeline_status as enum (
  'announced', 'approved', 'funded', 'underConstruction', 'commissioned'
);

-- Geography ----------------------------------------------------------------

create table cities (
  id            text primary key,
  name          text not null,
  slug          text not null unique,
  state         text not null,
  lat           double precision not null,
  lng           double precision not null,
  coverage      text not null default 'planned'
                check (coverage in ('live', 'preview', 'planned')),
  created_at    timestamptz not null default now()
);

create table micro_markets (
  id            text primary key,
  city_id       text not null references cities(id) on delete cascade,
  name          text not null,
  slug          text not null,
  unique (city_id, slug)
);

create table localities (
  id                            text primary key,
  city_id                       text not null references cities(id) on delete cascade,
  micro_market_id               text references micro_markets(id) on delete set null,
  name                          text not null,
  slug                          text not null unique,
  summary                       text,
  lat                           double precision not null,
  lng                           double precision not null,
  current_median_price_per_sqft numeric(12, 2),
  gross_rental_yield_percent    numeric(6, 3),
  active_supply_units           integer,
  annual_absorption_units       integer,
  nearest_metro_station         text,
  metro_distance_km             numeric(6, 2),
  metro_eta_months              integer,
  arterial_road_distance_km     numeric(6, 2),
  airport_distance_km           numeric(6, 2),
  schools_within_3km            integer,
  hospitals_within_5km          integer,
  malls_within_5km              integer,
  parks_within_2km              integer,
  pm25_annual                   numeric(6, 2),
  flood_risk                    numeric(4, 3) check (flood_risk between 0 and 1),
  water_stress                  numeric(4, 3) check (water_stress between 0 and 1),
  average_peak_traffic_index    numeric(5, 2),
  employment                    jsonb not null default '[]'::jsonb,
  rent_history                  jsonb not null default '[]'::jsonb,
  data_status                   data_status not null default 'estimated',
  updated_at                    timestamptz not null default now()
);

create index localities_city_idx on localities (city_id);
create index localities_status_idx on localities (data_status);

create table locality_price_points (
  id                     uuid primary key default gen_random_uuid(),
  locality_id            text not null references localities(id) on delete cascade,
  period                 text not null, -- YYYY-MM
  median_price_per_sqft  numeric(12, 2) not null,
  transaction_count      integer,
  unique (locality_id, period)
);

create index locality_price_points_locality_idx on locality_price_points (locality_id, period);

create table locality_pipeline (
  id                  uuid primary key default gen_random_uuid(),
  locality_id         text not null references localities(id) on delete cascade,
  name                text not null,
  type                text not null,
  status              pipeline_status not null,
  expected_completion timestamptz,
  source_reference    text
);

create index locality_pipeline_locality_idx on locality_pipeline (locality_id);

-- Supply side --------------------------------------------------------------

create table developers (
  id                        text primary key,
  name                      text not null,
  slug                      text not null unique,
  incorporated_year         integer,
  headquarters              text,
  projects_delivered        integer,
  units_delivered           integer,
  average_delay_months      numeric(6, 2),
  ongoing_litigation_count  integer,
  rera_complaints_count     integer,
  data_status               data_status not null default 'estimated',
  updated_at                timestamptz not null default now()
);

create table projects (
  id                 text primary key,
  name               text not null,
  slug               text not null unique,
  developer_id       text not null references developers(id) on delete restrict,
  locality_id        text not null references localities(id) on delete restrict,
  micro_market_id    text references micro_markets(id) on delete set null,
  city_id            text not null references cities(id) on delete restrict,
  lat                double precision not null,
  lng                double precision not null,
  kinds              text[] not null default '{}',
  total_units        integer,
  land_area_acres    numeric(8, 2),
  open_space_percent numeric(5, 2),
  launched_at        timestamptz,
  amenities          text[] not null default '{}',
  data_status        data_status not null default 'estimated',
  updated_at         timestamptz not null default now()
);

create index projects_locality_idx on projects (locality_id);
create index projects_developer_idx on projects (developer_id);

-- RERA registration is per phase, not per project. This is not a detail.
create table project_phases (
  id                  text primary key,
  project_id          text not null references projects(id) on delete cascade,
  name                text not null,
  rera_number         text,
  rera_state          text,
  rera_status         rera_status,
  rera_registered_at  timestamptz,
  rera_valid_until    timestamptz,
  rera_portal_url     text,
  promised_possession timestamptz,
  current_possession  timestamptz,
  construction_status construction_status not null,
  completion_percent  numeric(5, 2) check (completion_percent between 0 and 100),
  updated_at          timestamptz not null default now()
);

create index project_phases_project_idx on project_phases (project_id);

create table project_towers (
  id              text primary key,
  phase_id        text not null references project_phases(id) on delete cascade,
  name            text not null,
  floors          integer not null,
  units_per_floor integer
);

create table unit_types (
  id                      text primary key,
  project_id              text not null references projects(id) on delete cascade,
  label                   text not null,
  bedrooms                integer not null,
  carpet_area_sqft        numeric(10, 2) not null,
  built_up_area_sqft      numeric(10, 2),
  super_built_up_area_sqft numeric(10, 2),
  floor_plan              jsonb
);

-- Properties ---------------------------------------------------------------

create table properties (
  id                                text primary key,
  unit_type_id                      text references unit_types(id) on delete set null,
  project_id                        text not null references projects(id) on delete cascade,
  title                             text not null,
  kind                              property_kind not null default 'apartment',
  construction_status               construction_status not null,
  bedrooms                          integer not null,
  bathrooms                         integer not null,
  area_sqft                         numeric(10, 2) not null,
  area_basis                        area_basis not null default 'superBuiltUp',
  carpet_area_sqft                  numeric(10, 2),
  floor                             integer,
  total_floors                      integer,
  facing                            text check (facing in ('N','NE','E','SE','S','SW','W','NW')),
  asking_price                      numeric(14, 2) not null,
  pricing                           jsonb,
  maintenance_per_sqft_month        numeric(8, 2),
  expected_rent_per_month           numeric(12, 2),
  locality_id                       text not null references localities(id) on delete restrict,
  city_id                           text not null references cities(id) on delete restrict,
  lat                               double precision not null,
  lng                               double precision not null,
  listed_at                         timestamptz,
  images                            text[] not null default '{}',
  data_status                       data_status not null default 'estimated',
  commercial_developer_relationship boolean not null default false,
  commercial_paid_placement         boolean not null default false,
  commercial_commission_possible    boolean not null default false,
  commercial_note                   text,
  search_vector                     tsvector generated always as (
                                      to_tsvector('english', coalesce(title, ''))
                                    ) stored,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now()
);

-- Search-page filters, in the order the query planner will want them.
create index properties_search_idx on properties using gin (search_vector);
create index properties_city_price_idx on properties (city_id, asking_price);
create index properties_locality_idx on properties (locality_id);
create index properties_bedrooms_idx on properties (bedrooms);
create index properties_status_idx on properties (data_status);
create index properties_listed_idx on properties (listed_at desc nulls last);

-- Evidence -----------------------------------------------------------------

create table evidence (
  id                  uuid primary key default gen_random_uuid(),
  property_id         text references properties(id) on delete cascade,
  locality_id         text references localities(id) on delete cascade,
  project_id          text references projects(id) on delete cascade,
  field               text not null,
  value               jsonb,
  source_id           text not null,
  source_name         text not null,
  source_type         source_type not null,
  source_reference    text,
  source_trust        numeric(4, 3) not null check (source_trust between 0 and 1),
  observed_at         timestamptz not null,
  effective_at        timestamptz,
  last_verified_at    timestamptz,
  data_status         data_status not null,
  confidence          numeric(4, 3) not null check (confidence between 0 and 1),
  methodology_version text,
  review_state        review_state not null default 'unreviewed',
  disputed            boolean not null default false,
  note                text,
  created_at          timestamptz not null default now(),
  -- Evidence has to attach to exactly one subject, or provenance is ambiguous.
  constraint evidence_single_subject check (
    (property_id is not null)::int + (locality_id is not null)::int + (project_id is not null)::int = 1
  )
);

create index evidence_property_idx on evidence (property_id);
create index evidence_locality_idx on evidence (locality_id);
create index evidence_field_idx on evidence (field);

-- Comparables --------------------------------------------------------------

create table comparables (
  id                     uuid primary key default gen_random_uuid(),
  subject_property_id    text not null references properties(id) on delete cascade,
  comparable_property_id text references properties(id) on delete set null,
  label                  text not null,
  observed_at            timestamptz not null,
  is_transaction         boolean not null,
  carpet_area_sqft       numeric(10, 2) not null,
  price_per_sqft         numeric(12, 2) not null,
  distance_km            numeric(6, 2) not null,
  floor                  integer,
  age_years              numeric(5, 2),
  data_status            data_status not null default 'estimated',
  created_at             timestamptz not null default now()
);

create index comparables_subject_idx on comparables (subject_property_id, observed_at desc);

-- Stored analysis runs, so any historical result can be replayed ------------

create table valuations (
  id                       uuid primary key default gen_random_uuid(),
  property_id              text not null references properties(id) on delete cascade,
  computed_at              timestamptz not null default now(),
  methodology_version      text not null,
  low                      numeric(14, 2) not null,
  mid                      numeric(14, 2) not null,
  high                     numeric(14, 2) not null,
  per_sqft_mid             numeric(12, 2) not null,
  asking_price             numeric(14, 2) not null,
  asking_deviation_percent numeric(8, 3) not null,
  confidence               numeric(4, 3) not null,
  data_status              data_status not null,
  insufficient_evidence    boolean not null default false,
  payload                  jsonb not null
);

create index valuations_property_idx on valuations (property_id, computed_at desc);

create table scores (
  id               uuid primary key default gen_random_uuid(),
  property_id      text not null references properties(id) on delete cascade,
  scoring_version  text not null,
  persona          text not null,
  computed_at      timestamptz not null default now(),
  score            numeric(5, 2),
  confidence       numeric(4, 3) not null,
  coverage         numeric(4, 3) not null,
  decision         text,
  deciding_rule    text,
  uses_demo_data   boolean not null default false,
  payload          jsonb not null
);

create index scores_property_idx on scores (property_id, computed_at desc);

-- Backtesting: how a stored valuation compared to what actually transacted.
create table valuation_backtests (
  id                  uuid primary key default gen_random_uuid(),
  valuation_id        uuid not null references valuations(id) on delete cascade,
  actual_price        numeric(14, 2) not null,
  actual_observed_at  timestamptz not null,
  error_percent       numeric(8, 3) not null,
  within_band         boolean not null,
  created_at          timestamptz not null default now()
);

-- User-owned data ----------------------------------------------------------

create table buyer_profiles (
  user_id                     uuid primary key references auth.users(id) on delete cascade,
  persona                     text not null default 'homebuyer'
                              check (persona in ('homebuyer', 'investor', 'nri')),
  budget_min                  numeric(14, 2),
  budget_max                  numeric(14, 2),
  preferred_localities        text[] not null default '{}',
  bedrooms_min                integer,
  bedrooms_max                integer,
  workplace_label             text,
  max_peak_commute_minutes    integer,
  needs_ready_to_move         boolean,
  min_carpet_efficiency       numeric(4, 3),
  target_gross_yield_percent  numeric(6, 3),
  priorities                  jsonb,
  updated_at                  timestamptz not null default now()
);

create table watchlist (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  property_id text not null references properties(id) on delete cascade,
  note        text,
  created_at  timestamptz not null default now(),
  unique (user_id, property_id)
);

create index watchlist_user_idx on watchlist (user_id, created_at desc);

create table portfolio_assets (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  property_id       text references properties(id) on delete set null,
  label             text not null,
  purchase_price    numeric(14, 2) not null,
  purchase_date     date not null,
  cost_basis        numeric(14, 2) not null,
  outstanding_loan  numeric(14, 2) not null default 0,
  monthly_rent      numeric(12, 2) not null default 0,
  monthly_expenses  numeric(12, 2) not null default 0,
  current_estimate  numeric(14, 2),
  -- Says plainly whose number the current estimate is.
  valuation_source  text not null default 'userProvided'
                    check (valuation_source in ('userProvided', 'estimated', 'verified')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index portfolio_user_idx on portfolio_assets (user_id, created_at desc);

create table alerts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  property_id  text references properties(id) on delete cascade,
  locality_id  text references localities(id) on delete cascade,
  kind         text not null,
  threshold    jsonb,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create index alerts_user_idx on alerts (user_id);

create table analysis_documents (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  property_id    text references properties(id) on delete set null,
  storage_path   text not null,
  original_name  text not null,
  mime_type      text not null,
  size_bytes     bigint not null,
  status         text not null default 'uploaded'
                 check (status in ('uploaded', 'extracting', 'extracted', 'failed')),
  created_at     timestamptz not null default now()
);

create index analysis_documents_user_idx on analysis_documents (user_id, created_at desc);

create table document_findings (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references analysis_documents(id) on delete cascade,
  category      text not null,
  severity      text not null check (severity in ('info', 'attention', 'serious')),
  summary       text not null,
  extract       text,
  confidence    numeric(4, 3) not null check (confidence between 0 and 1),
  needs_human_review boolean not null default true,
  created_at    timestamptz not null default now()
);

create index document_findings_document_idx on document_findings (document_id);

-- Admin audit --------------------------------------------------------------

create table admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users(id) on delete set null,
  action      text not null,
  subject     text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- The rule enforced here: reference data is public, user data is private to
-- its owner, and nothing user-owned is writable by anyone else. Every policy
-- is scoped on auth.uid() rather than on a client-supplied id, so an
-- application bug cannot widen access.
--
-- Demo rows are excluded from the public read policies. That is a second,
-- independent guard alongside the application-level filter: even a query that
-- forgot `.neq('data_status','demo')` cannot serve fixture data to an
-- anonymous reader in a deployment whose database contains any.
-- ---------------------------------------------------------------------------

-- Reference data: readable by everyone, writable only by the service role
-- (which bypasses RLS and is never exposed to a client).

alter table cities                enable row level security;
alter table micro_markets         enable row level security;
alter table localities            enable row level security;
alter table locality_price_points enable row level security;
alter table locality_pipeline     enable row level security;
alter table developers            enable row level security;
alter table projects              enable row level security;
alter table project_phases        enable row level security;
alter table project_towers        enable row level security;
alter table unit_types            enable row level security;
alter table properties            enable row level security;
alter table evidence              enable row level security;
alter table comparables           enable row level security;
alter table valuations            enable row level security;
alter table scores                enable row level security;
alter table valuation_backtests   enable row level security;

create policy "cities are public" on cities for select using (true);
create policy "micro markets are public" on micro_markets for select using (true);

create policy "non-demo localities are public"
  on localities for select using (data_status <> 'demo');

create policy "locality price points follow their locality"
  on locality_price_points for select using (
    exists (
      select 1 from localities l
      where l.id = locality_price_points.locality_id and l.data_status <> 'demo'
    )
  );

create policy "locality pipeline follows its locality"
  on locality_pipeline for select using (
    exists (
      select 1 from localities l
      where l.id = locality_pipeline.locality_id and l.data_status <> 'demo'
    )
  );

create policy "non-demo developers are public"
  on developers for select using (data_status <> 'demo');

create policy "non-demo projects are public"
  on projects for select using (data_status <> 'demo');

create policy "phases follow their project"
  on project_phases for select using (
    exists (
      select 1 from projects p
      where p.id = project_phases.project_id and p.data_status <> 'demo'
    )
  );

create policy "towers follow their phase"
  on project_towers for select using (
    exists (
      select 1
      from project_phases ph
      join projects p on p.id = ph.project_id
      where ph.id = project_towers.phase_id and p.data_status <> 'demo'
    )
  );

create policy "unit types follow their project"
  on unit_types for select using (
    exists (
      select 1 from projects p
      where p.id = unit_types.project_id and p.data_status <> 'demo'
    )
  );

create policy "non-demo properties are public"
  on properties for select using (data_status <> 'demo');

create policy "non-demo evidence is public"
  on evidence for select using (data_status <> 'demo');

create policy "non-demo comparables are public"
  on comparables for select using (data_status <> 'demo');

create policy "valuations follow their property"
  on valuations for select using (
    exists (
      select 1 from properties p
      where p.id = valuations.property_id and p.data_status <> 'demo'
    )
  );

create policy "scores follow their property"
  on scores for select using (
    exists (
      select 1 from properties p
      where p.id = scores.property_id and p.data_status <> 'demo'
    )
  );

create policy "backtests follow their valuation"
  on valuation_backtests for select using (
    exists (select 1 from valuations v where v.id = valuation_backtests.valuation_id)
  );

-- ---------------------------------------------------------------------------
-- User-owned data. Owner-only, for every verb.
-- ---------------------------------------------------------------------------

alter table buyer_profiles     enable row level security;
alter table watchlist          enable row level security;
alter table portfolio_assets   enable row level security;
alter table alerts             enable row level security;
alter table analysis_documents enable row level security;
alter table document_findings  enable row level security;
alter table admin_audit_log    enable row level security;

create policy "own buyer profile: read"   on buyer_profiles for select using (auth.uid() = user_id);
create policy "own buyer profile: insert" on buyer_profiles for insert with check (auth.uid() = user_id);
create policy "own buyer profile: update" on buyer_profiles for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own buyer profile: delete" on buyer_profiles for delete using (auth.uid() = user_id);

create policy "own watchlist: read"   on watchlist for select using (auth.uid() = user_id);
create policy "own watchlist: insert" on watchlist for insert with check (auth.uid() = user_id);
create policy "own watchlist: update" on watchlist for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own watchlist: delete" on watchlist for delete using (auth.uid() = user_id);

create policy "own portfolio: read"   on portfolio_assets for select using (auth.uid() = user_id);
create policy "own portfolio: insert" on portfolio_assets for insert with check (auth.uid() = user_id);
create policy "own portfolio: update" on portfolio_assets for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own portfolio: delete" on portfolio_assets for delete using (auth.uid() = user_id);

create policy "own alerts: read"   on alerts for select using (auth.uid() = user_id);
create policy "own alerts: insert" on alerts for insert with check (auth.uid() = user_id);
create policy "own alerts: update" on alerts for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own alerts: delete" on alerts for delete using (auth.uid() = user_id);

create policy "own documents: read"   on analysis_documents for select using (auth.uid() = user_id);
create policy "own documents: insert" on analysis_documents for insert with check (auth.uid() = user_id);
create policy "own documents: update" on analysis_documents for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own documents: delete" on analysis_documents for delete using (auth.uid() = user_id);

-- Findings inherit their document's ownership. No direct client writes: only
-- the extraction pipeline (service role) produces them.
create policy "own document findings: read"
  on document_findings for select using (
    exists (
      select 1 from analysis_documents d
      where d.id = document_findings.document_id and d.user_id = auth.uid()
    )
  );

-- The audit log is deliberately readable by nobody through the anon/authed
-- roles. It is written and read by the service role only.
create policy "audit log is service-role only" on admin_audit_log for select using (false);

-- ---------------------------------------------------------------------------
-- Private document storage.
--
-- Uploads land in a private bucket under a per-user prefix, and the storage
-- policies enforce that prefix. Access is always through a short-lived signed
-- URL; the bucket is never public.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('property-documents', 'property-documents', false)
on conflict (id) do nothing;

create policy "own documents: storage read"
  on storage.objects for select
  using (
    bucket_id = 'property-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "own documents: storage insert"
  on storage.objects for insert
  with check (
    bucket_id = 'property-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "own documents: storage delete"
  on storage.objects for delete
  using (
    bucket_id = 'property-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 005_sync_heartbeats.sql — Lightweight table for sync connectivity tests.
--
-- Used by `gstack-sync test` to validate the full push/pull flow
-- without polluting real data tables.

create table if not exists sync_heartbeats (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  user_id uuid references auth.users(id),
  hostname text not null default '',
  timestamp timestamptz not null default now()
);

-- RLS
alter table sync_heartbeats enable row level security;

create policy "team_insert" on sync_heartbeats
  for insert with check (
    team_id in (select team_id from team_members where user_id = auth.uid())
  );

create policy "team_read" on sync_heartbeats
  for select using (
    team_id in (select team_id from team_members where user_id = auth.uid())
  );

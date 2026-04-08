-- 007_team_settings_and_functions.sql — Team settings, alert cooldowns, and RPC functions.
--
-- Adds:
-- 1. team_settings (key-value per team, admin-only)
-- 2. alert_cooldowns (dedup for regression alerts, edge-fn only)
-- 3. create_team() RPC (SECURITY DEFINER — atomic team + first member creation)

-- ─── team_settings ──────────────────────────────────────────

create table if not exists team_settings (
  team_id uuid references teams(id) on delete cascade,
  key text not null,
  value text not null,
  updated_at timestamptz default now(),
  primary key (team_id, key)
);

alter table team_settings enable row level security;

-- Admins can read settings
create policy "admin_read_settings" on team_settings
  for select using (
    team_id in (
      select team_id from team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

-- Admins can write settings
create policy "admin_write_settings" on team_settings
  for all using (
    team_id in (
      select team_id from team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

-- Add CHECK constraint on teams.slug if not already present
do $$ begin
  alter table teams add constraint chk_team_slug check (slug ~ '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$');
exception when duplicate_object then null;
end $$;

-- ─── alert_cooldowns ────────────────────────────────────────

create table if not exists alert_cooldowns (
  team_id uuid references teams(id) on delete cascade,
  repo_slug text not null,
  alert_type text not null,
  last_sent_at timestamptz not null default now(),
  primary key (team_id, repo_slug, alert_type)
);

-- No RLS — only accessed by edge functions via service_role key.
-- Edge functions bypass RLS anyway, but we explicitly leave it disabled
-- since no user should query this table directly.

-- ─── create_team() RPC ──────────────────────────────────────

-- SECURITY DEFINER: runs as the table owner, bypassing RLS.
-- This solves the chicken-and-egg problem: to INSERT the first
-- team_member, you'd need to already be a member (which the
-- admins_manage_members policy requires). This function does
-- both atomically.
--
-- Called via: POST /rest/v1/rpc/create_team
-- Body: { "team_slug": "my-team", "team_name": "My Team" }

create or replace function create_team(team_slug text, team_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_team_id uuid;
begin
  -- Validate inputs
  if team_slug is null or length(trim(team_slug)) = 0 then
    raise exception 'team_slug cannot be empty';
  end if;
  if team_name is null or length(trim(team_name)) = 0 then
    raise exception 'team_name cannot be empty';
  end if;
  if team_slug !~ '^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$' then
    raise exception 'team_slug must be 2-50 chars, lowercase alphanumeric and hyphens only, must start and end with alphanumeric';
  end if;
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;

  -- Create team
  insert into teams (slug, name)
  values (trim(team_slug), trim(team_name))
  returning id into new_team_id;

  -- Add caller as owner
  insert into team_members (team_id, user_id, role)
  values (new_team_id, auth.uid(), 'owner');

  return new_team_id;
end;
$$;

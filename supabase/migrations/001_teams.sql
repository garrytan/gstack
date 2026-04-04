-- 001_teams.sql — Core team infrastructure.
--
-- Creates teams and team_members tables with RLS policies.
-- Must be run first — other tables reference teams.

-- Teams
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz default now()
);

-- Team membership
create table if not exists team_members (
  team_id uuid references teams(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  primary key (team_id, user_id)
);

-- RLS for teams
alter table teams enable row level security;

create policy "team_members_read_team" on teams
  for select using (
    id in (select team_id from team_members where user_id = auth.uid())
  );

-- RLS for team_members
alter table team_members enable row level security;

create policy "members_read_own_team" on team_members
  for select using (
    team_id in (select team_id from team_members where user_id = auth.uid())
  );

create policy "admins_manage_members" on team_members
  for all using (
    team_id in (
      select team_id from team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

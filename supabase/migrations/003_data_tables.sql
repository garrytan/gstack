-- 003_data_tables.sql — Retro, QA, ship, greptile, and transcript tables.

-- Retro snapshots
create table if not exists retro_snapshots (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  repo_slug text not null,
  user_id uuid references auth.users(id),
  date date not null,
  window text not null default '7d',
  metrics jsonb not null default '{}'::jsonb,
  authors jsonb not null default '[]'::jsonb,
  version_range jsonb,
  streak_days int,
  tweetable text,
  greptile jsonb,
  backlog jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_retro_team on retro_snapshots(team_id);
create index if not exists idx_retro_date on retro_snapshots(team_id, date desc);
create unique index if not exists idx_retro_natural_key
  on retro_snapshots(team_id, repo_slug, date, user_id);

-- QA reports
create table if not exists qa_reports (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  repo_slug text not null,
  user_id uuid references auth.users(id),
  url text not null,
  mode text not null default 'full',
  health_score numeric(5,2),
  issues jsonb,
  category_scores jsonb,
  report_markdown text,
  created_at timestamptz default now()
);

create index if not exists idx_qa_team on qa_reports(team_id);
create index if not exists idx_qa_repo on qa_reports(team_id, repo_slug);

-- Ship logs
create table if not exists ship_logs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  repo_slug text not null,
  user_id uuid references auth.users(id),
  version text not null,
  branch text not null,
  pr_url text,
  review_findings jsonb,
  greptile_stats jsonb,
  todos_completed text[],
  test_results jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_ship_team on ship_logs(team_id);
create index if not exists idx_ship_repo on ship_logs(team_id, repo_slug);

-- Greptile triage
create table if not exists greptile_triage (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  user_id uuid references auth.users(id),
  date date not null default current_date,
  repo text not null,
  triage_type text not null check (triage_type in ('fp', 'fix', 'already-fixed')),
  file_pattern text not null,
  category text not null default '',
  created_at timestamptz default now()
);

create index if not exists idx_greptile_team on greptile_triage(team_id);

-- Session transcripts (opt-in)
create table if not exists session_transcripts (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  user_id uuid references auth.users(id),
  session_id text not null,
  repo_slug text not null,
  messages jsonb not null default '[]'::jsonb,
  total_turns int,
  tools_used jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_transcripts_team on session_transcripts(team_id);

-- RLS for all data tables (same pattern)
-- Each table: team members can read/insert, admins can delete.

-- retro_snapshots
alter table retro_snapshots enable row level security;
create policy "team_read" on retro_snapshots for select using (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "team_insert" on retro_snapshots for insert with check (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "admin_delete" on retro_snapshots for delete using (
  team_id in (select team_id from team_members where user_id = auth.uid() and role in ('owner', 'admin'))
);

-- qa_reports
alter table qa_reports enable row level security;
create policy "team_read" on qa_reports for select using (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "team_insert" on qa_reports for insert with check (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "admin_delete" on qa_reports for delete using (
  team_id in (select team_id from team_members where user_id = auth.uid() and role in ('owner', 'admin'))
);

-- ship_logs
alter table ship_logs enable row level security;
create policy "team_read" on ship_logs for select using (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "team_insert" on ship_logs for insert with check (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "admin_delete" on ship_logs for delete using (
  team_id in (select team_id from team_members where user_id = auth.uid() and role in ('owner', 'admin'))
);

-- greptile_triage
alter table greptile_triage enable row level security;
create policy "team_read" on greptile_triage for select using (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "team_insert" on greptile_triage for insert with check (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "admin_delete" on greptile_triage for delete using (
  team_id in (select team_id from team_members where user_id = auth.uid() and role in ('owner', 'admin'))
);

-- session_transcripts (tighter: admin-only read by default)
alter table session_transcripts enable row level security;
create policy "admin_read" on session_transcripts for select using (
  team_id in (select team_id from team_members where user_id = auth.uid() and role in ('owner', 'admin'))
);
create policy "team_insert" on session_transcripts for insert with check (
  team_id in (select team_id from team_members where user_id = auth.uid())
);
create policy "admin_delete" on session_transcripts for delete using (
  team_id in (select team_id from team_members where user_id = auth.uid() and role in ('owner', 'admin'))
);

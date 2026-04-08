-- 002_eval_runs.sql — Eval result storage.
--
-- Mirrors EvalResult from test/helpers/eval-store.ts.
-- Supports both gstack's native eval format and the universal
-- adapter format (any language pushes JSON results).

create table if not exists eval_runs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  user_id uuid references auth.users(id),
  repo_slug text not null,
  hostname text not null default '',

  -- Eval metadata
  schema_version int not null default 1,
  version text not null default '',
  branch text not null default '',
  git_sha text not null default '',
  timestamp timestamptz not null default now(),
  tier text not null default 'e2e',

  -- Summary stats
  total_tests int not null default 0,
  passed int not null default 0,
  failed int not null default 0,
  total_cost_usd numeric(10,4) not null default 0,
  total_duration_ms int not null default 0,

  -- Universal format fields (adapter mode)
  label text,                    -- e.g. "dev_fix-terseness_standard"
  prompt_sha text,               -- SHA of prompt source files
  by_category jsonb,             -- { "post_generation": { passed: 16, total: 17 } }
  costs jsonb,                   -- [{ model, calls, input_tokens, output_tokens }]

  -- Full test results (transcripts stripped for team sync)
  tests jsonb not null default '[]'::jsonb,

  created_at timestamptz default now()
);

-- Indexes for common queries
create index if not exists idx_eval_runs_team on eval_runs(team_id);
create index if not exists idx_eval_runs_repo on eval_runs(team_id, repo_slug);
create index if not exists idx_eval_runs_branch on eval_runs(team_id, branch);
create index if not exists idx_eval_runs_timestamp on eval_runs(team_id, timestamp desc);
create index if not exists idx_eval_runs_label on eval_runs(team_id, label) where label is not null;

-- Upsert natural key: timestamp + hostname + repo_slug (idempotent pushes)
create unique index if not exists idx_eval_runs_natural_key
  on eval_runs(team_id, timestamp, hostname, repo_slug);

-- RLS
alter table eval_runs enable row level security;

create policy "team_read" on eval_runs
  for select using (
    team_id in (select team_id from team_members where user_id = auth.uid())
  );

create policy "team_insert" on eval_runs
  for insert with check (
    team_id in (select team_id from team_members where user_id = auth.uid())
  );

create policy "admin_delete" on eval_runs
  for delete using (
    team_id in (
      select team_id from team_members
      where user_id = auth.uid() and role in ('owner', 'admin')
    )
  );

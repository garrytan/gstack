-- Per-model cost tracking for eval runs.
-- Stores cost breakdown by model so teams can analyze spend patterns.

create table eval_costs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references teams(id) not null,
  eval_run_id uuid references eval_runs(id) on delete cascade,
  model text not null,
  calls int not null,
  input_tokens int not null,
  output_tokens int not null,
  estimated_cost_usd numeric(10,6) not null,
  created_at timestamptz default now()
);

-- Index for querying costs by team and eval run
create index idx_eval_costs_team_run on eval_costs(team_id, eval_run_id);

-- RLS: team members can read/insert their team's costs
alter table eval_costs enable row level security;

create policy "Team members can read costs"
  on eval_costs for select
  using (team_id in (
    select team_id from team_members where user_id = auth.uid()
  ));

create policy "Team members can insert costs"
  on eval_costs for insert
  with check (team_id in (
    select team_id from team_members where user_id = auth.uid()
  ));

create policy "Admins can delete costs"
  on eval_costs for delete
  using (team_id in (
    select team_id from team_members
    where user_id = auth.uid() and role = 'admin'
  ));

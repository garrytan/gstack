# Team Sync Setup Guide

Team sync lets your team share eval results, retro snapshots, QA reports, ship logs, and Greptile triage data via a shared Supabase store. All sync is optional and non-fatal — without it, everything works locally as before.

## Prerequisites

- A [Supabase](https://supabase.com) project (free tier works)
- gstack v0.3.10+

## Step 1: Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your **Project URL** (e.g., `https://xxxx.supabase.co`)
3. Note your **anon/public key** from Settings > API

## Step 2: Run migrations

In the Supabase SQL Editor, run these files **in order**:

```
supabase/migrations/001_teams.sql
supabase/migrations/002_eval_runs.sql
supabase/migrations/003_data_tables.sql
supabase/migrations/004_eval_costs.sql
supabase/migrations/005_sync_heartbeats.sql
```

Copy-paste each file's contents into the SQL editor and run.

## Step 3: Create your team

In the SQL editor, create a team and add yourself:

```sql
-- Create team
INSERT INTO teams (name, slug) VALUES ('Your Team', 'your-team-slug');

-- After authenticating (Step 5), add yourself as owner:
-- INSERT INTO team_members (team_id, user_id, role)
-- VALUES ('<team-id>', '<your-user-id>', 'owner');
```

Note the team slug — you'll need it in the next step.

## Step 4: Configure your project

Copy the example config to your project root:

```bash
cp .gstack-sync.json.example .gstack-sync.json
```

Edit `.gstack-sync.json` with your Supabase details:

```json
{
  "supabase_url": "https://YOUR_PROJECT.supabase.co",
  "supabase_anon_key": "eyJ...",
  "team_slug": "your-team-slug"
}
```

**Important:** Add `.gstack-sync.json` to `.gitignore` if it contains sensitive keys, or commit it if your team uses the same Supabase project (the anon key is safe to commit — RLS protects the data).

## Step 5: Authenticate

```bash
gstack-sync setup
```

This opens your browser for Supabase OAuth. After authenticating, tokens are saved to `~/.gstack/auth.json` (mode 0600).

**For CI/automation:** Set the `GSTACK_SUPABASE_ACCESS_TOKEN` env var instead of running setup.

## Step 6: Verify

```bash
gstack-sync test
```

Expected output:
```
gstack sync test
────────────────────────────────────
  1. Config:        ok (team: your-team-slug)
  2. Auth:          ok (you@email.com)
  3. Push:          ok (123ms)
  4. Pull:          ok (1 heartbeats, 95ms)
────────────────────────────────────
  Sync test passed ✓
```

## Step 7: See your data

```bash
gstack-sync show              # team summary dashboard
gstack-sync show evals        # recent eval runs
gstack-sync show ships        # recent ship logs
gstack-sync show retros       # recent retro snapshots
gstack-sync status            # sync health check
bun run eval:trend --team     # team-wide test trends
```

## How it works

When sync is configured, skills automatically push data after completing their primary task:

- `/ship` pushes a ship log after PR creation (Step 8.5)
- `/retro` pushes the snapshot after saving to `.context/retros/` (Step 13)
- `/qa` pushes a report after computing the health score (Phase 6)
- `/review` pushes Greptile triage entries after history file writes
- Eval runs are pushed automatically by `EvalCollector.finalize()`

All pushes are non-fatal. If sync fails, entries are queued in `~/.gstack/sync-queue.json` and retried on the next push or via `gstack-sync drain`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "No .gstack-sync.json found" | Copy `.gstack-sync.json.example` and fill in your values |
| "Not authenticated" | Run `gstack-sync setup` |
| Push fails with 404 | Run the migration SQL files in order |
| "Connection failed" | Check your Supabase URL and that the project is running |
| Queue growing | Run `gstack-sync drain` to flush |

## Adding team members

Each team member needs to:

1. Have `.gstack-sync.json` in their project (commit it or share it)
2. Run `gstack-sync setup` to authenticate
3. Be added to `team_members` in Supabase (by an admin)

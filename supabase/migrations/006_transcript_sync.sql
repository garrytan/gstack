-- 006_transcript_sync.sql — Unique index for idempotent transcript upsert + RLS fix.

-- Unique index on (team_id, session_id) for upsert via Prefer: resolution=merge-duplicates.
-- session_id is a UUID from Claude Code — globally unique. No need for user_id in the key
-- (which is nullable and breaks PostgreSQL unique index dedup on NULL values).
create unique index if not exists idx_transcript_natural_key
  on session_transcripts(team_id, session_id);

-- Change transcript RLS from admin-only read to team-wide read.
-- Matches the pattern used by eval_runs, retro_snapshots, qa_reports, ship_logs, greptile_triage.
-- Opt-in transcript sync already requires user consent (sync_transcripts=true).
drop policy if exists "admin_read" on session_transcripts;
create policy "team_read" on session_transcripts for select using (
  team_id in (select team_id from team_members where user_id = auth.uid())
);

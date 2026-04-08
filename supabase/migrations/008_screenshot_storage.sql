-- 008_screenshot_storage.sql — Supabase Storage bucket for QA/design screenshots.
--
-- Creates a 'screenshots' bucket with RLS so team members can upload and
-- view screenshots scoped to their team.

-- ─── Storage bucket ───────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', true)
on conflict (id) do nothing;

-- ─── RLS policies ─────────────────────────────────────────────

-- Team members can upload screenshots under their team's folder.
-- Path convention: {team_id}/{slug}/{branch}/{filename}
create policy "team_upload_screenshots" on storage.objects
  for insert with check (
    bucket_id = 'screenshots'
    and (storage.foldername(name))[1] in (
      select id::text from teams
      where id in (
        select team_id from team_members
        where user_id = auth.uid()
      )
    )
  );

-- Team members can view their team's screenshots.
create policy "team_read_screenshots" on storage.objects
  for select using (
    bucket_id = 'screenshots'
    and (storage.foldername(name))[1] in (
      select id::text from teams
      where id in (
        select team_id from team_members
        where user_id = auth.uid()
      )
    )
  );

-- Public bucket: anyone with the URL can view (for PR body embedding).
-- The RLS above controls who can *upload*; public access is for reading
-- via the CDN URL without auth.

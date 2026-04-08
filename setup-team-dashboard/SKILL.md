# /setup-team-dashboard

Interactive setup for the gstack team dashboard, regression alerts, and weekly digest.

**Prerequisites:**
- Supabase project created (https://app.supabase.com)
- GitHub OAuth configured in Supabase Auth settings
- `gstack sync setup` completed (team sync working)

## Steps

### Step 1: Check Supabase CLI

```bash
which supabase || echo "NOT_INSTALLED"
```

If NOT_INSTALLED, tell the user:
```
Install the Supabase CLI:
  brew install supabase/tap/supabase
```
Wait for confirmation before continuing.

### Step 2: Link project

Ask the user for their Supabase project ref (found in project settings or URL).

```bash
cd <project-root>
supabase link --project-ref <ref>
```

If already linked, skip.

### Step 3: Run migrations

```bash
supabase db push
```

This creates the `team_settings`, `alert_cooldowns` tables and `create_team()` RPC function.

### Step 4: Deploy edge functions

Deploy all 3 edge functions:

```bash
supabase functions deploy dashboard --no-verify-jwt
supabase functions deploy regression-alert
supabase functions deploy weekly-digest
```

Note: `dashboard` uses `--no-verify-jwt` because it serves a public HTML page (auth happens client-side).

### Step 5: Set up database webhook for regression alerts

Tell the user to go to Supabase Dashboard > Database > Webhooks and create:
- **Name:** regression-alert
- **Table:** eval_runs
- **Events:** INSERT
- **Type:** Supabase Edge Function
- **Function:** regression-alert

### Step 6: Set up pg_cron for weekly digest

Tell the user to enable the `pg_cron` extension in Supabase Dashboard > Database > Extensions.

Then run in the SQL editor:
```sql
select cron.schedule(
  'weekly-digest',
  '0 9 * * 1',  -- Every Monday at 9am UTC
  $$
  select net.http_post(
    url := '<supabase-url>/functions/v1/weekly-digest',
    headers := '{"Authorization": "Bearer <service-role-key>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
```

Replace `<supabase-url>` and `<service-role-key>` with actual values.

**Security note:** The service-role-key is stored in the `cron.job` table and visible to anyone with SQL editor access to your Supabase project. This is the standard Supabase pattern for cron → edge function calls. If this concerns you, use Supabase Vault to store the key instead.

### Step 7: Configure Slack webhook

Ask the user for their Slack webhook URL (from https://api.slack.com/messaging/webhooks).

```bash
gstack team set slack-webhook <url>
gstack team set digest-enabled true
```

### Step 8: Verify

Open the dashboard URL:
```
https://<project-ref>.supabase.co/functions/v1/dashboard
```

Expected: login page with "Sign in with GitHub" button. After login, dashboard shows team data.

Test regression alert:
```bash
# Push a test eval with low pass rate to trigger alert
gstack eval push <test-file>
```

Check Slack channel for the regression alert.

## Troubleshooting

- **"Function not found"**: Re-run `supabase functions deploy <name>`
- **OAuth redirect fails**: Check that `<project>.supabase.co/functions/v1/dashboard` is in your Supabase Auth redirect URLs
- **No data on dashboard**: Run `gstack sync pull` to verify data exists, then check browser console for errors
- **Regression alert not firing**: Check Database > Webhooks in Supabase dashboard, verify the webhook is active
- **Weekly digest not sending**: Check Extensions > pg_cron is enabled, verify the cron schedule in SQL editor

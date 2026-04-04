/**
 * Regression alert edge function.
 *
 * Trigger: Database webhook on eval_runs INSERT.
 * Logic: Compare new run's pass rate against recent baseline.
 *        If >5% drop, POST to team's Slack webhook.
 *        Dedup via alert_cooldowns table (5-min window).
 *
 * Uses service_role key (bypasses RLS) — standard for webhooks.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface WebhookPayload {
  type: 'INSERT';
  table: string;
  record: {
    id: string;
    team_id: string;
    repo_slug: string;
    branch: string;
    passed: number;
    total_tests: number;
    timestamp: string;
  };
  schema: string;
}

// --- Pure functions (testable) ---

export function computePassRate(passed: number, total: number): number | null {
  return total > 0 ? (passed / total) * 100 : null;
}

export function shouldAlert(
  currentRate: number | null,
  baselineRate: number | null,
  thresholdPct: number = 5,
): boolean {
  if (currentRate === null || baselineRate === null) return false;
  return baselineRate - currentRate > thresholdPct;
}

export function formatSlackMessage(opts: {
  repoSlug: string;
  branch: string;
  previousRate: number;
  currentRate: number;
}): string {
  const delta = opts.currentRate - opts.previousRate;
  const arrow = delta < 0 ? 'regressed' : 'improved';
  return [
    `:warning: *Eval ${arrow}* on \`${opts.branch}\` (${opts.repoSlug})`,
    `Pass rate: ${opts.previousRate.toFixed(0)}% → ${opts.currentRate.toFixed(0)}% (${delta > 0 ? '+' : ''}${delta.toFixed(0)}%)`,
  ].join('\n');
}

// --- Main handler ---

Deno.serve(async (req: Request) => {
  try {
    const payload: WebhookPayload = await req.json();
    const { record } = payload;

    if (!record || !record.team_id || !record.total_tests) {
      return new Response('OK (skipped: missing fields)', { status: 200 });
    }

    const currentRate = computePassRate(record.passed, record.total_tests);
    if (currentRate === null) {
      return new Response('OK (skipped: total_tests=0)', { status: 200 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
      return new Response('OK (missing env vars)', { status: 200 });
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    // Check cooldown (5-min dedup)
    const { data: cooldown } = await supabase
      .from('alert_cooldowns')
      .select('last_sent_at')
      .eq('team_id', record.team_id)
      .eq('repo_slug', record.repo_slug)
      .eq('alert_type', 'regression')
      .single();

    if (cooldown?.last_sent_at) {
      const cooldownMs = Date.now() - new Date(cooldown.last_sent_at).getTime();
      if (cooldownMs < 5 * 60 * 1000) {
        return new Response('OK (cooldown active)', { status: 200 });
      }
    }

    // Get previous runs for baseline
    const { data: previousRuns } = await supabase
      .from('eval_runs')
      .select('passed, total_tests')
      .eq('team_id', record.team_id)
      .eq('repo_slug', record.repo_slug)
      .neq('id', record.id)
      .order('timestamp', { ascending: false })
      .limit(19);

    if (!previousRuns || previousRuns.length < 2) {
      return new Response('OK (not enough history)', { status: 200 });
    }

    // Compute baseline pass rate
    const rates = previousRuns
      .map(r => computePassRate(r.passed, r.total_tests))
      .filter((r): r is number => r !== null);

    if (rates.length === 0) {
      return new Response('OK (no valid baseline)', { status: 200 });
    }

    const baselineRate = rates.reduce((a, b) => a + b, 0) / rates.length;

    if (!shouldAlert(currentRate, baselineRate)) {
      return new Response('OK (no regression)', { status: 200 });
    }

    // Get Slack webhook URL
    const { data: setting } = await supabase
      .from('team_settings')
      .select('value')
      .eq('team_id', record.team_id)
      .eq('key', 'slack-webhook')
      .single();

    if (!setting?.value) {
      console.log(`Regression detected but no Slack webhook configured for team ${record.team_id}`);
      return new Response('OK (no webhook configured)', { status: 200 });
    }

    // Send Slack alert
    const message = formatSlackMessage({
      repoSlug: record.repo_slug,
      branch: record.branch,
      previousRate: baselineRate,
      currentRate,
    });

    const slackRes = await fetch(setting.value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });

    if (!slackRes.ok) {
      console.error(`Slack webhook failed: ${slackRes.status} ${await slackRes.text()}`);
    }

    // Update cooldown
    await supabase
      .from('alert_cooldowns')
      .upsert({
        team_id: record.team_id,
        repo_slug: record.repo_slug,
        alert_type: 'regression',
        last_sent_at: new Date().toISOString(),
      });

    console.log(`Regression alert sent: ${record.repo_slug} ${baselineRate.toFixed(0)}% → ${currentRate.toFixed(0)}%`);

    return new Response('OK (alert sent)', { status: 200 });
  } catch (err) {
    console.error(`Regression alert error: ${err}`);
    return new Response('OK (error logged)', { status: 200 });
  }
});

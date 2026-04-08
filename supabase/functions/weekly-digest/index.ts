/**
 * Weekly digest edge function.
 *
 * Trigger: pg_cron every Monday 9am UTC.
 * Logic: For each team with digest_enabled=true, aggregate 7-day data
 *        and POST a summary to their Slack webhook.
 *
 * Uses service_role key (bypasses RLS) — standard for cron functions.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// --- Pure functions (testable) ---

interface DigestData {
  teamSlug: string;
  evalRuns: number;
  evalPassRate: number | null;
  evalPassRateDelta: number | null;
  shipsByPerson: Array<{ email: string; count: number }>;
  totalShips: number;
  sessionCount: number;
  topTools: Array<{ tool: string; count: number }>;
  totalCost: number;
}

export function formatDigestMessage(data: DigestData): string {
  const lines: string[] = [];
  lines.push(`:bar_chart: *Weekly gstack Digest* — ${data.teamSlug}`);
  lines.push('');

  // Evals
  if (data.evalRuns > 0) {
    let evalLine = `:white_check_mark: *Evals:* ${data.evalRuns} runs`;
    if (data.evalPassRate !== null) {
      evalLine += `, ${data.evalPassRate.toFixed(0)}% pass rate`;
      if (data.evalPassRateDelta !== null) {
        const sign = data.evalPassRateDelta >= 0 ? '+' : '';
        evalLine += ` (${sign}${data.evalPassRateDelta.toFixed(0)}% from last week)`;
      }
    }
    lines.push(evalLine);
  }

  // Ships
  if (data.totalShips > 0) {
    const people = data.shipsByPerson
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(p => `${p.email.split('@')[0]}: ${p.count}`)
      .join(', ');
    lines.push(`:rocket: *Ships:* ${data.totalShips} PRs (${people})`);
  }

  // Sessions
  if (data.sessionCount > 0) {
    let sessionLine = `:robot_face: *AI Sessions:* ${data.sessionCount}`;
    if (data.topTools.length > 0) {
      const tools = data.topTools.slice(0, 5).map(t => `${t.tool}(${t.count})`).join(', ');
      sessionLine += ` — top tools: ${tools}`;
    }
    lines.push(sessionLine);
  }

  // Cost
  if (data.totalCost > 0) {
    lines.push(`:moneybag: *Eval spend:* $${data.totalCost.toFixed(2)}`);
  }

  // Quiet week fallback
  if (data.evalRuns === 0 && data.totalShips === 0 && data.sessionCount === 0) {
    lines.push('_Quiet week — no evals, ships, or sessions recorded._');
  }

  return lines.join('\n');
}

// --- Main handler ---

Deno.serve(async (_req: Request) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
      return new Response('OK (missing env vars)', { status: 200 });
    }
    const supabase = createClient(supabaseUrl, serviceKey);

    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();

    // Find all teams with digest enabled
    const { data: digestSettings } = await supabase
      .from('team_settings')
      .select('team_id, value')
      .eq('key', 'digest-enabled')
      .eq('value', 'true');

    if (!digestSettings || digestSettings.length === 0) {
      console.log('No teams have digest enabled');
      return new Response('OK (no teams)', { status: 200 });
    }

    let sentCount = 0;

    for (const setting of digestSettings) {
      const teamId = setting.team_id;

      // Get Slack webhook
      const { data: webhookSetting } = await supabase
        .from('team_settings')
        .select('value')
        .eq('team_id', teamId)
        .eq('key', 'slack-webhook')
        .single();

      if (!webhookSetting?.value) {
        console.log(`Team ${teamId}: digest enabled but no Slack webhook`);
        continue;
      }

      // Get team slug
      const { data: team } = await supabase
        .from('teams')
        .select('slug')
        .eq('id', teamId)
        .single();

      // Fetch this week's data
      const [evalRes, shipRes, sessionRes] = await Promise.all([
        supabase.from('eval_runs')
          .select('passed, total_tests, total_cost_usd, user_id')
          .eq('team_id', teamId)
          .gte('timestamp', weekAgo),
        supabase.from('ship_logs')
          .select('user_id, version, branch, pr_url')
          .eq('team_id', teamId)
          .gte('created_at', weekAgo),
        supabase.from('session_transcripts')
          .select('tools_used')
          .eq('team_id', teamId)
          .gte('started_at', weekAgo),
      ]);

      const evalRuns = evalRes.data || [];
      const shipLogs = shipRes.data || [];
      const sessions = sessionRes.data || [];

      // Compute pass rate
      let passRate: number | null = null;
      const validRuns = evalRuns.filter(r => r.total_tests > 0);
      if (validRuns.length > 0) {
        const totalPassed = validRuns.reduce((s, r) => s + r.passed, 0);
        const totalTests = validRuns.reduce((s, r) => s + r.total_tests, 0);
        passRate = totalTests > 0 ? (totalPassed / totalTests) * 100 : null;
      }

      // Compute previous week's pass rate for delta
      let passRateDelta: number | null = null;
      const { data: prevWeekRuns } = await supabase
        .from('eval_runs')
        .select('passed, total_tests')
        .eq('team_id', teamId)
        .gte('timestamp', twoWeeksAgo)
        .lt('timestamp', weekAgo);

      if (prevWeekRuns && prevWeekRuns.length > 0 && passRate !== null) {
        const prevValid = prevWeekRuns.filter(r => r.total_tests > 0);
        if (prevValid.length > 0) {
          const prevPassed = prevValid.reduce((s, r) => s + r.passed, 0);
          const prevTotal = prevValid.reduce((s, r) => s + r.total_tests, 0);
          const prevRate = prevTotal > 0 ? (prevPassed / prevTotal) * 100 : null;
          if (prevRate !== null) passRateDelta = passRate - prevRate;
        }
      }

      // Ships by person
      const shipsByPerson = new Map<string, number>();
      for (const log of shipLogs) {
        const key = String(log.user_id || 'unknown');
        shipsByPerson.set(key, (shipsByPerson.get(key) || 0) + 1);
      }

      // Top tools from sessions
      const toolCounts = new Map<string, number>();
      for (const s of sessions) {
        const tools = (s.tools_used as string[]) || [];
        for (const t of tools) {
          toolCounts.set(t, (toolCounts.get(t) || 0) + 1);
        }
      }

      const totalCost = evalRuns.reduce((s, r) => s + (Number(r.total_cost_usd) || 0), 0);

      const digest: DigestData = {
        teamSlug: team?.slug || 'unknown',
        evalRuns: evalRuns.length,
        evalPassRate: passRate,
        evalPassRateDelta: passRateDelta,
        shipsByPerson: [...shipsByPerson.entries()].map(([email, count]) => ({ email, count })),
        totalShips: shipLogs.length,
        sessionCount: sessions.length,
        topTools: [...toolCounts.entries()]
          .map(([tool, count]) => ({ tool, count }))
          .sort((a, b) => b.count - a.count),
        totalCost,
      };

      const message = formatDigestMessage(digest);

      // Send to Slack
      const slackRes = await fetch(webhookSetting.value, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });

      if (slackRes.ok) {
        sentCount++;
        console.log(`Digest sent for team ${team?.slug || teamId}`);
      } else {
        console.error(`Slack failed for team ${teamId}: ${slackRes.status}`);
      }
    }

    return new Response(`OK (${sentCount} digests sent)`, { status: 200 });
  } catch (err) {
    console.error(`Weekly digest error: ${err}`);
    return new Response('OK (error logged)', { status: 200 });
  }
});

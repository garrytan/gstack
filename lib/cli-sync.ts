/**
 * CLI handler for gstack-sync commands.
 * Called by bin/gstack-sync via `bun run`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTeamConfig, resolveSyncConfig, clearAuthTokens, isSyncConfigured, getSyncConfigPath } from './sync-config';
import { runDeviceAuth } from './auth';
import { pushEvalRun, pushRetro, pushQAReport, pushShipLog, pushGreptileTriage, pushHeartbeat, pullTable, pullTranscripts, drainQueue, getSyncStatus } from './sync';
import { readJSON, getGitRoot, atomicWriteJSON } from './util';
import { syncTranscripts } from './transcript-sync';
import { computeVelocity } from './dashboard-queries';

// --- Main (only when run directly, not imported) ---

async function main() {
  const command = process.argv[2];
  switch (command) {
    case 'setup':
      await cmdSetup();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'push-eval':
      await cmdPushFile('eval', process.argv[3]);
      break;
    case 'push-retro':
      await cmdPushFile('retro', process.argv[3]);
      break;
    case 'push-qa':
      await cmdPushFile('qa', process.argv[3]);
      break;
    case 'push-ship':
      await cmdPushFile('ship', process.argv[3]);
      break;
    case 'push-greptile':
      await cmdPushFile('greptile', process.argv[3]);
      break;
    case 'push-transcript':
      await cmdPushTranscript();
      break;
    case 'test':
      await cmdTest();
      break;
    case 'show':
      await cmdShow(process.argv.slice(3));
      break;
    case 'pull':
      await cmdPull();
      break;
    case 'drain':
      await cmdDrain();
      break;
    case 'logout':
      cmdLogout();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

async function cmdSetup(): Promise<void> {
  let team = getTeamConfig();

  // If no .gstack-sync.json, interactively create one
  if (!team) {
    const root = getGitRoot();
    if (!root) {
      console.error('Not in a git repository. Run this from your project root.');
      process.exit(1);
    }

    console.log('No .gstack-sync.json found. Setting up team sync.\n');

    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

    const supabaseUrl = (await ask('Supabase URL (e.g., https://xyz.supabase.co): ')).trim();
    if (!supabaseUrl) { rl.close(); console.error('URL is required.'); process.exit(1); }

    const supabaseAnonKey = (await ask('Supabase anon key (from Project Settings > API): ')).trim();
    if (!supabaseAnonKey) { rl.close(); console.error('Anon key is required.'); process.exit(1); }

    const teamSlug = (await ask('Team slug (short name, e.g., my-team): ')).trim();
    if (!teamSlug) { rl.close(); console.error('Team slug is required.'); process.exit(1); }

    rl.close();

    const configPath = path.join(root, '.gstack-sync.json');
    const config = { supabase_url: supabaseUrl, supabase_anon_key: supabaseAnonKey, team_slug: teamSlug };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`\nCreated ${configPath}`);
    console.log('Commit this file to your repo so team members get it automatically.\n');

    team = getTeamConfig();
    if (!team) {
      console.error('Failed to read created config. Check the file.');
      process.exit(1);
    }
  }

  console.log(`Team: ${team.team_slug}`);
  console.log(`Supabase: ${team.supabase_url}`);

  try {
    const tokens = await runDeviceAuth(team);
    console.log(`\nAuthenticated as ${tokens.email || tokens.user_id}`);
    console.log('Sync is now enabled. Run `gstack-sync status` to verify.');
  } catch (err: any) {
    console.error(`\nAuth failed: ${err.message}`);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  const status = await getSyncStatus();

  console.log('gstack sync status');
  console.log('─'.repeat(40));
  console.log(`  Configured:     ${status.configured ? 'yes' : 'no (.gstack-sync.json not found)'}`);
  console.log(`  Authenticated:  ${status.authenticated ? 'yes' : 'no (run gstack-sync setup)'}`);
  console.log(`  Sync enabled:   ${status.syncEnabled ? 'yes' : 'no'}`);
  console.log(`  Connection:     ${status.connectionOk ? 'ok' : 'failed'}`);
  console.log(`  Queue:          ${status.queueSize} items${status.queueOldest ? ` (oldest: ${status.queueOldest})` : ''}`);
  console.log(`  Cache:          ${status.cacheLastPull ? `last pull ${status.cacheLastPull}` : 'never pulled'}`);

  if (status.queueSize > 100) {
    console.log(`\n  WARNING: Queue has ${status.queueSize} items. Run 'gstack-sync drain' to flush.`);
  }
  if (status.queueOldest) {
    const ageMs = Date.now() - new Date(status.queueOldest).getTime();
    if (ageMs > 86_400_000) {
      console.log(`\n  WARNING: Oldest queue entry is ${Math.round(ageMs / 3_600_000)}h old. Run 'gstack-sync drain'.`);
    }
  }
}

async function cmdPushFile(type: string, filePath: string): Promise<void> {
  if (!filePath) {
    console.error(`Usage: gstack-sync push-${type} <file.json>`);
    process.exit(1);
  }

  if (!isSyncConfigured()) {
    // Silent exit — sync not configured is normal for solo users
    process.exit(0);
  }

  const data = readJSON<Record<string, unknown>>(filePath);
  if (!data) {
    console.error(`Cannot read ${filePath}`);
    process.exit(1);
  }

  let ok = false;
  switch (type) {
    case 'eval':
      ok = await pushEvalRun(data);
      break;
    case 'retro':
      ok = await pushRetro(data);
      break;
    case 'qa':
      ok = await pushQAReport(data);
      break;
    case 'ship':
      ok = await pushShipLog(data);
      break;
    case 'greptile':
      ok = await pushGreptileTriage(data);
      break;
  }

  if (ok) {
    console.log(`Synced ${type} to team store`);
  }
  // Silent on failure — queued for retry
}

async function cmdPull(): Promise<void> {
  if (!isSyncConfigured()) {
    console.error('Sync not configured. Run gstack-sync setup first.');
    process.exit(1);
  }

  const tables = ['eval_runs', 'retro_snapshots', 'qa_reports', 'ship_logs', 'greptile_triage', 'session_transcripts'];
  let total = 0;

  for (const table of tables) {
    const rows = await pullTable(table);
    total += rows.length;
    if (rows.length > 0) {
      console.log(`  ${table}: ${rows.length} rows`);
    }
  }

  console.log(`\nPulled ${total} total rows to local cache.`);
}

async function cmdPushTranscript(): Promise<void> {
  if (!isSyncConfigured()) {
    process.exit(0); // Silent — sync not configured is normal
  }

  const config = resolveSyncConfig();
  if (!config?.syncTranscripts) {
    console.log('Transcript sync is disabled. Enable with: gstack-config set sync_transcripts true');
    process.exit(0);
  }

  const result = await syncTranscripts();
  if (result.pushed > 0) {
    console.log(`Synced ${result.pushed} session${result.pushed > 1 ? 's' : ''} to team store`);
  }
  if (result.errors > 0) {
    console.log(`  (${result.errors} queued for retry)`);
  }
}

async function cmdDrain(): Promise<void> {
  const result = await drainQueue();
  console.log(`Queue drain: ${result.success} synced, ${result.failed} failed, ${result.remaining} remaining`);
}

function cmdLogout(): void {
  const team = getTeamConfig();
  if (!team) {
    console.log('No team config found — nothing to clear.');
    return;
  }

  clearAuthTokens(team.supabase_url);
  console.log(`Cleared auth tokens for ${team.supabase_url}`);
}

// --- sync test ---

async function cmdTest(): Promise<void> {
  console.log('gstack sync test');
  console.log('─'.repeat(40));

  // Step 1: Config
  const team = getTeamConfig();
  if (!team) {
    console.log('  1. Config:        FAIL — no .gstack-sync.json');
    console.log('\n  See docs/TEAM_SYNC_SETUP.md for setup instructions.');
    process.exit(1);
  }
  console.log(`  1. Config:        ok (team: ${team.team_slug})`);

  // Step 2: Auth
  const config = resolveSyncConfig();
  if (!config) {
    console.log('  2. Auth:          FAIL — not authenticated');
    console.log('\n  Run: gstack-sync setup');
    process.exit(1);
  }
  console.log(`  2. Auth:          ok (${config.auth.email || config.auth.user_id})`);

  // Step 3: Push heartbeat
  const t0 = Date.now();
  const pushOk = await pushHeartbeat();
  const pushMs = Date.now() - t0;
  if (!pushOk) {
    console.log(`  3. Push:          FAIL (${pushMs}ms)`);
    console.log('\n  Check that Supabase migrations have been run (especially 005_sync_heartbeats.sql).');
    console.log('  See docs/TEAM_SYNC_SETUP.md for details.');
    process.exit(1);
  }
  console.log(`  3. Push:          ok (${pushMs}ms)`);

  // Step 4: Pull
  const t1 = Date.now();
  const rows = await pullTable('sync_heartbeats');
  const pullMs = Date.now() - t1;
  if (rows.length === 0) {
    console.log(`  4. Pull:          FAIL — no rows returned (${pullMs}ms)`);
    process.exit(1);
  }
  console.log(`  4. Pull:          ok (${rows.length} heartbeats, ${pullMs}ms)`);

  console.log('─'.repeat(40));
  console.log('  Sync test passed ✓');
}

// --- sync show ---

/** Format a relative time string (e.g., "2 hours ago"). */
export function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** Format team summary dashboard from pulled data. Pure function for testing. */
export function formatTeamSummary(opts: {
  teamSlug: string;
  evalRuns: Record<string, unknown>[];
  shipLogs: Record<string, unknown>[];
  retroSnapshots: Record<string, unknown>[];
  queueSize: number;
  cacheLastPull: string | null;
}): string {
  const lines: string[] = [];
  const { teamSlug, evalRuns, shipLogs, retroSnapshots, queueSize, cacheLastPull } = opts;

  lines.push('');
  lines.push(`Team: ${teamSlug}`);
  lines.push('═'.repeat(50));

  // Eval runs (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const recentEvals = evalRuns.filter(r => (r.timestamp as string) > weekAgo);
  const evalContributors = new Set(recentEvals.map(r => r.user_id).filter(Boolean));
  lines.push(`  Eval runs (7d):   ${recentEvals.length} runs, ${evalContributors.size} contributors`);

  // Ship velocity (via dashboard-queries)
  const velocity = computeVelocity(shipLogs);
  lines.push(`  Ship velocity:    ${velocity.teamTotal.week} PRs this week`);

  // Detection rate (from recent evals)
  const detectionRates = recentEvals
    .flatMap(r => ((r.tests as any[]) || []).filter(t => t.detection_rate != null).map(t => t.detection_rate as number));
  if (detectionRates.length > 0) {
    const avg = detectionRates.reduce((a, b) => a + b, 0) / detectionRates.length;
    lines.push(`  Avg detection:    ${avg.toFixed(1)} bugs`);
  }

  // Latest retro
  if (retroSnapshots.length > 0) {
    const latest = retroSnapshots[0];
    const streak = (latest as any).streak_days;
    const date = (latest as any).date || (latest as any).timestamp;
    lines.push(`  Latest retro:     ${date ? String(date).slice(0, 10) : 'unknown'}${streak ? ` (streak: ${streak}d)` : ''}`);
  }

  // Queue + cache
  lines.push(`  Sync queue:       ${queueSize} items`);
  lines.push(`  Last pull:        ${cacheLastPull ? formatRelativeTime(cacheLastPull) : 'never'}`);

  lines.push('═'.repeat(50));
  lines.push('');
  return lines.join('\n');
}

/** Format eval runs table. Pure function for testing. */
export function formatEvalTable(evalRuns: Record<string, unknown>[]): string {
  if (evalRuns.length === 0) return 'No eval runs yet.\n';
  const lines: string[] = [];
  lines.push('');
  lines.push('Recent Eval Runs');
  lines.push('═'.repeat(80));
  lines.push(
    '  ' +
    'Date'.padEnd(13) +
    'User'.padEnd(20) +
    'Branch'.padEnd(22) +
    'Pass'.padEnd(8) +
    'Cost'.padEnd(8) +
    'Tier'
  );
  lines.push('─'.repeat(80));

  for (const r of evalRuns.slice(0, 20)) {
    const date = String(r.timestamp || '').slice(0, 10);
    const user = String(r.email || r.user_id || '').slice(0, 18).padEnd(20);
    const branch = String(r.branch || '').slice(0, 20).padEnd(22);
    const pass = `${r.passed || 0}/${r.total_tests || 0}`.padEnd(8);
    const cost = `$${Number(r.total_cost_usd || 0).toFixed(2)}`.padEnd(8);
    const tier = String(r.tier || 'e2e');
    lines.push(`  ${date.padEnd(13)}${user}${branch}${pass}${cost}${tier}`);
  }

  lines.push('─'.repeat(80));
  lines.push('');
  return lines.join('\n');
}

/** Format ship logs table. Pure function for testing. */
export function formatShipTable(shipLogs: Record<string, unknown>[]): string {
  if (shipLogs.length === 0) return 'No ship logs yet.\n';
  const lines: string[] = [];
  lines.push('');
  lines.push('Recent Ship Logs');
  lines.push('═'.repeat(70));
  lines.push(
    '  ' +
    'Date'.padEnd(13) +
    'Version'.padEnd(12) +
    'Branch'.padEnd(25) +
    'PR'
  );
  lines.push('─'.repeat(70));

  for (const r of shipLogs.slice(0, 20)) {
    const date = String(r.created_at || r.timestamp || '').slice(0, 10);
    const version = String(r.version || '').padEnd(12);
    const branch = String(r.branch || '').slice(0, 23).padEnd(25);
    const pr = String(r.pr_url || '');
    lines.push(`  ${date.padEnd(13)}${version}${branch}${pr}`);
  }

  lines.push('─'.repeat(70));
  lines.push('');
  return lines.join('\n');
}

/** Format a duration in milliseconds as a human-readable string. */
function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 60_000) return '<1m';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/** Format session transcripts table. Pure function for testing. */
export function formatSessionTable(sessions: Record<string, unknown>[]): string {
  if (sessions.length === 0) return 'No sessions yet.\n';
  const lines: string[] = [];
  lines.push('');
  lines.push('Recent Sessions');
  lines.push('═'.repeat(100));
  lines.push(
    '  ' +
    'Date'.padEnd(13) +
    'Repo'.padEnd(22) +
    'Summary'.padEnd(40) +
    'Turns'.padEnd(7) +
    'Dur'.padEnd(7) +
    'Tools'
  );
  lines.push('─'.repeat(100));

  for (const r of sessions.slice(0, 30)) {
    const date = String(r.started_at || r.created_at || '').slice(0, 10);
    const repo = String(r.repo_slug || '').slice(0, 20).padEnd(22);
    const summary = String(r.summary || '—').slice(0, 38).padEnd(40);
    const turns = String(r.total_turns || '').padEnd(7);
    const dur = (r.started_at && r.ended_at)
      ? formatDuration(String(r.started_at), String(r.ended_at)).padEnd(7)
      : '—'.padEnd(7);
    const tools = Array.isArray(r.tools_used)
      ? (r.tools_used as string[]).slice(0, 5).join(', ')
      : '—';
    lines.push(`  ${date.padEnd(13)}${repo}${summary}${turns}${dur}${tools}`);
  }

  lines.push('─'.repeat(100));
  lines.push('');
  return lines.join('\n');
}

async function cmdShow(args: string[]): Promise<void> {
  if (!isSyncConfigured()) {
    console.error('Sync not configured. Run gstack-sync setup first.');
    console.error('See docs/TEAM_SYNC_SETUP.md for setup instructions.');
    process.exit(1);
  }

  const sub = args[0];
  const team = getTeamConfig()!;

  if (sub === 'evals') {
    const rows = await pullTable('eval_runs');
    console.log(formatEvalTable(rows));
    return;
  }

  if (sub === 'ships') {
    const rows = await pullTable('ship_logs');
    console.log(formatShipTable(rows));
    return;
  }

  if (sub === 'retros') {
    const rows = await pullTable('retro_snapshots');
    if (rows.length === 0) { console.log('No retro snapshots yet.'); return; }
    for (const r of rows.slice(0, 10)) {
      const date = String((r as any).date || (r as any).timestamp || '').slice(0, 10);
      const streak = (r as any).streak_days;
      const commits = (r as any).metrics?.commits;
      console.log(`  ${date}  ${commits ? commits + ' commits' : ''}  ${streak ? 'streak: ' + streak + 'd' : ''}`);
    }
    return;
  }

  if (sub === 'sessions') {
    const rows = await pullTranscripts();
    console.log(formatSessionTable(rows));
    return;
  }

  // Default: summary dashboard
  const status = await getSyncStatus();
  const [evalRuns, shipLogs, retroSnapshots] = await Promise.all([
    pullTable('eval_runs'),
    pullTable('ship_logs'),
    pullTable('retro_snapshots'),
  ]);

  console.log(formatTeamSummary({
    teamSlug: team.team_slug,
    evalRuns,
    shipLogs,
    retroSnapshots,
    queueSize: status.queueSize,
    cacheLastPull: status.cacheLastPull,
  }));
}

if (import.meta.main) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

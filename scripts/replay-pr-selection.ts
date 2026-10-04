/**
 * CEO-23 preserved-detection replay for the PR paid lane (W1).
 *
 * Replays recorded PR runs' changed files through today's selector and
 * reports, per push, the recorded mode and case count against the new mode
 * and case count, the gate cases the new selector no longer runs, and every
 * MISS: a case that actually failed in that run, still exists, and depends
 * on the diff (today's touchfiles), yet is not selected now. Acceptance is
 * zero misses. The replay uses today's dependency graph (ENG-18): cases that
 * no longer exist are counted separately, never as misses.
 *
 * Inputs come from GitHub with `gh` (read-only): each run's `paid-plan`
 * manifest, its trial-outcomes artifact, and the three-dot compare of the
 * merge-base with the run's head SHA. Downloads are cached under --cache.
 *
 *   bun run scripts/replay-pr-selection.ts --runs <runs.json> [--cache <dir>] [--repo garrytan/gstack] [--json]
 *
 * <runs.json> is `gh run list --workflow evals.yml --json databaseId,headSha,event,createdAt,conclusion -L 200` output.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computePaidCaseSelection } from './test-paid-shards';
import { packageChangeOnlyVersion } from './test-pr-profile';
import { E2E_TIERS, E2E_TOUCHFILES, GLOBAL_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { matchGlob } from '../test/helpers/test-selection';

export interface ReplayInput {
  runId: number;
  oldMode: string;
  oldCases: number;
  changedFiles: string[];
  /** The compare API lists at most 300 files; a longer diff is replayed on that prefix and flagged. */
  truncated: boolean;
  failedCases: string[];
  packageVersionOnly: boolean;
}

export interface ReplayRow {
  runId: number;
  oldMode: string;
  newMode: string;
  oldCases: number;
  newCases: number;
  dropped: string[];
  misses: string[];
  retiredFailures: string[];
  truncated: boolean;
  error?: string;
}

/** Whether a case depends on any changed file under today's touchfiles (globals included). */
export function caseTouchesDiff(id: string, changedFiles: readonly string[]): boolean {
  const patterns = [...(E2E_TOUCHFILES[id] ?? []), ...GLOBAL_TOUCHFILES];
  return changedFiles.some(file => patterns.some(pattern => matchGlob(file, pattern)));
}

export function replayRun(input: ReplayInput, oldSelection: readonly string[]): ReplayRow {
  const base = { runId: input.runId, oldMode: input.oldMode, oldCases: input.oldCases, truncated: input.truncated };
  const retiredFailures = input.failedCases.filter(id => !Object.hasOwn(E2E_TIERS, id));
  try {
    const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: input.changedFiles, packageVersionOnly: input.packageVersionOnly });
    const selected = new Set(result.selection.e2e ?? Object.keys(E2E_TIERS).filter(id => E2E_TIERS[id] === 'gate'));
    const misses = input.failedCases.filter(id => Object.hasOwn(E2E_TIERS, id) && E2E_TIERS[id] === 'gate'
      && caseTouchesDiff(id, input.changedFiles) && !selected.has(id));
    return { ...base, newMode: result.coverage?.mode ?? 'full', newCases: selected.size,
      dropped: oldSelection.filter(id => Object.hasOwn(E2E_TIERS, id) && !selected.has(id)), misses, retiredFailures };
  } catch (error) {
    // The PR profile refuses prompts without coverage; CI fails the plan the same way, so nothing is silently dropped.
    return { ...base, newMode: 'needs-full-validation', newCases: 0, dropped: [], misses: [], retiredFailures,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

export function summarize(rows: readonly ReplayRow[]): string[] {
  const fallbackOld = rows.filter(row => row.oldMode === 'full-fallback').length;
  const fallbackNew = rows.filter(row => row.newMode === 'full-fallback').length;
  const misses = rows.flatMap(row => row.misses.map(id => `${row.runId}:${id}`));
  const pct = (n: number) => rows.length ? `${Math.round((100 * n) / rows.length)}%` : 'n/a';
  return [
    `PR selection replay over ${rows.length} recorded push(es) (today's dependency graph)`,
    `- full-fallback: ${fallbackOld} (${pct(fallbackOld)}) recorded -> ${fallbackNew} (${pct(fallbackNew)}) replayed`,
    `- needs full validation (plan refuses, as in CI): ${rows.filter(row => row.newMode === 'needs-full-validation').length}`,
    `- diffs truncated at the compare API's 300-file limit: ${rows.filter(row => row.truncated).length}`,
    `- failed cases that no longer exist: ${new Set(rows.flatMap(row => row.retiredFailures)).size}`,
    `- MISSES (failed, depends on the diff, not selected now): ${misses.length}${misses.length ? ` -> ${misses.join(', ')}` : ''}`,
  ];
}

function gh(args: string[]): string | null {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function loadInput(repo: string, run: { databaseId: number; headSha: string }, cache: string): { input: ReplayInput; oldSelection: string[] } | null {
  const dir = path.join(cache, String(run.databaseId));
  const plan = path.join(dir, 'plan', 'manifest.json');
  if (!fs.existsSync(plan)) gh(['run', 'download', String(run.databaseId), '-R', repo, '-n', 'paid-plan', '-D', path.join(dir, 'plan')]);
  if (!fs.existsSync(plan)) return null;
  const manifest = JSON.parse(fs.readFileSync(plan, 'utf8'));
  if (manifest.profile !== 'pr') return null;
  const outcomes = path.join(dir, 'outcomes');
  if (!fs.existsSync(outcomes)) {
    for (const name of ['trial-outcomes-pr-a1', 'trial-outcomes-pr']) {
      if (gh(['run', 'download', String(run.databaseId), '-R', repo, '-n', name, '-D', outcomes]) !== null) break;
    }
  }
  const failedCases = new Set<string>();
  if (fs.existsSync(outcomes)) {
    for (const file of fs.readdirSync(outcomes).filter(name => name.endsWith('.jsonl'))) {
      for (const line of fs.readFileSync(path.join(outcomes, file), 'utf8').split('\n').filter(Boolean)) {
        try { const record = JSON.parse(line); if (record.outcome === 'failed' && typeof record.case === 'string') failedCases.add(record.case); } catch { /* skip */ }
      }
    }
  }
  const compareFile = path.join(dir, 'compare.json');
  if (!fs.existsSync(compareFile)) {
    const compare = gh(['api', `repos/${repo}/compare/main...${run.headSha}`, '--jq', '{files: [.files[] | {filename, previous_filename}], merge_base: .merge_base_commit.sha}']);
    if (compare === null) return null;
    fs.writeFileSync(compareFile, compare);
  }
  const compare = JSON.parse(fs.readFileSync(compareFile, 'utf8')) as { files: Array<{ filename: string; previous_filename?: string }>; merge_base: string };
  const changedFiles = [...new Set(compare.files.flatMap(f => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]))];
  let packageVersionOnly = false;
  if (changedFiles.includes('package.json')) {
    const read = (ref: string) => gh(['api', `repos/${repo}/contents/package.json?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw']);
    const [before, after] = [read(compare.merge_base), read(run.headSha)];
    packageVersionOnly = before !== null && after !== null && packageChangeOnlyVersion(before, after);
  }
  return {
    input: { runId: run.databaseId, oldMode: manifest.prCoverage?.mode ?? 'pr', oldCases: (manifest.selection?.e2e ?? []).length,
      changedFiles, truncated: compare.files.length >= 300, failedCases: [...failedCases], packageVersionOnly },
    oldSelection: manifest.selection?.e2e ?? [],
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const runsFile = flag('runs');
  if (args.includes('--help') || !runsFile) {
    console.log('usage: bun run scripts/replay-pr-selection.ts --runs <runs.json> [--cache <dir>] [--repo garrytan/gstack] [--json]\n'
      + 'runs.json: gh run list --workflow evals.yml --json databaseId,headSha,event,createdAt,conclusion -L 200');
    process.exit(runsFile || args.includes('--help') ? 0 : 2);
  }
  const repo = flag('repo') ?? 'garrytan/gstack';
  const cache = flag('cache') ?? path.join(os.tmpdir(), 'gstack-pr-replay');
  const runs = (JSON.parse(fs.readFileSync(runsFile, 'utf8')) as Array<{ databaseId: number; headSha: string; event: string; conclusion: string }>)
    .filter(run => run.event === 'pull_request' && !['action_required', 'skipped'].includes(run.conclusion));
  const rows: ReplayRow[] = [];
  for (const run of runs) {
    const loaded = loadInput(repo, run, cache);
    if (loaded) rows.push(replayRun(loaded.input, loaded.oldSelection));
  }
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('| run | recorded mode | cases | replayed mode | cases | dropped gate cases | misses |');
    console.log('|---|---|---|---|---|---|---|');
    for (const row of rows) {
      console.log(`| ${row.runId}${row.truncated ? ' (diff >300 files)' : ''} | ${row.oldMode} | ${row.oldCases} | ${row.newMode} | ${row.newCases} | ${row.dropped.length} | ${row.misses.join(', ') || '0'} |`);
    }
    console.log('');
    for (const line of summarize(rows)) console.log(line);
  }
}

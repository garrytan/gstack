#!/usr/bin/env bun
/**
 * Stamp `series_identity` on a report's trial-outcomes JSONL (the pass-rates
 * history key: a hash of each case's own touchfiles, GLOBAL_TOUCHFILES
 * excluded; scripts/eval-flake-rank.ts caseSeriesIdentities). A separate step
 * after `test-paid-shards.ts --report`, so the paid runner's closure never
 * imports the history tool.
 *
 * EVAL_POLICY v2 identity (`caseSeriesIdentitiesV2`, CEO-27/ENG-3): only the
 * bytes a case owns (its paid test file, its fixtures, and the prompt files of
 * the skills it names: templates, sections and the generated SKILL.md the
 * model reads) plus HARNESS_VERSION. Shared helpers no longer reset every
 * case's history; the execution harness every case consumes is pinned by
 * scripts/harness-version.json and changes only by a deliberate bump
 * (scripts/bump-harness-version.ts). Every record also carries the full
 * consumed-input fingerprint (all touchfiles, globals included) as provenance.
 *
 * Usage:
 *   bun run scripts/eval-trial-series.ts <trial-outcomes.jsonl>
 *   bun run scripts/eval-trial-series.ts --backtest [--weeks 30] [--records <dir>]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { caseSeriesIdentities, LIVE_REGISTRY, readTrialOutcomeDir, type Registry } from './eval-flake-rank';
import { formatTrialOutcomes, parseTrialOutcomes } from '../test/helpers/eval-store';
import harnessManifest from './harness-version.json';

const ROOT = path.resolve(import.meta.dir, '..');

/** Deliberate shared-harness version: part of every v2 series identity. Bumped only by scripts/bump-harness-version.ts. */
export const HARNESS_VERSION: number = harnessManifest.version;
/** Harness patterns beyond GLOBAL_TOUCHFILES whose bytes HARNESS_VERSION pins. */
export const HARNESS_PATTERNS: readonly string[] = harnessManifest.patterns;

export interface TreeEntry { file: string; blob: string }

/** test-selection's matchGlob semantics, compiled once per pattern (the backtest matches thousands of files per revision). */
const globCache = new Map<string, RegExp>();
export function globRegex(pattern: string): RegExp {
  let regex = globCache.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*\*/g, '{{GLOBSTAR}}').replace(/\*/g, '[^/]*').replace(/\{\{GLOBSTAR\}\}/g, '.*')}$`);
    globCache.set(pattern, regex);
  }
  return regex;
}
const matches = (file: string, patterns: readonly string[]) => patterns.some(pattern => globRegex(pattern).test(file));

/** Tracked files with their blob ids, at the index (`ref` omitted) or at a commit. */
export function treeEntries(root: string, ref?: string): TreeEntry[] {
  const args = ref ? ['ls-tree', '-r', ref] : ['ls-files', '-s'];
  const listed = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${listed.stderr}`);
  return listed.stdout.split('\n').filter(Boolean).map(line => {
    const [meta, file] = line.split('\t');
    const parts = meta!.split(' ');
    return { file: file!, blob: (ref ? parts[2] : parts[1])! };
  });
}

/** Top-level directories that hold a skill template. */
export function skillDirs(entries: TreeEntry[]): Set<string> {
  return new Set(entries.filter(entry => /^[^/]+\/SKILL\.md\.tmpl$/.test(entry.file)).map(entry => entry.file.split('/')[0]!));
}

/**
 * A file a case owns: a paid test file (not a unit test under test/helpers),
 * a fixture, or a skill prompt file (markdown, template or JSON manifest in a
 * skill directory, generated SKILL.md included: it is what the model reads).
 */
export function isCaseOwnedFile(file: string, skills: Set<string>): boolean {
  if (file.endsWith('.test.ts')) return !file.startsWith('test/helpers/');
  if (/(^|\/)fixtures\//.test(file)) return true;
  if (file === 'SKILL.md' || file === 'SKILL.md.tmpl') return true;
  return skills.has(file.split('/')[0]!) && /\.(md|tmpl|json)$/.test(file);
}

/** Files HARNESS_VERSION pins: GLOBAL_TOUCHFILES plus HARNESS_PATTERNS, unit tests excluded. */
export function harnessFiles(entries: TreeEntry[], registry: Registry = LIVE_REGISTRY, patterns: readonly string[] = HARNESS_PATTERNS): TreeEntry[] {
  const all = [...registry.globals, ...patterns];
  return entries.filter(entry => !entry.file.endsWith('.test.ts') && matches(entry.file, all));
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const lines = (entries: TreeEntry[]) => entries.map(entry => `${entry.file} ${entry.blob}`).sort().join('\n');

/** v2 series identity and full provenance fingerprint per case. */
export function caseSeriesIdentitiesV2(ids: string[], entries: TreeEntry[], registry: Registry = LIVE_REGISTRY,
  harnessVersion = HARNESS_VERSION): Record<string, { identity: string; fingerprint: string }> {
  const skills = skillDirs(entries);
  return Object.fromEntries(ids.map(id => {
    const patterns = registry.touchfiles[id] ?? registry.judgeTouchfiles[id] ?? [];
    const consumed = entries.filter(entry => matches(entry.file, patterns));
    const owned = consumed.filter(entry => isCaseOwnedFile(entry.file, skills));
    const full = entries.filter(entry => matches(entry.file, [...patterns, ...registry.globals]));
    return [id, { identity: digest(`${id}\nharness ${harnessVersion}\n${lines(owned)}`), fingerprint: digest(`${id}\n${lines(full)}`) }];
  }));
}

/** Rewrite the file with every record stamped; an invalid line fails the whole stamp. */
export function stampTrialSeries(file: string, root = ROOT): number {
  const { records, errors } = parseTrialOutcomes(fs.readFileSync(file, 'utf8'));
  if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
  const identities = caseSeriesIdentities([...new Set(records.map(record => record.case))], root);
  const stamped = records.map(record => ({ ...record, series_identity: identities[record.case] }));
  fs.writeFileSync(file, formatTrialOutcomes(stamped));
  return stamped.length;
}

// --- Backtest (ENG-3/DX-12): would the identity let cases reach the quarantine minimum? ---

export interface BacktestRow { variant: string; latestQualifying: number; present: number; meanShareLast8: number; medianChanges: number }

/**
 * Over weekly main revisions (Monday 06:00 UTC, the census cron), how many
 * blocking cases would hold one identity long enough to reach `minTrials`
 * within the last `window` weekly runs (rule and judge cases record one
 * trial per run, behavior cases a panel of 3). `v1` is today's identity
 * (own touchfiles minus GLOBAL_TOUCHFILES); `v2` is caseSeriesIdentitiesV2;
 * `v2+harness` also resets every series whenever the pinned harness bytes
 * change (the cost of bumping HARNESS_VERSION on every harness edit).
 */
export function weeklyBacktest(opts: { root: string; weeks: number; now: number; registry?: Registry; minTrials?: number; window?: number }):
  { revisions: string[]; harnessChanges: number; rows: BacktestRow[] } {
  const registry = opts.registry ?? LIVE_REGISTRY;
  const minTrials = opts.minTrials ?? 10, window = opts.window ?? 10;
  const ids = Object.keys(registry.tiers).filter(id => registry.tiers[id] === 'gate' || registry.tiers[id] === 'periodic');
  const monday = new Date(opts.now);
  monday.setUTCHours(6, 0, 0, 0);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const revisions: string[] = [];
  for (let week = opts.weeks - 1; week >= 0; week--) {
    const at = new Date(monday.getTime() - week * 7 * 86_400_000).toISOString();
    const sha = spawnSync('git', ['rev-list', '-1', '--first-parent', `--before=${at}`, 'HEAD'], { cwd: opts.root, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    if (sha) revisions.push(sha);
  }
  const series: Record<string, Record<string, string[]>> = { v1: {}, v2: {} };
  const harness: string[] = [];
  for (const sha of revisions) {
    const entries = treeEntries(opts.root, sha);
    const present = new Set(ids.filter(id => entries.some(entry => entry.file.endsWith('.test.ts')
      && matches(entry.file, registry.touchfiles[id] ?? []))));
    const v2 = caseSeriesIdentitiesV2(ids, entries, registry, 0);
    const nonGlobal = entries.filter(entry => !matches(entry.file, registry.globals));
    for (const id of ids) {
      const own = nonGlobal.filter(entry => matches(entry.file, registry.touchfiles[id] ?? []));
      (series.v1![id] ??= []).push(present.has(id) ? digest(`${id}\n${lines(own)}`) : '');
      (series.v2![id] ??= []).push(present.has(id) ? v2[id]!.identity : '');
    }
    harness.push(digest(lines(harnessFiles(entries, registry))));
  }
  const perRun = (id: string) => (registry.kinds[id] === 'behavior' ? 3 : 1);
  const row = (variant: string, values: Record<string, string[]>, resetOnHarness: boolean): BacktestRow => {
    const shares: number[] = [];
    let latestQualifying = 0, present = 0;
    for (let week = 0; week < revisions.length; week++) {
      let qualifying = 0, live = 0;
      for (const id of ids) {
        const list = values[id]!;
        if (!list[week]) continue;
        live++;
        let runs = 1;
        while (runs < window && week - runs >= 0 && list[week - runs] === list[week] && (!resetOnHarness || harness[week - runs] === harness[week])) runs++;
        if (runs * perRun(id) >= minTrials) qualifying++;
      }
      shares.push(live ? qualifying / live : 0);
      if (week === revisions.length - 1) { latestQualifying = qualifying; present = live; }
    }
    const changes = ids.map(id => values[id]!.filter(Boolean)).map(list => list.slice(1).filter((value, index) => value !== list[index]).length).sort((a, b) => a - b);
    const last8 = shares.slice(-8);
    return { variant, latestQualifying, present, meanShareLast8: last8.reduce((a, b) => a + b, 0) / Math.max(1, last8.length), medianChanges: changes[Math.floor(changes.length / 2)] ?? 0 };
  };
  return { revisions, harnessChanges: harness.slice(1).filter((value, index) => value !== harness[index]).length,
    rows: [row('v1', series.v1!, false), row('v2', series.v2!, false), row('v2+harness', series.v2!, true)] };
}

/**
 * Recorded-trial backtest: cases reaching `minTrials` on one series when the
 * recorded trials (any lane) are re-keyed by the v2 identity of the revision
 * that produced them, vs the series_identity they were stamped with.
 */
export function recordBacktest(opts: { root: string; dir: string; registry?: Registry; minTrials?: number }):
  { trials: number; revisions: number; missing: string[]; recorded: number; v2: number; blocking: number } {
  const registry = opts.registry ?? LIVE_REGISTRY;
  const minTrials = opts.minTrials ?? 10;
  const seen = new Set<string>();
  const records = readTrialOutcomeDir(opts.dir).records.filter(record => {
    const key = `${record.run_id}|${record.attempt}|${record.case}|${record.trial}`;
    if (record.outcome === 'skipped' || seen.has(key) || !record.sha) return false;
    seen.add(key);
    return true;
  });
  const cases = [...new Set(records.map(record => record.case))];
  const identity = new Map<string, Record<string, { identity: string }>>();
  const missing: string[] = [];
  for (const sha of new Set(records.map(record => record.sha!))) {
    try { identity.set(sha, caseSeriesIdentitiesV2(cases, treeEntries(opts.root, sha), registry, 0)); } catch { missing.push(sha); }
  }
  const qualifying = (key: (record: (typeof records)[number]) => string | undefined) => {
    const counts = new Map<string, number>();
    for (const record of records) {
      const series = key(record);
      if (series) counts.set(`${record.case}|${series}|${record.model}|${record.cli_version}`, (counts.get(`${record.case}|${series}|${record.model}|${record.cli_version}`) ?? 0) + 1);
    }
    const best = new Map<string, number>();
    for (const [series, count] of counts) best.set(series.split('|')[0]!, Math.max(best.get(series.split('|')[0]!) ?? 0, count));
    return [...best].filter(([id, count]) => (registry.tiers[id] === 'gate' || registry.tiers[id] === 'periodic') && count >= minTrials).length;
  };
  return { trials: records.length, revisions: identity.size, missing,
    recorded: qualifying(record => record.series_identity), v2: qualifying(record => identity.get(record.sha!)?.[record.case]?.identity),
    blocking: cases.filter(id => registry.tiers[id] === 'gate' || registry.tiers[id] === 'periodic').length };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--backtest') {
    const flag = (name: string) => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
    const weekly = weeklyBacktest({ root: ROOT, weeks: Number(flag('--weeks') ?? 30), now: Date.now() });
    console.log(`weekly main revisions: ${weekly.revisions.length}; pinned-harness changes between consecutive weeks: ${weekly.harnessChanges}`);
    console.log('variant      qualifying now   mean share (last 8 weeks)   median identity changes/case');
    for (const row of weekly.rows) {
      console.log(`${row.variant.padEnd(11)}  ${`${row.latestQualifying}/${row.present}`.padEnd(15)}  ${`${(row.meanShareLast8 * 100).toFixed(1)}%`.padEnd(26)}  ${row.medianChanges}`);
    }
    const dir = flag('--records');
    if (dir) {
      const recorded = recordBacktest({ root: ROOT, dir });
      console.log(`recorded trials: ${recorded.trials} over ${recorded.revisions} revision(s)${recorded.missing.length ? ` (${recorded.missing.length} revision(s) not in this clone: fetch them)` : ''}`);
      console.log(`blocking cases with >= 10 trials on one series: recorded identity ${recorded.recorded}/${recorded.blocking}, v2 identity ${recorded.v2}/${recorded.blocking}`);
    }
    process.exit(0);
  }
  const file = argv[0];
  if (!file) {
    console.error('usage: bun run scripts/eval-trial-series.ts <trial-outcomes.jsonl> | --backtest [--weeks N] [--records <dir>]');
    process.exit(2);
  }
  console.log(`[eval-trial-series] stamped ${stampTrialSeries(file)} record(s) in ${file}`);
}

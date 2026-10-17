#!/usr/bin/env bun
/**
 * test:exercised-map — maintain test/helpers/exercised-commands.json, the
 * observed half of the exercised-path consumer map (scripts/pr-dependencies.ts
 * exercisedConsumers; shadow mode, docs/TESTING_INTERNALS.md#exercised-path-map).
 *
 * Refreshes are union-only: an observation adds commands, never removes one.
 * A refresh whose input is unavailable or partial writes nothing, keeps the
 * committed union and exits non-zero with a stable code naming what was
 * missing: 2 usage, 3 input unavailable (missing directory, failed or HTTP 403
 * download), 4 input incomplete (no shards, no trial outcomes, an executed case
 * without a shard artifact, a missing or malformed exercised-commands.json).
 * Removing a command is a reviewed edit of the JSON file.
 *
 * Usage:
 *   bun run test:exercised-map --from-run <id> [--out <file>]
 *       download that census run's exercised-map artifact and union it into the committed map
 *   bun run test:exercised-map --from-dir <downloaded exercised-map artifact dir> [--out <file>]
 *       the same from a locally downloaded artifact (the fallback when the download hits HTTP 403)
 *   bun run test:exercised-map --from-dir <dir> [--from-dir <dir>...] --run-id <id> [--out <file>] [--report <file>]
 *       read paid-slice / gate-census report directories (shards/<shard>/...: transcripts, junit.xml,
 *       PTY terminal.visible.log, trial-outcomes.jsonl) and union their commands into the map
 *   bun run test:exercised-map --check
 *       validate the committed map
 *   bun run test:exercised-map --replay [<fixture>]
 *       replay recorded red PR runs (default test/fixtures/exercised-map-replay.json) through
 *       today's selector and its shadow; a MISS is a failed gate case the shadow would not run
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkoutExercisedConsumers, EXERCISED_MAP_PATH, parseExercisedMap, type ExercisedCase, type ExercisedConsumers, type ExercisedMap,
} from './pr-dependencies';
import { caseOwnerFile, EXERCISED_MAP_ANCHOR, PR_FULL_GATE_FILES, PR_PROFILE_MAPS } from './test-pr-profile';
import { CASE_TEST_NAMES } from './lib/paid-cases';
import { computePaidCaseSelection } from './test-paid-shards';

const ROOT = path.resolve(import.meta.dir, '..');
export const EXERCISED_MAP_ARTIFACT = 'exercised-map';

/** Commands one shard directory recorded: per Bun test name, and shard-level (no test name). */
export interface ShardCommands { shard: string; executed: string[]; perTest: Record<string, string[]>; shardLevel: string[] }

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

function toolCommands(node: unknown, out: string[]): void {
  if (Array.isArray(node)) { for (const item of node) toolCommands(item, out); return; }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, any>;
  if (record.type === 'tool_use' && typeof record.input?.command === 'string') out.push(record.input.command);
  for (const value of Object.values(record)) if (value && typeof value === 'object') toolCommands(value, out);
}

/** Every `shards/<shard>/` directory under `dir`, with the Bash commands its transcripts, JSONL logs and PTY screens recorded. */
export function readShardCommands(dir: string): ShardCommands[] {
  if (!fs.existsSync(dir)) return [];
  const shardDirs = walk(dir).map(file => path.relative(dir, file).split(path.sep)).flatMap(parts => {
    const at = parts.lastIndexOf('shards');
    return at >= 0 && parts.length > at + 2 ? [path.join(dir, ...parts.slice(0, at + 2))] : [];
  });
  return [...new Set(shardDirs)].sort().map(shardDir => {
    const record: ShardCommands = { shard: path.basename(shardDir), executed: [], perTest: {}, shardLevel: [] };
    for (const file of walk(shardDir)) {
      const base = path.basename(file);
      try {
        if (base === 'junit.xml') {
          for (const match of fs.readFileSync(file, 'utf8').matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
            const name = /\bname="([^"]*)"/.exec(match[1]!)?.[1];
            if (name && !/<skipped/.test(match[3] ?? '')) record.executed.push(name.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
          }
        } else if (base.endsWith('.json')) {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Array.isArray(parsed?.tests) && parsed.tests.some((test: any) => test?.transcript)) {
            for (const test of parsed.tests) { const out: string[] = []; toolCommands(test.transcript ?? [], out); if (out.length) (record.perTest[test.name] ??= []).push(...out); }
          } else toolCommands(parsed, record.shardLevel);
        } else if (base.endsWith('.jsonl')) {
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.includes('tool_use')) { try { toolCommands(JSON.parse(line), record.shardLevel); } catch { /* partial line */ } }
        } else if (base === 'terminal.visible.log') {
          for (const match of fs.readFileSync(file, 'utf8').matchAll(/Bash\(([^\r\n]{0,400})/g)) record.shardLevel.push(`PTY:${match[1]}`);
        }
      } catch { /* unreadable evidence file: its commands are simply not observed */ }
    }
    record.shardLevel = [...new Set(record.shardLevel)];
    for (const name of Object.keys(record.perTest)) record.perTest[name] = [...new Set(record.perTest[name])];
    return record;
  });
}

const testNameCase = (name: string, ids: string[]): string | null =>
  ids.includes(name) ? name : Object.keys(CASE_TEST_NAMES).find(id => CASE_TEST_NAMES[id] === name && ids.includes(id)) ?? ids.find(id => name.includes(id)) ?? null;

/**
 * Raw commands per case. A case shard (`<stem>--<id>`) is that case; a file
 * shard's per-test commands go to the case its test name names, and its
 * file-level commands to every case of the file that ran (by JUnit name, else
 * all of them): conservative over-attribution, as in the measured prototype.
 */
export function attributeCommands(shards: ShardCommands[], maps = PR_PROFILE_MAPS): Map<string, string[]> {
  const ids = Object.keys(maps.e2eTouchfiles);
  const byFile = new Map<string, string[]>();
  for (const id of ids) { const owner = caseOwnerFile(id, maps); if (owner) byFile.set(owner, [...byFile.get(owner) ?? [], id]); }
  const out = new Map<string, string[]>();
  const add = (id: string, commands: string[]) => out.set(id, [...out.get(id) ?? [], ...commands]);
  for (const shard of shards) {
    const [stem, caseKey] = shard.shard.split('--');
    const caseId = caseKey?.replace(/\.t\d+$/, '');
    const owned = byFile.get(`test/${stem}.test.ts`) ?? [];
    const ran = owned.filter(id => shard.executed.some(name => testNameCase(name, [id]) === id));
    const targets = caseId && ids.includes(caseId) ? [caseId] : ran.length ? ran : owned;
    for (const id of targets) add(id, shard.shardLevel);
    for (const [name, commands] of Object.entries(shard.perTest)) {
      const id = testNameCase(name, targets) ?? testNameCase(name, ids);
      for (const target of id ? [id] : targets) add(target, commands);
    }
  }
  return out;
}

/** Known trial cost per case summed over the trial-outcomes.jsonl files under `dir` (executed trials only). */
export function readCaseCosts(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(dir)) return out;
  for (const file of walk(dir).filter(file => path.basename(file) === 'trial-outcomes.jsonl')) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        if (record.execution === 'executed' && record.cost_known !== false && typeof record.case === 'string') out.set(record.case, (out.get(record.case) ?? 0) + (Number(record.cost_usd) || 0));
      } catch { /* malformed line */ }
    }
  }
  return out;
}

/** One run's observations as a map: the bins each attributed case invoked, and its known cost. */
export function observeRun(commandsByCase: Map<string, string[]>, ex: Pick<ExercisedConsumers, 'binsInCommand'>, run: { runId: string; observedAt: string; costs?: Map<string, number> }): ExercisedMap {
  const cases: Record<string, ExercisedCase> = {};
  for (const [id, commands] of commandsByCase) {
    cases[id] = { observations: 1, withCommands: commands.length ? 1 : 0, commands: [...new Set(commands.flatMap(command => ex.binsInCommand(command)))].sort() };
  }
  for (const [id, cost] of run.costs ?? []) {
    cases[id] ??= { observations: 1, withCommands: 0, commands: [] };
    Object.assign(cases[id], { costUsd: Math.round(cost * 10000) / 10000, costRuns: 1 });
  }
  return { schema: 1, generatedAt: run.observedAt, observedThrough: run.observedAt, sourceRuns: [run.runId], cases };
}

/**
 * Union-only merge: commands are unioned, counts add for runs the base has
 * not seen, costs average by run count, and nothing the base holds is ever
 * removed (an absent or empty case in `fresh` changes nothing).
 */
export function mergeExercisedMap(base: ExercisedMap, fresh: ExercisedMap, generatedAt = new Date().toISOString()): ExercisedMap {
  const counts = fresh.sourceRuns.some(run => !base.sourceRuns.includes(run));
  const cases: Record<string, ExercisedCase> = structuredClone(base.cases);
  for (const [id, entry] of Object.entries(fresh.cases)) {
    const old = cases[id];
    const merged: ExercisedCase = {
      observations: (old?.observations ?? 0) + (counts ? entry.observations : 0),
      withCommands: (old?.withCommands ?? 0) + (counts ? entry.withCommands : 0),
      commands: [...new Set([...old?.commands ?? [], ...entry.commands])].sort(),
    };
    const oldRuns = old?.costRuns ?? 0, freshRuns = counts && entry.costUsd !== undefined ? entry.costRuns ?? 1 : 0;
    if (freshRuns) Object.assign(merged, { costUsd: Math.round(((old?.costUsd ?? 0) * oldRuns + entry.costUsd! * freshRuns) / (oldRuns + freshRuns) * 10000) / 10000, costRuns: oldRuns + freshRuns });
    else if (old?.costUsd !== undefined) Object.assign(merged, { costUsd: old.costUsd, costRuns: oldRuns });
    cases[id] = merged;
  }
  return {
    schema: 1, generatedAt,
    observedThrough: [base.observedThrough, fresh.observedThrough].sort().at(-1)!,
    sourceRuns: [...new Set([...base.sourceRuns, ...fresh.sourceRuns])].sort(),
    cases: Object.fromEntries(Object.entries(cases).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function formatExercisedMap(map: ExercisedMap): string {
  return `${JSON.stringify(map, null, 2)}\n`;
}

/** `MAP_GAP <case> <command>`: a recorded command whose files all lie outside the case's static-plus-observed exercised closure. */
export function mapGaps(commandsByCase: Map<string, string[]>, ex: ExercisedConsumers): Array<{ id: string; command: string }> {
  const gaps: Array<{ id: string; command: string }> = [];
  for (const [id, commands] of [...commandsByCase].sort(([a], [b]) => a.localeCompare(b))) {
    const closure = ex.closure(id);
    for (const command of [...new Set(commands.flatMap(raw => ex.binsInCommand(raw)))].sort()) {
      const files = ex.commandFiles(command);
      if (files.length && !files.some(file => closure.has(file))) gaps.push({ id, command });
    }
  }
  return gaps;
}

/** Executed cases that recorded no command although their loaded skill's shell runs bins: blind to gap detection. */
export function blindCases(commandsByCase: Map<string, string[]>, ex: ExercisedConsumers): string[] {
  return [...commandsByCase].filter(([id, commands]) => commands.length === 0
    && [...ex.closure(id)].some(([file, label]) => file.startsWith('bin/') && label.startsWith('skill bash via'))).map(([id]) => id).sort();
}

/** Stable exit codes of test:exercised-map (docs/TESTING_INTERNALS.md#exercised-path-map). */
export const REFRESH_EXIT = { usage: 2, unavailable: 3, incomplete: 4 } as const;

/** A refresh that cannot be trusted: nothing is written and the committed union stays as it was. */
export class RefreshError extends Error {
  constructor(readonly exitCode: typeof REFRESH_EXIT.unavailable | typeof REFRESH_EXIT.incomplete, message: string) { super(message); }
}

/** One MAP_GAP line, saying who it is for and what follows from it. */
export function formatMapGap(gap: { id: string; command: string }): string {
  return `MAP_GAP ${gap.id} ${gap.command}: non-blocking for this PR; the next census refresh widens the map (${EXERCISED_MAP_ANCHOR})`;
}

function writeAtomically(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

/**
 * Census refresh from local report directories (paid-slice artifacts under
 * shards/, plus trial-outcomes.jsonl). Every executed case must have shard
 * evidence; a missing directory, no shards, no trial outcomes or an executed
 * case without a shard throws before anything is written.
 */
export function refreshFromReportDirs(dirs: string[], runId: string, base: ExercisedMap, ex: ExercisedConsumers, observedAt = new Date().toISOString(), maps = PR_PROFILE_MAPS) {
  const missing = dirs.filter(dir => !fs.existsSync(dir));
  if (missing.length) throw new RefreshError(REFRESH_EXIT.unavailable, `report director${missing.length > 1 ? 'ies' : 'y'} not found: ${missing.join(', ')}`);
  const shards = dirs.flatMap(readShardCommands);
  if (shards.length === 0) throw new RefreshError(REFRESH_EXIT.incomplete, `no shards/<shard>/ directories under ${dirs.join(', ')}; download every paid-slice-* artifact of the run first`);
  const outcomes = dirs.flatMap(dir => walk(dir).filter(file => path.basename(file) === 'trial-outcomes.jsonl'));
  if (outcomes.length === 0) throw new RefreshError(REFRESH_EXIT.incomplete, `no trial-outcomes.jsonl under ${dirs.join(', ')}, so the executed cases cannot be checked against the shard evidence`);
  const commands = attributeCommands(shards, maps);
  const executed = new Set(outcomes.flatMap(file => fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { const record = JSON.parse(line); return record.execution === 'executed' && typeof record.case === 'string' ? [record.case as string] : []; } catch { return []; }
  })));
  const uncovered = [...executed].filter(id => Object.hasOwn(maps.e2eTouchfiles, id) && !commands.has(id)).sort();
  if (uncovered.length) throw new RefreshError(REFRESH_EXIT.incomplete, `${uncovered.length} executed case(s) have no shard artifact: ${uncovered.slice(0, 10).join(', ')}${uncovered.length > 10 ? ' ...' : ''}`);
  const costs = new Map<string, number>();
  for (const dir of dirs) for (const [id, cost] of readCaseCosts(dir)) costs.set(id, (costs.get(id) ?? 0) + cost);
  const merged = mergeExercisedMap(base, observeRun(commands, ex, { runId, observedAt, costs }), observedAt);
  return { merged, commands };
}

function census(dirs: string[], runId: string, out: string, reportPath: string | undefined): void {
  const ex = checkoutExercisedConsumers(PR_PROFILE_MAPS, ROOT, PR_FULL_GATE_FILES);
  const base = ex.map!;
  const { merged, commands } = refreshFromReportDirs(dirs, runId, base, ex);
  writeAtomically(out, formatExercisedMap(merged));
  const added = Object.entries(merged.cases).flatMap(([id, entry]) => entry.commands.filter(command => !base.cases[id]?.commands.includes(command)).map(command => `${id} ${command}`));
  const gaps = mapGaps(commands, ex);
  const blind = blindCases(commands, ex);
  const lines = [
    '## Exercised-path map (shadow, non-blocking)', '',
    `- ${commands.size} executed case(s), ${[...commands.values()].reduce((sum, list) => sum + list.length, 0)} recorded command(s); ${added.length} new observed edge(s).`,
    `- Refresh: \`bun run test:exercised-map --from-run ${runId}\`, then open the change as an ordinary PR (shadow-only data: it selects no paid case).`,
    `- MAP_GAP (a command outside its case's static-plus-observed closure): ${gaps.length}`,
    ...gaps.map(gap => `  - ${formatMapGap(gap)}`),
    `- Cases that recorded no commands although their skill runs bins (PTY capture is the activation prerequisite): ${blind.length ? blind.join(', ') : 'none'}`,
    ...added.slice(0, 50).map(edge => `  - new: ${edge}`),
    `- Docs: ${EXERCISED_MAP_ANCHOR}`,
  ];
  console.log(lines.join('\n'));
  if (reportPath) fs.writeFileSync(reportPath, `${lines.join('\n')}\n`);
}

/** Union every exercised-commands.json of a downloaded exercised-map artifact into `base`; any missing or malformed file throws. */
export function mergeArtifactDir(dir: string, base: ExercisedMap, generatedAt = new Date().toISOString()): ExercisedMap {
  const files = fs.existsSync(dir) ? walk(dir).filter(file => path.basename(file) === 'exercised-commands.json') : [];
  if (files.length === 0) throw new RefreshError(REFRESH_EXIT.incomplete, `no exercised-commands.json in ${dir} (the census refresh step failed or its ${EXERCISED_MAP_ARTIFACT}-a<attempt> artifact is partial)`);
  let map = base;
  for (const file of files.sort()) {
    let fresh: ExercisedMap;
    try { fresh = parseExercisedMap(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw new RefreshError(REFRESH_EXIT.incomplete, `${path.relative(dir, file)} is not a complete exercised map: ${error instanceof Error ? error.message : String(error)}`); }
    map = mergeExercisedMap(map, fresh, generatedAt);
  }
  return map;
}

export type ArtifactDownload = (runId: string, dir: string) => { status: number | null; stderr: string };

const ghDownload: ArtifactDownload = (runId, dir) => {
  const result = spawnSync('gh', ['run', 'download', runId, '--pattern', `${EXERCISED_MAP_ARTIFACT}-*`, '--dir', dir], { encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, stderr: result.stderr || result.error?.message || '' };
};

/** Download a census run's exercised-map artifact and union it into `target`; on any failure nothing is written. */
export function refreshFromRun(runId: string, target: string, download: ArtifactDownload = ghDownload): ExercisedMap {
  if (!/^\d+$/.test(runId)) throw new RefreshError(REFRESH_EXIT.unavailable, `--from-run needs a numeric GitHub run id, got ${runId}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exercised-map-'));
  try {
    const result = download(runId, dir);
    if (result.status !== 0) {
      const reason = result.stderr.trim();
      const hint = /\b403\b/.test(reason)
        ? `HTTP 403 (the installation's artifact download limit); download the ${EXERCISED_MAP_ARTIFACT}-a<attempt> artifact from the run page and pass its directory with --from-dir`
        : `check \`gh auth status\` and that run ${runId} uploaded an ${EXERCISED_MAP_ARTIFACT}-a<attempt> artifact`;
      throw new RefreshError(REFRESH_EXIT.unavailable, `gh run download ${runId} failed: ${reason || `exit ${result.status}`}; ${hint}`);
    }
    const map = mergeArtifactDir(dir, parseExercisedMap(fs.readFileSync(target, 'utf8')));
    writeAtomically(target, formatExercisedMap(map));
    return map;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export const REPLAY_FIXTURE = 'test/fixtures/exercised-map-replay.json';

export interface ReplayRun { runId: number; pr: number; packageVersionOnly: boolean; failedGateCases: string[]; changedFiles: string[] }

/** One recorded red run under today's selection and its shadow: which failed gate cases each would run. */
export interface ShadowReplayRow { runId: number; pr: number; mode: string; today: number; shadow: number; savingUsd: number; caughtToday: string[]; misses: string[]; retired: string[] }

export function replayShadow(runs: readonly ReplayRun[]): ShadowReplayRow[] {
  const gateIds = Object.keys(PR_PROFILE_MAPS.tiers).filter(id => PR_PROFILE_MAPS.tiers[id] === 'gate');
  return runs.map(run => {
    const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: run.changedFiles, packageVersionOnly: run.packageVersionOnly });
    const today = new Set(result.selection.e2e ?? gateIds);
    const shadow = result.coverage?.shadow;
    if (shadow?.error) throw new Error(`run ${run.runId}: shadow unavailable (${shadow.error})`);
    const shadowSet = new Set(shadow?.e2e ?? today);
    const live = run.failedGateCases.filter(id => PR_PROFILE_MAPS.tiers[id] === 'gate');
    return { runId: run.runId, pr: run.pr, mode: result.coverage?.mode ?? 'full', today: today.size, shadow: shadowSet.size, savingUsd: shadow?.predictedSavingUsd ?? 0,
      caughtToday: live.filter(id => today.has(id)), misses: live.filter(id => !shadowSet.has(id)), retired: run.failedGateCases.filter(id => !live.includes(id)) };
  });
}

export function formatShadowReplay(rows: readonly ShadowReplayRow[]): string[] {
  const pairs = (list: readonly ShadowReplayRow[]) => list.reduce((sum, row) => sum + new Set([...row.caughtToday, ...row.misses]).size, 0);
  const misses = rows.flatMap(row => row.misses.map(id => `${row.runId} #${row.pr} ${id}`));
  const modes = new Map<string, number>();
  for (const row of rows) modes.set(row.mode, (modes.get(row.mode) ?? 0) + 1);
  const mean = (pick: (row: ShadowReplayRow) => number) => rows.length ? (rows.reduce((sum, row) => sum + pick(row), 0) / rows.length).toFixed(1) : 'n/a';
  return [
    `Exercised-path shadow replay over ${rows.length} recorded red PR run(s) on this checkout`,
    `- failed gate (run, case) pairs: ${pairs(rows)}, ${pairs(rows.filter(row => row.mode !== 'full-fallback'))} of them in runs that do not fall back to the full gate (${rows.reduce((sum, row) => sum + row.retired.length, 0)} more on cases no longer in the gate)`,
    `- today's selection runs ${rows.reduce((sum, row) => sum + row.caughtToday.length, 0)} of them; modes ${[...modes].map(([mode, n]) => `${mode} ${n}`).join(', ')}`,
    `- mean gate cases: today ${mean(row => row.today)}, shadow ${mean(row => row.shadow)}; predicted shadow saving over these runs $${rows.reduce((sum, row) => sum + row.savingUsd, 0).toFixed(2)}`,
    `- MISSES (failed, not in the shadow selection): ${misses.length}`,
    ...misses.map(miss => `  - ${miss}`),
  ];
}

const USAGE = 'usage: bun run test:exercised-map --from-run <id> [--out <file>] | --from-dir <dir>... [--run-id <id>] [--out <file>] [--report <file>] | --check | --replay [<fixture>]';

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const values = (flag: string) => argv.flatMap((arg, index) => arg === flag && argv[index + 1] ? [argv[index + 1]!] : []);
  const out = values('--out')[0] ?? path.join(ROOT, EXERCISED_MAP_PATH);
  try {
    if (argv.includes('--check')) {
      const map = parseExercisedMap(fs.readFileSync(path.join(ROOT, EXERCISED_MAP_PATH), 'utf8'));
      console.log(`${EXERCISED_MAP_PATH}: ${Object.keys(map.cases).length} cases, ${map.sourceRuns.length} source runs, observed through ${map.observedThrough}`);
    } else if (argv.includes('--replay')) {
      const fixture = JSON.parse(fs.readFileSync(path.resolve(ROOT, values('--replay')[0] ?? REPLAY_FIXTURE), 'utf8')) as { runs: ReplayRun[] };
      const rows = replayShadow(fixture.runs);
      console.log(formatShadowReplay(rows).join('\n'));
      if (rows.some(row => row.misses.length)) process.exit(1);
    } else if (values('--from-run').length) {
      const runId = values('--from-run')[0]!;
      const map = refreshFromRun(runId, out);
      console.log(`union-merged run ${runId}'s ${EXERCISED_MAP_ARTIFACT} artifact into ${path.relative(ROOT, out)} (${Object.keys(map.cases).length} cases, observed through ${map.observedThrough}); review the diff and open it as a PR`);
    } else if (values('--from-dir').length) {
      const dirs = values('--from-dir');
      if (dirs.length === 1 && fs.existsSync(dirs[0]!) && readShardCommands(dirs[0]!).length === 0 && walk(dirs[0]!).some(file => path.basename(file) === 'exercised-commands.json')) {
        const map = mergeArtifactDir(dirs[0]!, parseExercisedMap(fs.readFileSync(out, 'utf8')));
        writeAtomically(out, formatExercisedMap(map));
        console.log(`union-merged the ${EXERCISED_MAP_ARTIFACT} artifact in ${dirs[0]} into ${path.relative(ROOT, out)}; review the diff and open it as a PR`);
      } else {
        const runId = values('--run-id')[0];
        if (!runId) { console.error(`test:exercised-map: --from-dir with report directories needs --run-id <id> (the run whose artifacts these are)\n${USAGE}`); process.exit(REFRESH_EXIT.usage); }
        census(dirs, runId, out, values('--report')[0]);
      }
    } else {
      console.error(USAGE);
      process.exit(REFRESH_EXIT.usage);
    }
  } catch (error) {
    console.error(`test:exercised-map: ${error instanceof Error ? error.message : String(error)}${error instanceof RefreshError ? '; nothing was written, the committed union is unchanged' : ''}`);
    process.exit(error instanceof RefreshError ? error.exitCode : 1);
  }
}

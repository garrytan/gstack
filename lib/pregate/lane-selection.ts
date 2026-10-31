/**
 * pregate/lane-selection — from touched files to the tests that must run and
 * the platform lanes that must run them (plan C8 `lanes`). Mapping goes
 * through lib/pregate/import-graph.ts plus the generated-file registry (a
 * touched template selects the tests of its rendered outputs). Lane file
 * sets come from the workflow files: literal test paths in run steps, or the
 * runner-owned selection manifest `.gstack/pregate.json` declares for a
 * planner-computed matrix. Every uncertainty widens the selection.
 */
import { spawnSync } from 'node:child_process';
import { GENERATED_PATH } from '../regen';
import { runBashSync } from '../script-invocation';
import { matchesAny } from '../ship-policy';
import { PREGATE_CONFIG_PATH } from './config';
import { isDocsEmptyLane, isInertNoTests, isProtectedTree } from './docs-lane';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGraph, isTestFile, listRepoFiles, testsFor, type Graph } from './import-graph';
import { stampFileKind, versionStampOnly } from './stamp-only';
import type { PregateContext, RemoteObligation } from './types';
import type { Lane } from './workflows';

/** Whole-tree tests every selection that runs a test must include (GST-98). Kept out of pregate.json so older readers, which reject unknown keys, keep working. */
export const ALWAYS_RUN_PATH = '.gstack/always-run.json';

/** The tracked test files the `tests` globs in `.gstack/always-run.json` name, and the globs that name none. No file: none. */
export function alwaysRunTests(repoRoot: string, testFiles: Iterable<string>): { tests: string[]; unmatched: string[] } {
  const file = path.join(repoRoot, ALWAYS_RUN_PATH);
  if (!fs.existsSync(file)) return { tests: [], unmatched: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${ALWAYS_RUN_PATH}: not valid JSON (${(error as Error).message})`); }
  const globs = (parsed as { tests?: unknown } | null)?.tests;
  if (!Array.isArray(globs) || globs.some(g => typeof g !== 'string' || !g)) throw new Error(`${ALWAYS_RUN_PATH}: "tests" must be a list of non-empty glob strings`);
  const all = [...testFiles];
  const tests = new Set<string>();
  const unmatched: string[] = [];
  for (const glob of globs as string[]) {
    const hits = all.filter(t => matchesAny([glob], t));
    if (!hits.length) unmatched.push(glob);
    for (const t of hits) tests.add(t);
  }
  return { tests: [...tests].sort(), unmatched };
}

/** A path the branch removed (deleted, or a rename's old name) that owes no lane, with why (`note`) and the files that lost their last test. */
export interface Removed { file: string; note: string; lostCoverage: string[] }

export interface Selection {
  /** Touched files with no lane and no `[]` declaration. */
  noLane: string[];
  /** Removed paths no remaining test selects that owe no lane, each named on its own line (issue #3529); other removals stay in noLane. */
  removed: Removed[];
  /** Markdown (and `empty_lanes` paths) with no import-graph test: the docs/no-tests empty lane. */
  emptyLane: string[];
  /** Assets and dotfile tool config with no import-graph test: files no runner loads, also an empty lane. */
  inert: string[];
  /** Release manifests whose diff against the merge base changes only version values (lib/pregate/stamp-only.ts): waived, no lane needed. */
  stampOnly: string[];
  /** Every test the touched files select, sorted. */
  tests: string[];
  /** Tests that run on this machine. */
  localTests: string[];
  /** Platform lanes this machine cannot run that select part of the set. */
  remote: RemoteObligation[];
  /** Tiers of the local lanes the selection touches. */
  tiersRan: string[];
  /** `lane id → files` for every lane whose set is known, plus `?` for planner-computed lanes without a manifest. */
  laneSets: Record<string, string[] | '?'>;
  provenance: string[];
}

/** One path-shaped token: framework route segments (`(group)`, `[id]`, `[...slug]`, `@slot`, `$param`, `+page`) stay whole. */
const PATH_TOKEN = /[\w.@()[\]$+~-]+(?:\/[\w.@()[\]$+~-]+)*/g;

/** Test files a selection manifest printed, in order: every path-shaped token the import graph calls a test file. */
export function manifestTestPaths(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split('\n')) {
    for (const [token] of line.matchAll(PATH_TOKEN)) {
      const bare = token.replace(/^\.\//, '');
      const trimmed = bare.replace(/^[([]+/, '').replace(/[)\].,]+$/, '');
      const hit = [bare, trimmed].find(isTestFile);
      if (hit) found.add(hit);
    }
  }
  return [...found];
}

/** Resolve one lane's test-file set: literal paths, then the declared selection manifest, else `?` when its matrix is an expression. */
export function laneFileSet(ctx: PregateContext, lane: Lane): string[] | '?' | 'all' {
  const files = new Set(lane.testFiles);
  const manifest = ctx.config.selection[lane.id];
  if (manifest) {
    if (!ctx.allowRepoCommands) { ctx.explain.push(`lane ${lane.id}: selection manifest \`${manifest}\` not run (pass --allow-repo-commands); treated as unknown`); return files.size ? [...files] : '?'; }
    const r = runBashSync(`set -o pipefail; ${manifest}`, { cwd: ctx.repoRoot, encoding: 'utf8', timeout: Math.min(ctx.timeoutMs, 300_000), maxBuffer: 64 * 1024 * 1024, env: ctx.env });
    if (r.error && r.status === null && r.signal === null) { ctx.explain.push(`lane ${lane.id}: selection manifest could not start (${r.error.message}); treated as unknown`); return '?'; }
    if (r.status !== 0) { ctx.explain.push(`lane ${lane.id}: selection manifest exited ${r.status}; treated as unknown`); return '?'; }
    for (const f of manifestTestPaths(r.stdout ?? '')) files.add(f);
    ctx.explain.push(`lane ${lane.id}: ${files.size} files from manifest \`${manifest}\``);
    return [...files];
  }
  if (lane.matrixExpression && files.size === 0) { ctx.explain.push(`lane ${lane.id}: unsupported workflow expression ${JSON.stringify(lane.matrixExpression)} and no selection manifest; treated as unknown`); return '?'; }
  return files.size ? [...files] : 'all';
}

const STAMP_FILE_CAP = 1024 * 1024;
/** Strict UTF-8 text of `bytes`, BOM kept as content, or null when invalid (two different invalid bytes would otherwise both decode to U+FFFD and compare equal) or over the cap. */
function strictText(bytes: Buffer | null | undefined): string | null {
  if (!bytes || bytes.length > STAMP_FILE_CAP) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}
/** The file's text at the merge base when it is a regular blob there of one of `modes` (null when absent, a symlink or submodule, another mode, unreadable, invalid UTF-8 or over 1 MiB). */
function readAtMergeBase(ctx: PregateContext, rel: string, modes: readonly string[]): string | null {
  const ls = spawnSync('git', ['ls-tree', ctx.mergeBase, '--', rel], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 60_000, env: ctx.env });
  if (ls.status !== 0 || !modes.some(mode => (ls.stdout ?? '').startsWith(`${mode} blob `))) return null;
  const r = spawnSync('git', ['show', `${ctx.mergeBase}:${rel}`], { cwd: ctx.repoRoot, timeout: 60_000, maxBuffer: STAMP_FILE_CAP + 1, env: ctx.env });
  return r.status === 0 ? strictText(r.stdout as Buffer) : null;
}
/** The working-tree file's text and git mode under the same rules (a regular file only; a symlink or a mode change is not a stamp). */
function readWorkingTree(repoRoot: string, rel: string): { text: string | null; mode: string } {
  try {
    const abs = path.join(repoRoot, rel); const st = fs.lstatSync(abs);
    return { text: st.isFile() && st.size <= STAMP_FILE_CAP ? strictText(fs.readFileSync(abs)) : null, mode: st.mode & 0o111 ? '100755' : '100644' };
  } catch { return { text: null, mode: '100644' }; }
}

/** Tracked files matching a registry entry's output globs. */
function outputsOf(all: readonly string[], globs: readonly string[]): string[] { return all.filter(f => matchesAny(globs, f)); }

/**
 * Tracked files outside Markdown that mention `file`'s name without its final extension anywhere, where the import graph cannot
 * see: a curation list, a durations manifest, a script, a workflow, an extensionless path (`node test/alpha.test`), a dotted
 * module (`tests.test_alpha`), or an escaped or encoded path (`\talpha.test.js`, `test%2Falpha.test.js`).
 */
function namedBy(ctx: PregateContext, file: string): string[] {
  const base = path.posix.basename(file);
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  const r = spawnSync('git', ['grep', '--untracked', '-l', '-F', '-e', stem, '--', '.', ':(exclude)*.md', ':(exclude)*.mdx'], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: ctx.env });
  if (r.status === 1) return [];
  return r.status === 0 ? (r.stdout ?? '').split('\n').filter(Boolean) : ['(git grep failed)'];
}

/** Test languages whose importers the graph resolves file by file; a Go or Ruby test may define helpers its package still uses. */
const RESOLVED_IMPORTS = /\.(?:[cm]?[jt]sx?|py|dart)$/;

const shown = (files: readonly string[]) => `${files.slice(0, 8).join(' ')}${files.length > 8 ? ` … +${files.length - 8} more` : ''}`;

/**
 * Why a removed test no remaining test selects owes no lane, and the tests it selects, or `refused` when it must fail closed as
 * no lane. Only a removed JS, TS, Python, Dart or bats test is waived; any other removed path, a renamed source's old name
 * included, owes what an edit owes. Nothing is waived while a remaining file imports it, directly or through a directory
 * reference. A removed test runs the tests of every remaining non-Markdown file that names its basename (a curation list, a
 * durations manifest), and is refused when such a file has no test. A test renamed to a test then defers to its new name. A
 * deleted test, or one renamed to a non-test path, also runs the tests that directly exercise the files it exercised and names
 * those left with no test.
 */
function removedPath(ctx: PregateContext, graph: Graph, gone: ReadonlySet<string>, file: string): { removed: Removed; suite: string[] } | { refused: string } {
  if (!isTestFile(file)) return { refused: 'removed, but only a removed test is waived; any other removal owes what an edit owes' };
  if (!RESOLVED_IMPORTS.test(file) && !file.endsWith('.bats')) return { refused: 'removed, but a Go or Ruby test may define helpers its package still uses, which the graph cannot see' };
  const edges = [...graph.reverse].filter(([k]) => k === file || (k.endsWith('/**') && file.startsWith(k.slice(0, -2)))).flatMap(([, list]) => list);
  const importers = [...new Set(edges.map(e => e.from))].filter(f => !gone.has(f)).sort();
  if (importers.length) return { refused: `removed, but still imported by ${shown(importers)}` };
  const namerSuite = new Set<string>();
  const uncovered = namedBy(ctx, file).filter(f => !gone.has(f)).filter(n => {
    const m = testsFor(graph, n, ctx.config.dependencies);
    for (const t of m.tests) namerSuite.add(t);
    return !m.tests.length;
  });
  if (uncovered.length) return { refused: `removed, but still named by ${shown(uncovered)}, which no test covers` };
  const namerNote = namerSuite.size ? `files naming it run: ${shown([...namerSuite].sort())}` : '';
  const renamedTo = ctx.touched.find(t => t.renamedFrom === file)?.path;
  if (renamedTo && isTestFile(renamedTo)) return { removed: { file, note: [`old name of ${renamedTo}`, namerNote].filter(Boolean).join('; '), lostCoverage: [] }, suite: [...namerSuite] };
  const subjects = graph.goneSubjects?.get(file);
  if (!subjects) return { refused: 'removed test whose merge-base text could not be read (not a regular file there, invalid UTF-8 or over 1 MiB)' };
  if (!subjects.length) return { removed: { file, note: ['it exercised no file still in the tree', namerNote].filter(Boolean).join('; '), lostCoverage: [] }, suite: [...namerSuite] };
  const suite = new Set<string>();
  const lostCoverage: string[] = [];
  for (const subject of subjects) {
    const m = testsFor(graph, subject, ctx.config.dependencies);
    for (const e of graph.reverse.get(subject) ?? []) if (graph.tests.has(e.from)) suite.add(e.from);
    if (!m.tests.length && !m.declaredNone) lostCoverage.push(subject);
  }
  const notes = [
    suite.size ? `owning suite runs: ${shown([...suite].sort())}` : '',
    lostCoverage.length ? `coverage removed: ${lostCoverage.join(' ')} ${lostCoverage.length === 1 ? 'has' : 'have'} no remaining test` : '',
    namerNote,
  ].filter(Boolean);
  return { removed: { file, note: notes.join('; ') || 'its files keep indirect or declared coverage', lostCoverage }, suite: [...new Set([...suite, ...namerSuite])] };
}

export function selectLanes(ctx: PregateContext): Selection {
  const touched = ctx.touched;
  const gone = touched.flatMap(t => [t.status === 'D' ? t.path : null, t.renamedFrom ?? null]).filter((p): p is string => !!p);
  const goneSources = new Map<string, string>();
  for (const t of touched) {
    const removedTest = t.status === 'D' && isTestFile(t.path) ? t.path : t.renamedFrom && isTestFile(t.renamedFrom) && !isTestFile(t.path) ? t.renamedFrom : null;
    if (!removedTest) continue;
    const text = readAtMergeBase(ctx, removedTest, ['100644', '100755']);
    if (text !== null) goneSources.set(removedTest, text);
  }
  const graph: Graph = buildGraph(ctx.repoRoot, { declarations: ctx.config.dependencies, extraFiles: gone, goneSources });
  const goneSet = new Set(gone);
  const all = listRepoFiles(ctx.repoRoot);
  const provenance: string[] = [];
  const tests = new Set<string>();
  const noLane: string[] = [];
  const removed: Removed[] = [];
  const emptyLane: string[] = [];
  const inert: string[] = [];
  const stampOnly: string[] = [];
  const seeds = new Map<string, string>();
  const touchedByPath = new Map(touched.map(t => [t.path, t]));
  for (const t of touched) { seeds.set(t.path, t.status === 'D' ? 'deleted' : 'touched'); if (t.renamedFrom) seeds.set(t.renamedFrom, `renamed to ${t.path}`); }
  for (const e of ctx.registry.entries) {
    if (!touched.some(t => matchesAny(e.inputs, t.path) || matchesAny(e.outputs, t.path))) continue;
    for (const out of outputsOf(all, e.outputs)) if (!seeds.has(out)) seeds.set(out, `generated by ${e.id}`);
  }
  for (const [file, why] of seeds) {
    const m = testsFor(graph, file, ctx.config.dependencies);
    for (const t of m.tests) tests.add(t);
    provenance.push(...m.provenance.map(p => `${p} [${why}]`));
    if (m.tests.length || why.startsWith('generated')) continue;
    // An explicit `[]` already cleared the file. Label it docs/no-tests only when it is that class.
    if (m.declaredNone) {
      if (isDocsEmptyLane(file, ctx.config.empty_lanes ?? [])) emptyLane.push(file);
      continue;
    }
    // A renamed file keeps the lane its old name had: those tests run (and fail loudly if they still import the old path).
    const renamedFrom = touched.find(t => t.path === file && t.renamedFrom)?.renamedFrom;
    if (renamedFrom && testsFor(graph, renamedFrom, ctx.config.dependencies).tests.length) { provenance.push(`${file}: lane via its old name ${renamedFrom}`); continue; }
    // A registry input with a regen command is verified by the `regen` check (its outputs are compared fresh).
    const generator = ctx.registry.entries.find(e => e.command && matchesAny(e.inputs, file));
    if (generator) { provenance.push(`${file}: covered by regen ${generator.id} (registry input)`); continue; }
    // The pin files are validated by pregate itself (validateConfig / validateRegistry) on every run.
    if (file === PREGATE_CONFIG_PATH || file === GENERATED_PATH || file === ALWAYS_RUN_PATH) { provenance.push(`${file}: pin file validated by pregate`); continue; }
    // Reached only when testsFor mapped nothing, so a Markdown file a test reads never lands here.
    if (isDocsEmptyLane(file, ctx.config.empty_lanes ?? [])) {
      emptyLane.push(file);
      provenance.push(`${file}: docs/no-tests (empty lane)`);
      continue;
    }
    if (isInertNoTests(file)) {
      inert.push(file);
      provenance.push(`${file}: no-tests (asset or tool config no runner loads)`);
      continue;
    }
    // A release manifest the branch only re-stamped: nothing a test could observe changed, so no lane is owed (gbrain #7625). Never under a test, fixture, golden or pin tree: a test may compare against that JSON by a path the graph cannot see.
    const entry = touchedByPath.get(file);
    if (entry && entry.status === 'M' && !entry.renamedFrom && stampFileKind(file) && !isProtectedTree(file)) {
      const after = readWorkingTree(ctx.repoRoot, file);
      const verdict = versionStampOnly(file, after.text === null ? null : readAtMergeBase(ctx, file, [after.mode]), after.text);
      if (verdict.stampOnly) {
        stampOnly.push(file);
        provenance.push(`${file}: version-stamp-only against ${ctx.mergeBase.slice(0, 12)} (${verdict.changed.join('; ')}); no lane needed`);
        continue;
      }
      provenance.push(`${file}: not version-stamp-only (${verdict.reason})`);
    }
    if (gone.includes(file)) {
      const r = removedPath(ctx, graph, goneSet, file);
      if ('removed' in r) {
        removed.push(r.removed);
        for (const t of r.suite) tests.add(t);
        provenance.push(`${file}: removed (no lane owed) — ${r.removed.note}`);
        continue;
      }
      provenance.push(`${file}: ${r.refused}; no lane until declared`);
    }
    noLane.push(file);
  }
  if (tests.size || noLane.length || seeds.has(ALWAYS_RUN_PATH)) {
    const always = alwaysRunTests(ctx.repoRoot, [...graph.tests].filter(t => !goneSet.has(t)));
    for (const t of always.tests) if (!tests.has(t)) { tests.add(t); provenance.push(`${t} (always_run, ${ALWAYS_RUN_PATH})`); }
    for (const glob of always.unmatched) provenance.push(`${ALWAYS_RUN_PATH}: ${glob} matches no test file`);
  }
  const laneSets: Record<string, string[] | '?'> = {};
  const local = new Set<string>();
  const remote: RemoteObligation[] = [];
  const tiers = new Set<string>();
  const selected = [...tests].sort();
  let anyLocalAll = false;
  for (const lane of ctx.lanes.filter(l => l.runsTests && !l.manual)) {
    const set = laneFileSet(ctx, lane);
    if (set !== 'all') laneSets[lane.id] = set;
    const inLane = set === 'all' ? selected : set === '?' ? selected : selected.filter(t => set.includes(t));
    if (lane.tier === 'platform' && ctx.config.local.includes(lane.id)) ctx.explain.push(`lane ${lane.id}: ${lane.platform} lane satisfied locally (pregate.json local)`);
    else if (lane.tier === 'platform') {
      if (inLane.length) remote.push({ lane: lane.id, platform: lane.platform, workflow: lane.workflow, job: lane.job, tests: inLane, receipt: null });
      continue;
    }
    if (set === 'all') anyLocalAll = true;
    if (inLane.length) { tiers.add(lane.tier === 'platform' ? 'unit' : lane.tier); for (const t of inLane) local.add(t); }
  }
  if (anyLocalAll || ctx.lanes.filter(l => l.runsTests && !l.manual && l.tier !== 'platform').length === 0) for (const t of selected) local.add(t);
  for (const t of selected) if (!local.has(t) && !remote.some(r => r.tests.includes(t))) local.add(t);
  if (local.size && tiers.size === 0) tiers.add('unit');
  return { noLane: noLane.sort(), removed: removed.sort((a, b) => a.file.localeCompare(b.file)), emptyLane: emptyLane.sort(), inert: inert.sort(), stampOnly: stampOnly.sort(), tests: selected, localTests: [...local].sort(), remote, tiersRan: [...tiers].sort(), laneSets, provenance };
}

export function isTest(file: string): boolean { return isTestFile(file); }

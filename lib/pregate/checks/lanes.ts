/**
 * pregate check `lanes` (tier 1, tests stage): the touched files map to test
 * files (lib/pregate/lane-selection.ts); the local ones run under
 * `set -o pipefail` with the exit code and the runner's own summary judged
 * (zero tests ran is a failure, exit 0 or not); platform lanes this machine
 * cannot run become persisted `requires-remote` obligations. A touched file
 * with no lane is `FAIL lanes — <file> has no test lane`, never a pass.
 * Incidents: p0-4-pipe-hidden-failure (`false | tail` read as green),
 * p0-4-windows-lane-unrun (a Windows-only change merged with its lane unrun).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { baseInputs, sha256 } from '../context';
import { PREGATE_CONFIG_PATH } from '../config';
import { isDeviceDart, readRepoFile } from '../import-graph';
import { selectLanes, type Selection } from '../lane-selection';
import { launchRuntime } from '../runtime';
import { matchesAny } from '../../ship-policy';
import type { CheckDef, CheckResult, PregateContext } from '../types';

/** The JS or Python test command with `{files}`, detected from the repo (a declared runner is applied by planRuns). */
export function detectRunner(ctx: PregateContext, files: readonly string[]): string | null {
  const has = (f: string) => fs.existsSync(path.join(ctx.repoRoot, f));
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, 'package.json'), 'utf8')); } catch { /* no package.json */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (has('bunfig.toml') || has('bun.lock') || has('bun.lockb')) return 'bun test {files}';
  if (deps.vitest) return 'npx vitest run {files}';
  if (deps.jest) return 'npx jest {files}';
  if (files.every(f => /\.py$/.test(f)) && files.length) return 'python3 -m pytest {files}';
  if (files.every(f => /\.[cm]?js$/.test(f)) && files.length) return 'node --test {files}';
  if (files.every(f => /\.[cm]?[jt]sx?$/.test(f)) && files.length && Bun.which('bun')) return 'bun test {files}';
  return null;
}

/** One runner invocation: `files` relative to `cwd` (repo-relative, `''` for the root). */
export interface RunGroup { runner: string; cwd: string; files: string[] }

/** The nearest directory at or above `file` holding a pubspec.yaml, repo-relative; null outside any Dart package. `seen` memoises per directory. */
function dartRoot(repoRoot: string, file: string, seen: Map<string, string | null>): string | null {
  const walked: string[] = [];
  let found: string | null = null;
  for (let d = path.posix.dirname(file); ; d = path.posix.dirname(d)) {
    const rel = d === '.' ? '' : d;
    if (seen.has(rel)) { found = seen.get(rel)!; break; }
    walked.push(rel);
    if (fs.existsSync(path.join(repoRoot, rel, 'pubspec.yaml'))) { found = rel; break; }
    if (d === '.' || d === '/' || d === '') break;
  }
  for (const w of walked) seen.set(w, found);
  return found;
}

/** An fvm pin (`.fvmrc` or `.fvm/fvm_config.json`) at the package root `root` or any ancestor up to the repo root. */
function fvmPinned(repoRoot: string, root: string): boolean {
  for (let d = root; ; d = path.posix.dirname(d)) {
    const dir = path.join(repoRoot, d === '.' ? '' : d);
    if (fs.existsSync(path.join(dir, '.fvmrc')) || fs.existsSync(path.join(dir, '.fvm', 'fvm_config.json'))) return true;
    if (d === '' || d === '.' || d === '/') return false;
  }
}

/** Whether any Dart file among `files` sits in a package that fvm pins (the missing-SDK hint offers fvm only then). */
function fvmPinnedFor(repoRoot: string, files: readonly string[]): boolean {
  const seen = new Map<string, string | null>();
  return files.some(f => { const root = f.endsWith('.dart') ? dartRoot(repoRoot, f, seen) : null; return root !== null && fvmPinned(repoRoot, root); });
}

/**
 * `flutter test` for a package on the Flutter SDK, else `dart test`; through fvm
 * when the package or an ancestor up to the repo root pins one and fvm is on PATH. `missing` names the tool when
 * neither fvm nor the SDK is on PATH, so the lane is incomplete rather than a
 * test failure (exit 127).
 */
export function dartRunner(repoRoot: string, root: string, env: NodeJS.ProcessEnv): { runner: string } | { missing: string } {
  const pubspec = readRepoFile(repoRoot, path.posix.join(root, 'pubspec.yaml')) ?? '';
  // Block style (`flutter:` / `  sdk: flutter`) or flow style (`flutter: {sdk: flutter}`), comments stripped.
  const tool = /^[ \t]*sdk:[ \t]*['"]?flutter\b|^[ \t]*flutter:[ \t]*\{[^}\n]*\bsdk:[ \t]*['"]?flutter\b/m.test(pubspec.replace(/(^|\s)#.*$/gm, '$1')) ? 'flutter' : 'dart';
  const onPath = (bin: string) => !!Bun.which(bin, { PATH: env.PATH ?? '' });
  const fvm = fvmPinned(repoRoot, root) && onPath('fvm');
  if (!fvm && !onPath(tool)) return { missing: tool };
  return { runner: `${fvm ? 'fvm ' : ''}${tool} test {files}` };
}

/**
 * The invocations that run `files`. A declared runner takes every file. Otherwise
 * Dart tests run from their own package root (a sub-package's imports resolve
 * against its own pubspec), and the rest go to the detected runner; files no
 * runner claims are returned as `unclaimed`, with any Dart SDK missing from
 * PATH in `missing` (`incomplete`, never a pass).
 */
export function planRuns(ctx: PregateContext, files: readonly string[]): RunGroup[] | { unclaimed: string[]; missing: string[] } {
  if (ctx.config.runner) return [{ runner: ctx.config.runner, cwd: '', files: [...files] }];
  const groups: RunGroup[] = [];
  const dart = new Map<string, string[]>();
  const seen = new Map<string, string | null>();
  const rest: string[] = [];
  for (const f of files) {
    const root = f.endsWith('.dart') ? dartRoot(ctx.repoRoot, f, seen) : null;
    if (root === null) { rest.push(f); continue; }
    let list = dart.get(root);
    if (!list) dart.set(root, (list = []));
    list.push(root ? f.slice(root.length + 1) : f);
  }
  const unclaimed: string[] = [];
  const missing = new Set<string>();
  for (const [root, list] of [...dart].sort(([a], [b]) => a.localeCompare(b))) {
    const r = dartRunner(ctx.repoRoot, root, ctx.env);
    if ('missing' in r) { missing.add(r.missing); unclaimed.push(...list.map(f => (root ? `${root}/${f}` : f))); } else groups.push({ runner: r.runner, cwd: root, files: list });
  }
  if (rest.length) {
    const runner = detectRunner(ctx, rest);
    if (runner) groups.push({ runner, cwd: '', files: rest });
    else unclaimed.push(...rest);
  }
  return unclaimed.length ? { unclaimed, missing: [...missing].sort() } : groups;
}

export interface RunnerSummary { ran: number | null; failed: number | null }

/** The runner's own summary line: bun, node --test, vitest, jest, pytest, dart/flutter test. null when not recognised. */
export function parseSummary(output: string): RunnerSummary {
  let m: RegExpExecArray | null;
  // dart/flutter test: the last `+passed ~skipped -failed: …` verdict line (`All tests skipped.` is +0, so zero-run); progress lines carry no verdict.
  const dart = [...output.matchAll(/\+(\d+)(?: ~\d+)?(?: -(\d+))?: (?:All tests passed!|All tests skipped\.|Some tests failed\.)/g)].pop();
  if (dart) return { ran: Number(dart[1]) + Number(dart[2] ?? 0), failed: Number(dart[2] ?? 0) };
  if ((m = /^\s*(?:#|ℹ)\s*tests\s+(\d+)/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(?:#|ℹ)\s*fail\s+(\d+)/m.exec(output)?.[1] ?? 0) };
  if ((m = /Ran\s+(\d+)\s+tests?\s+across/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(\d+)\s+fail\b/m.exec(output)?.[1] ?? 0) };
  if ((m = /^\s*(\d+)\s+pass\s*$/m.exec(output))) return { ran: Number(m[1]) + Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0), failed: Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0) };
  if ((m = /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/.exec(output))) return { ran: Number(m[3]), failed: Number(m[1] ?? 0) };
  if ((m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  if (/no tests ran/i.test(output) || /No tests found/i.test(output)) return { ran: 0, failed: 0 };
  if ((m = /(?:(\d+)\s+failed,?\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  return { ran: null, failed: null };
}

interface LocalRun { exit: number | null; ran: number | null; failed: number | null; log: string; tail: string[]; command: string; zero?: string }

function runOnce(ctx: PregateContext, env: NodeJS.ProcessEnv, g: RunGroup, files: string[], log: string, timeoutMs: number): LocalRun {
  const quote = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;
  const joined = files.map(quote).join(' ');
  const run = g.runner.replace('{files}', () => joined);
  const command = g.cwd ? `(cd ${quote(g.cwd)} && ${run})` : run;
  if (timeoutMs <= 0) return { exit: null, ran: null, failed: null, log, tail: [`not started: the --timeout deadline passed before ${command}`], command };
  const r = spawnSync('bash', ['-c', `set -o pipefail; ${run}`], { cwd: path.join(ctx.repoRoot, g.cwd), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env: { ...env, CI: env.CI ?? '1' } });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  fs.appendFileSync(log, `$ ${command}\n${output}\n`);
  const summary = parseSummary(output);
  return { exit: r.status, ...summary, log, tail: output.trim().split('\n').slice(-25), command };
}

/**
 * Per run group (a Dart package from its own root, the rest from the repo
 * root): unit files in one runner process, then each serial-pattern file in
 * its own (a serial file shares process-wide state: a module mock, an env
 * mutation). Every run shares the --timeout deadline. The first non-zero or
 * timed-out run decides the exit; counts add up only when every run reported
 * a summary, and any run that reported 0 tests makes the whole lane zero-run
 * (another package's count must not hide it).
 */
function runLocal(ctx: PregateContext, env: NodeJS.ProcessEnv, groups: RunGroup[]): LocalRun & { serial: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-lanes-'));
  const log = path.join(dir, 'lanes.log');
  const deadline = Date.now() + ctx.timeoutMs;
  const runs: LocalRun[] = [];
  let serialCount = 0;
  for (const g of groups) {
    const serial = g.files.filter(f => matchesAny(ctx.config.serial_patterns, g.cwd ? `${g.cwd}/${f}` : f));
    const unit = g.files.filter(f => !serial.includes(f));
    serialCount += serial.length;
    for (const files of [...(unit.length ? [unit] : []), ...serial.map(f => [f])]) runs.push(runOnce(ctx, env, g, files, log, deadline - Date.now()));
  }
  const bad = runs.find(r => r.exit === null) ?? runs.find(r => r.exit !== 0);
  const sum = (k: 'ran' | 'failed') => (runs.some(r => r[k] === null) ? null : runs.reduce((n, r) => n + (r[k] as number), 0));
  const zero = runs.find(r => r.ran === 0);
  return { exit: bad ? bad.exit : 0, ran: zero ? 0 : sum('ran'), zero: zero?.command, failed: sum('failed'), log, tail: (bad ?? runs[runs.length - 1]!).tail, command: runs.map(r => r.command).join(' && '), serial: serialCount };
}

function describe(sel: Selection): string[] {
  const lines = sel.noLane.map(f => `FAIL lanes — ${f} has no test lane`);
  for (const r of sel.remote) lines.push(`requires-remote ${r.lane} (${r.platform}): ${r.tests.length} test(s) — ${r.tests.slice(0, 8).join(' ')}${r.tests.length > 8 ? ' …' : ''}`);
  lines.push(`Tiers ran: ${sel.tiersRan.join(' ') || '(none)'}; requires-remote: ${[...new Set(sel.remote.map(r => r.platform))].join(' ') || 'none'}`);
  return lines;
}

function run(ctx: PregateContext): CheckResult {
  const sel = selectLanes(ctx);
  ctx.explain.push(...sel.provenance);
  for (const [lane, set] of Object.entries(sel.laneSets)) ctx.explain.push(`lane ${lane}: ${set === '?' ? 'file set unknown' : `${set.length} files`}`);
  const inputs = baseInputs(ctx, { selection: sha256(sel.tests.join('\n')), localTests: sha256(sel.localTests.join('\n')), remote: sha256(sel.remote.map(r => `${r.lane}:${r.tests.join(',')}`).join('\n')) });
  const lines = describe(sel);
  const base: CheckResult = { id: 'lanes', stage: 'tests', status: 'pass', inputs, lines, remote: sel.remote };
  if (sel.noLane.length) {
    return { ...base, status: 'fail', code: 'PREGATE_NO_LANE', detail: `${sel.noLane.length} touched file(s) with no test lane: ${sel.noLane.join(' ')}`, fix: noLaneFix(ctx, sel.noLane) };
  }
  if (sel.tests.length === 0) return { ...base, detail: ctx.touched.length ? 'nothing touched selects a test' : 'no touched files' };
  if (!ctx.allowRepoCommands) return { ...base, status: 'incomplete', code: 'REPO_COMMANDS_NOT_ALLOWED', detail: `${sel.localTests.length} local test file(s) selected but not run (pass --allow-repo-commands)`, fix: 'rerun with --allow-repo-commands (what /ship passes)' };
  if (sel.localTests.length === 0) return { ...base, status: sel.remote.length ? 'requires-remote' : 'pass', detail: `no local lane; ${sel.remote.length} requires-remote obligation(s)` };
  const groups = planRuns(ctx, sel.localTests);
  if (!Array.isArray(groups)) return { ...base, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `no test runner detected for ${groups.unclaimed.length} of ${sel.localTests.length} selected file(s): ${groups.unclaimed.slice(0, 8).join(' ')}${groups.unclaimed.length > 8 ? ' …' : ''}${groups.missing.length ? `; not on PATH: ${groups.missing.join(', ')}` : ''}`, fix: groups.missing.length ? `install ${groups.missing.join(' and ')}${fvmPinnedFor(ctx.repoRoot, groups.unclaimed) ? ' (or fvm, which this repo pins)' : ''} and rerun` : 'declare `runner` (with {files}) in .gstack/pregate.json, or in <GSTACK_HOME>/projects/<slug>/pregate.json when the base carries none' };
  const runtime = launchRuntime(ctx.repoRoot, ctx.env);
  const r = runLocal(ctx, runtime.env, groups);
  const runLines = [...lines, `runtime: ${runtime.label}`, `ran: ${r.command.length > 200 ? `${r.command.slice(0, 200)}…` : r.command}`, `log: ${r.log}`, ...r.tail.map(l => `  ${l}`)];
  const withRun = { ...base, lines: runLines, inputs: { ...inputs, command: sha256(r.command), runtime: runtime.label } };
  if (r.exit === null) return { ...withRun, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `local lane timed out after ${ctx.timeoutMs} ms (${sel.localTests.length} files)`, fix: 'raise --timeout or split the selection; a timed-out lane never passes' };
  if (r.exit !== 0) return { ...withRun, status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `local lane exited ${r.exit} (${r.failed ?? '?'} failed of ${r.ran ?? '?'} ran; ${sel.localTests.length} files; pipefail)`, fix: `read ${r.log}, fix the in-branch failure, rerun gstack-pregate --stage tests` };
  if (r.ran === 0) return { ...withRun, status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `ZERO-RUN: the runner reported 0 tests${r.zero ? ` in ${r.zero}` : ''} (${sel.localTests.length} selected file(s))`, fix: 'a bad selector, a missing file or a skipped describe; exit 0 is not a pass' };
  const detail = `${r.ran ?? 'count unavailable'} tests ran in ${sel.localTests.length} file(s)${r.serial ? ` (${r.serial} serial)` : ''}, exit 0${sel.remote.length ? `; ${sel.remote.length} requires-remote obligation(s)` : ''}`;
  return { ...withRun, status: sel.remote.length ? 'requires-remote' : 'pass', detail };
}

function noLaneFix(ctx: PregateContext, noLane: readonly string[]): string {
  const file = ctx.configLabel.startsWith('user ') ? ctx.configLabel.slice('user '.length) : PREGATE_CONFIG_PATH;
  const device = noLane.some(isDeviceDart) ? `; pregate does not run device tests, so declare "**/integration_test/**": [] (and "**/test_driver/**": []) and let CI run them` : '';
  return `add a test that names the file, or declare its lane (or []) under dependencies in ${file}${device}`;
}

export const lanesCheck: CheckDef = { id: 'lanes', stage: 'tests', tier: 1, downgradable: true, needsRepoCommands: true, run };

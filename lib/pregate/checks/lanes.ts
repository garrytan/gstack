/**
 * pregate check `lanes` (tier 1, tests stage): the touched files map to test
 * files (lib/pregate/lane-selection.ts); the local ones run under
 * `set -o pipefail` with the exit code and the runner's own summary judged
 * (zero tests ran is a failure, exit 0 or not); platform lanes this machine
 * cannot run become persisted `requires-remote` obligations. A touched file
 * with no lane is `FAIL lanes — <file> has no test lane`, never a pass.
 * Markdown no test depends on is the docs/no-tests empty lane instead
 * (lib/pregate/docs-lane.ts): it does not fail, and unmapped code still does.
 * A test that reads the file still selects that test.
 * Incidents: p0-4-pipe-hidden-failure (`false | tail` read as green),
 * p0-4-windows-lane-unrun (a Windows-only change merged with its lane unrun).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { baseInputs, sha256 } from '../context';
import { PREGATE_CONFIG_PATH } from '../config';
import { isDeviceDart, readRepoFile } from '../import-graph';
import { selectLanes, type Selection } from '../lane-selection';
import { launchRuntime } from '../runtime';
import { adapterFor, readRange, supervise, type Counter, type Supervised } from '../supervise';
import { matchesAny } from '../../ship-policy';
import type { CheckDef, CheckResult, PregateContext, RemoteObligation } from '../types';

/** The test command with `{files}`; detected from the repo when the config does not name one. */
export function detectRunner(ctx: Pick<PregateContext, 'config' | 'repoRoot'>, files: readonly string[]): string | null {
  if (ctx.config.runner) return ctx.config.runner;
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
  // `sdk: flutter` (the key optionally quoted) under any dependency name (flutter, flutter_test, ...), block style or inside a flow mapping a key opens, comments stripped.
  const tool = /^[ \t]*(['"]?)sdk\1:[ \t]*['"]?flutter\b|^[ \t]*[\w-]+:[ \t]*\{(?:[^\n]*[{,])?[ \t]*(['"]?)sdk\2:[ \t]*['"]?flutter\b/m.test(pubspec.replace(/(^|\s)#.*$/gm, '$1')) ? 'flutter' : 'dart';
  const onPath = (bin: string) => !!Bun.which(bin, { PATH: env.PATH ?? '' });
  const fvm = fvmPinned(repoRoot, root) && onPath('fvm');
  if (!fvm && !onPath(tool)) return { missing: tool };
  return { runner: `${fvm ? 'fvm ' : ''}${tool} test {files}` };
}

/** The run plan: the groups that can run, the files no runner claims, Dart SDKs missing from PATH, and `.dart` files with no pubspec.yaml above. */
export interface RunPlan { groups: RunGroup[]; unclaimed: string[]; missing: string[]; noPubspec: string[] }

/**
 * The invocations that run `files`. A declared runner takes every file. Otherwise
 * Dart tests run from their own package root (a sub-package's imports resolve
 * against its own pubspec), and the rest go to the detected runner. Files no
 * runner claims (a Dart SDK missing from PATH, a `.dart` file outside any
 * package, no detected runner) are `unclaimed`: the lane is `incomplete`, never a pass.
 */
export function planRuns(ctx: PregateContext, files: readonly string[]): RunPlan {
  if (ctx.config.runner) return { groups: [{ runner: ctx.config.runner, cwd: '', files: [...files] }], unclaimed: [], missing: [], noPubspec: [] };
  const groups: RunGroup[] = [];
  const dart = new Map<string, string[]>();
  const seen = new Map<string, string | null>();
  const rest: string[] = [];
  const noPubspec: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.dart')) { rest.push(f); continue; }
    const root = dartRoot(ctx.repoRoot, f, seen);
    if (root === null) { noPubspec.push(f); continue; }
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
  return { groups, unclaimed: [...unclaimed, ...noPubspec], missing: [...missing].sort(), noPubspec };
}

/** Why `plan` leaves files unrun: their count, the missing SDKs, `.dart` files outside any package, and the fix. */
function planGap(ctx: PregateContext, plan: RunPlan, total: number): Pick<CheckResult, 'code' | 'detail' | 'fix'> {
  const { unclaimed, missing, noPubspec } = plan;
  const detail = `no test runner detected for ${unclaimed.length} of ${total} selected file(s): ${unclaimed.slice(0, 8).join(' ')}${unclaimed.length > 8 ? ' …' : ''}${missing.length ? `; not on PATH: ${missing.join(', ')}` : ''}${noPubspec.length ? `; no pubspec.yaml above ${noPubspec.length} .dart file(s)` : ''}`;
  const fix = missing.length ? `install ${missing.join(' and ')}${fvmPinnedFor(ctx.repoRoot, unclaimed) ? ' (or fvm, which this repo pins)' : ''} and rerun`
    : noPubspec.length ? `commit the Dart package's pubspec.yaml, or declare \`runner\` (with {files}) in ${ctx.configFile}`
    : `declare \`runner\` (with {files}) in ${ctx.configFile}`;
  return { code: 'PREGATE_INCOMPLETE', detail, fix };
}

export interface RunnerSummary { ran: number | null; failed: number | null }

/** bats: the pretty `N tests, M failures` line or the TAP plan `1..N`. */
function parseBats(output: string): RunnerSummary | null {
  let m: RegExpExecArray | null;
  if ((m = /^\s*(\d+)\s+tests?,\s+(\d+)\s+failures?/m.exec(output))) return { ran: Number(m[1]), failed: Number(m[2]) };
  if ((m = /^1\.\.(\d+)\s*$/m.exec(output))) return { ran: Number(m[1]), failed: (output.match(/^not ok\b/gm) ?? []).length };
  return null;
}

/** dart/flutter test: the last `+passed ~skipped -failed: …` verdict line (`All tests skipped.` is +0, so zero-run); progress lines carry no verdict. */
function parseDart(output: string): RunnerSummary | null {
  const d = [...output.matchAll(/\+(\d+)(?: ~\d+)?(?: -(\d+))?: (?:All tests passed!|All tests skipped\.|Some tests failed\.)/g)].pop();
  return d ? { ran: Number(d[1]) + Number(d[2] ?? 0), failed: Number(d[2] ?? 0) } : null;
}

/** The runner's own summary line: bun, node --test, vitest, jest, pytest, bats, dart/flutter test. A bats or dart/flutter runner's summary is tried first; for any other runner those formats are a last resort. `ran: null` when not recognised. Colour codes are dropped and a carriage return ends a line, so a coloured or redrawn verdict still reads. */
export function parseSummary(raw: string, runner = ''): RunnerSummary {
  const output = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
  if (/(?<![\w-])bats(?![\w-])/.test(runner)) { const b = parseBats(output); if (b) return b; }
  const dartRun = /(?<![\w-])(?:dart|flutter)(?![\w-])/.test(runner);
  if (dartRun) { const d = parseDart(output); if (d) return d; }
  let m: RegExpExecArray | null;
  if ((m = /^\s*(?:#|ℹ)\s*tests\s+(\d+)/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(?:#|ℹ)\s*fail\s+(\d+)/m.exec(output)?.[1] ?? 0) };
  if ((m = /Ran\s+(\d+)\s+tests?\s+across/m.exec(output))) return { ran: Number(m[1]), failed: Number(/^\s*(\d+)\s+fail\b/m.exec(output)?.[1] ?? 0) };
  if ((m = /^\s*(\d+)\s+pass\s*$/m.exec(output))) return { ran: Number(m[1]) + Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0), failed: Number(/^\s*(\d+)\s+fail\s*$/m.exec(output)?.[1] ?? 0) };
  if ((m = /Tests:\s+(?:(\d+)\s+failed,\s+)?(?:(\d+)\s+passed,\s+)?(\d+)\s+total/.exec(output))) return { ran: Number(m[3]), failed: Number(m[1] ?? 0) };
  if ((m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  if (/no tests ran/i.test(output) || /No tests found/i.test(output)) return { ran: 0, failed: 0 };
  if ((m = /(?:(\d+)\s+failed,?\s*)?(\d+)\s+passed/.exec(output))) return { ran: Number(m[2]) + Number(m[1] ?? 0), failed: Number(m[1] ?? 0) };
  return (dartRun ? null : parseDart(output)) ?? parseBats(output) ?? { ran: null, failed: null };
}

interface LocalRun { exit: number | null; outcome: Supervised['outcome']; ran: number | null; failed: number | null; tail: string[]; command: string; files: string[]; lastFile: string | null; ms: number }

const quote = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;

async function runOnce(ctx: PregateContext, env: NodeJS.ProcessEnv, g: RunGroup, files: string[], log: string, counter: Counter): Promise<LocalRun> {
  const joined = files.map(quote).join(' ');
  const run = g.runner.replace('{files}', () => joined);
  const command = g.cwd ? `(cd ${quote(g.cwd)} && ${run})` : run;
  const shown = g.cwd ? files.map(f => `${g.cwd}/${f}`) : files;
  const r = await supervise({ command: run, cwd: path.join(ctx.repoRoot, g.cwd), env: { ...env, CI: env.CI ?? '1' }, log, deadline: Date.now() + ctx.timeoutMs, stallMs: ctx.stallTimeoutMs, label: `lanes (${shown.length === 1 ? shown[0] : `${shown.length} files`})`, files, adapter: adapterFor(g.runner), counter, progress: ctx.progress });
  const output = readRange(log, r.start, r.end);
  const summary = parseSummary(output, g.runner);
  return { exit: r.exit, outcome: r.outcome, ...summary, tail: output.trim().split('\n').slice(-25), command, files: shown, lastFile: r.lastFile && g.cwd ? `${g.cwd}/${r.lastFile}` : r.lastFile, ms: r.ms };
}

/**
 * Per run group (a Dart package from its own root, the rest from the repo
 * root): unit files in one runner process, then each serial-pattern file in
 * its own (a serial file shares process-wide state: a module mock, an env
 * mutation). `--timeout` bounds each runner process; the stall timeout
 * catches a silent one. A stalled or timed-out group is killed and the next
 * one runs. The first unfinished, then the first non-zero run decides the
 * exit; counts add up only when every run reported a summary, and any run
 * that reported 0 tests makes the whole lane zero-run (another package's
 * count must not hide it).
 */
async function runLocal(ctx: PregateContext, env: NodeJS.ProcessEnv, groups: RunGroup[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-lanes-'));
  const log = path.join(dir, 'lanes.log');
  fs.writeFileSync(log, '');
  const counter: Counter = { done: 0, total: groups.reduce((n, g) => n + g.files.length, 0) };
  const runs: LocalRun[] = [];
  let serialCount = 0;
  for (const g of groups) {
    const serial = g.files.filter(f => matchesAny(ctx.config.serial_patterns, g.cwd ? `${g.cwd}/${f}` : f));
    const unit = g.files.filter(f => !serial.includes(f));
    serialCount += serial.length;
    for (const files of [...(unit.length ? [unit] : []), ...serial.map(f => [f])]) runs.push(await runOnce(ctx, env, g, files, log, counter));
  }
  const bad = runs.find(r => r.exit === null) ?? runs.find(r => r.exit !== 0);
  const sum = (k: 'ran' | 'failed') => (runs.some(r => r[k] === null) ? null : runs.reduce((n, r) => n + (r[k] as number), 0));
  const zero = runs.find(r => r.ran === 0);
  return { runs, bad, exit: bad ? bad.exit : 0, ran: zero ? 0 : sum('ran'), zero: zero?.command, failed: sum('failed'), log, tail: (bad ?? runs[runs.length - 1]!).tail, command: runs.map(r => r.command).join(' && '), serial: serialCount };
}

/** Why the local lane did not finish: a stall, a runner process past --timeout or a launch failure, with the last file started. */
function unfinished(ctx: PregateContext, r: Awaited<ReturnType<typeof runLocal>>, total: number): Pick<CheckResult, 'code' | 'detail' | 'fix'> {
  const stalled = r.runs.filter(x => x.outcome === 'stalled');
  const timedOut = r.runs.filter(x => x.outcome === 'timeout');
  const rest = r.failed ? `; ${r.failed} failed` : '';
  if (stalled.length) {
    return { code: 'PREGATE_STALLED', detail: `no test output for ${ctx.stallTimeoutMs / 1000} s; process group killed; last file started: ${stalled.map(x => x.lastFile ?? `(none reported; ${x.files.length} file(s))`).join(', ')}${rest}`, fix: `read ${r.log} for the stalled file; fix the hang, or raise --stall-timeout (stall_timeout_s in ${ctx.configFile}; 0 disables) for a test that is quiet for longer` };
  }
  if (!timedOut.length) return { code: 'PREGATE_INCOMPLETE', detail: `the runner could not be launched (${total} files${rest})`, fix: 'read the lane log, fix the runner command, then rerun gstack-pregate --stage tests' };
  return { code: 'PREGATE_INCOMPLETE', detail: `a runner process timed out after ${ctx.timeoutMs} ms (--timeout applies to each runner process; ${total} files; last file started: ${timedOut.map(x => x.lastFile ?? `(none reported; ${x.files.length} file(s))`).join(', ')}${rest})`, fix: 'raise --timeout or split the selection; a timed-out lane never passes' };
}

function describe(sel: Selection): string[] {
  const lines = sel.noLane.map(f => `FAIL lanes — ${f} has no test lane`);
  if (sel.emptyLane.length) lines.push(`docs/no-tests (empty lane): ${sel.emptyLane.join(' ')}`);
  if (sel.inert.length) lines.push(`no-tests (assets and tool config): ${sel.inert.join(' ')}`);
  for (const r of sel.remote) lines.push(`requires-remote ${r.lane} (${r.platform}): ${r.tests.length} test(s) — ${r.tests.slice(0, 8).join(' ')}${r.tests.length > 8 ? ' …' : ''}`);
  lines.push(`Tiers ran: ${sel.tiersRan.join(' ') || '(none)'}; requires-remote: ${[...new Set(sel.remote.map(r => r.platform))].join(' ') || 'none'}`);
  return lines;
}

export const SMALL_MACHINE_CORES = 8;
const GSTACK_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

/**
 * The small-machine obligation: the repo's declared `remote_gate`, else the
 * configured test backend running this selection through gstack's Ubicloud
 * runner (that command prints no PREGATE_REMOTE line, so only `clear` with a
 * run URL discharges it).
 */
function remoteObligation(ctx: PregateContext, sel: Selection): RemoteObligation {
  const declared = ctx.config.remote_gate;
  const runner = detectRunner(ctx, sel.localTests);
  const command = declared ?? `${GSTACK_ROOT}/scripts/ubicloud/ubi-runner.sh run --src ${quote(ctx.repoRoot)} -- ${quote(runner ? runner.replace('{files}', sel.localTests.map(quote).join(' ')) : '<test runner> <selected files>')}`;
  const [workflow, job] = declared ? REMOTE_GATE_LANE.split('/') as [string, string] : ['test_backend', ctx.testBackend];
  return { lane: `${workflow}/${job}`, platform: 'remote', workflow, job, tests: sel.localTests, receipt: null, command };
}

export const REMOTE_GATE_LANE = 'pregate.json/remote_gate';
/** The `clear` command for an obligation: the remote gate's own output for remote_gate, a run URL otherwise. */
export const clearHint = (lane: string) => `gstack-pregate clear --remote ${lane} ${lane === REMOTE_GATE_LANE ? '--receipt <gate output file>' : '--run-url <url>'}`;
export interface RemoteReport { tree: string; tests: number; failed: number; spent?: string }

/** The last `PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n> [spent=<usd>]` line in a remote gate's output. */
export function parseRemoteReport(output: string): RemoteReport | null {
  const m = [...output.matchAll(/^PREGATE_REMOTE: tree=(\S+) tests=(\d+) failed=(\d+)(?: spent=(\d+(?:\.\d+)?))?\s*$/gm)].pop();
  return m ? { tree: m[1]!, tests: Number(m[2]), failed: Number(m[3]), spent: m[4] } : null;
}

/** Why a remote gate report does not clear the obligation for `tree` (`--remote` and `clear --receipt`), or null when it does. */
export function remoteReportProblem(report: RemoteReport, tree: string): string | null {
  if (report.tree !== tree) return `the remote gate tested tree ${report.tree.slice(0, 12)}, not ${tree.slice(0, 12)}`;
  if (report.tests === 0) return 'the remote gate reported 0 tests';
  if (report.failed > 0) return `the remote gate reported ${report.failed} failed of ${report.tests}`;
  return null;
}

/**
 * `--remote`: run the declared remote gate now, under the spend cap. The
 * gate gets PREGATE_TREE, PREGATE_FILES_FILE and PREGATE_SPEND_CAP_USD and
 * must print `PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n> [spent=<usd>]`;
 * the obligation clears only when that tree is the tested tree, tests > 0,
 * failed = 0 and the gate exited 0. Anything else leaves it uncleared and
 * the check incomplete.
 */
async function runRemote(ctx: PregateContext, sel: Selection, base: CheckResult): Promise<CheckResult> {
  const lines = base.lines ?? [];
  if (!ctx.config.remote_gate) return { ...base, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `--remote runs only a declared remote gate; ${ctx.configLabel} has no remote_gate`, fix: `declare remote_gate (a command that prints PREGATE_REMOTE: tree=… tests=… failed=…) in ${ctx.configFile === PREGATE_CONFIG_PATH ? `${PREGATE_CONFIG_PATH} on the base branch` : ctx.configFile}, or run the tests locally without --remote` };
  const obligation = remoteObligation(ctx, sel);
  const cap = ctx.remote!.spendCapUsd;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-remote-'));
  const log = path.join(dir, 'remote.log');
  const filesFile = path.join(dir, 'files.txt');
  fs.writeFileSync(log, '');
  fs.writeFileSync(filesFile, sel.localTests.join('\n') + '\n');
  const r = await supervise({ command: obligation.command!, cwd: ctx.repoRoot, env: { ...ctx.env, PREGATE_TREE: ctx.wtree, PREGATE_FILES_FILE: filesFile, PREGATE_SPEND_CAP_USD: String(cap) }, log, deadline: Date.now() + ctx.timeoutMs, stallMs: ctx.stallTimeoutMs, label: `remote gate ${obligation.lane}`, progress: ctx.progress });
  const output = readRange(log, r.start, r.end);
  const reported = parseRemoteReport(output);
  const spent = reported?.spent;
  const spend = `spend: spent ${spent ? `$${spent}` : '$0'}, reserved $0, unknown ${spent ? '$0' : `$${cap} (no spent= reported; counted at the cap)`} (cap $${cap})`;
  ctx.progress(`PREGATE_REMOTE_SPEND: ${spend.slice('spend: '.length)}`);
  const runLines = [...lines, `remote gate: ${obligation.command}`, `log: ${log}`, spend, ...output.trim().split('\n').slice(-15).map(l => `  ${l}`)];
  const inputs = { ...base.inputs, command: sha256(obligation.command!) };
  const why = r.outcome !== 'exited' ? `the remote gate did not finish (${r.outcome === 'stalled' ? `no output for ${ctx.stallTimeoutMs / 1000} s` : r.outcome})`
    : !reported ? `the remote gate exited ${r.exit} without a PREGATE_REMOTE: line`
    : remoteReportProblem(reported, ctx.wtree) ?? (r.exit !== 0 ? `the remote gate exited ${r.exit}` : null);
  if (why) return { ...base, inputs, lines: runLines, status: 'incomplete', remote: [...sel.remote, obligation], code: r.outcome === 'stalled' ? 'PREGATE_STALLED' : 'PREGATE_INCOMPLETE', detail: `${why}; requires-remote ${obligation.lane} stays uncleared`, fix: `read ${log}; the obligation clears only on PREGATE_REMOTE: tree=${ctx.wtree.slice(0, 12)}… tests>0 failed=0 with exit 0` };
  const cleared = { ...obligation, receipt: `remote-gate tree=${ctx.wtree.slice(0, 12)} tests=${reported!.tests}`, cleared_by: `gstack-pregate --remote ${new Date().toISOString()}` };
  return { ...base, inputs, lines: runLines, status: 'requires-remote', remote: [...sel.remote, cleared], detail: `remote gate ${obligation.lane}: ${reported!.tests} tests, 0 failed on tree ${ctx.wtree.slice(0, 12)}; ${spend}` };
}

async function run(ctx: PregateContext): Promise<CheckResult> {
  const sel = selectLanes(ctx);
  ctx.explain.push(...sel.provenance);
  for (const [lane, set] of Object.entries(sel.laneSets)) ctx.explain.push(`lane ${lane}: ${set === '?' ? 'file set unknown' : `${set.length} files`}`);
  const inputs = baseInputs(ctx, { selection: sha256(sel.tests.join('\n')), localTests: sha256(sel.localTests.join('\n')), remote: sha256(sel.remote.map(r => `${r.lane}:${r.tests.join(',')}`).join('\n')) });
  const lines = describe(sel);
  const base: CheckResult = { id: 'lanes', stage: 'tests', status: 'pass', inputs, lines, remote: sel.remote };
  if (sel.noLane.length) {
    return { ...base, status: 'fail', code: 'PREGATE_NO_LANE', detail: `${sel.noLane.length} touched file(s) with no test lane: ${sel.noLane.join(' ')}`, fix: noLaneFix(ctx, sel.noLane) };
  }
  if (sel.tests.length === 0) {
    const inert = sel.inert.length ? `${sel.inert.length} asset or tool-config file(s)` : '';
    const detail = sel.emptyLane.length
      ? `docs/no-tests: ${sel.emptyLane.length} documentation file(s)${inert ? ` and ${inert}` : ''}; nothing touched selects a test`
      : inert ? `no-tests: ${inert}; nothing touched selects a test`
      : ctx.touched.length ? 'nothing touched selects a test' : 'no touched files';
    return { ...base, detail };
  }
  if (ctx.remote && sel.localTests.length) return runRemote(ctx, sel, base);
  const smallMachine = ctx.cores < SMALL_MACHINE_CORES && sel.localTests.length > 0 && (ctx.config.remote_gate || ctx.testBackend !== 'local');
  if (smallMachine) {
    const obligation = remoteObligation(ctx, sel);
    return { ...base, status: 'requires-remote', remote: [...sel.remote, obligation], lines: [...lines, `requires-remote ${obligation.lane}: ${ctx.cores} cores (under ${SMALL_MACHINE_CORES}); ${sel.localTests.length} local test file(s) recorded for the remote gate, not run here`, `run: ${obligation.command}`], detail: `${sel.localTests.length} local test file(s) recorded as requires-remote ${obligation.lane} (${ctx.cores} cores, under ${SMALL_MACHINE_CORES}); run it, then ${clearHint(obligation.lane)}, or gstack-pregate --remote --spend-cap <usd> --allow-repo-commands` };
  }
  if (!ctx.allowRepoCommands) return { ...base, status: 'incomplete', code: 'REPO_COMMANDS_NOT_ALLOWED', detail: `${sel.localTests.length} local test file(s) selected but not run (pass --allow-repo-commands)`, fix: 'rerun with --allow-repo-commands (what /ship passes)' };
  if (sel.localTests.length === 0) return { ...base, status: sel.remote.length ? 'requires-remote' : 'pass', detail: `no local lane; ${sel.remote.length} requires-remote obligation(s)` };
  // Runnable groups run even when other files are unclaimed: a real failure is reported as one, and an all-green run is still incomplete.
  const plan = planRuns(ctx, sel.localTests);
  const gap = plan.unclaimed.length ? planGap(ctx, plan, sel.localTests.length) : null;
  if (!plan.groups.length) return { ...base, status: 'incomplete', ...gap };
  const { groups } = plan;
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  const runtime = launchRuntime(ctx.repoRoot, ctx.env);
  if (runtime.refusal) return { ...base, ...runtime.refusal, lines: [`runtime: ${runtime.label}`] };
  const r = await runLocal(ctx, runtime.env, groups);
  const adapters = [...new Set(groups.map(g => adapterFor(g.runner)).filter(Boolean))];
  const runLines = [...lines, `runtime: ${runtime.label}`, `progress: ${adapters.join(', ') || 'none (no progress adapter for this runner; serial files and heartbeats only)'}`, `ran: ${r.command.length > 200 ? `${r.command.slice(0, 200)}…` : r.command}`, `log: ${r.log}`, ...r.tail.map(l => `  ${l}`)];
  const withRun = { ...base, lines: runLines, inputs: { ...inputs, command: sha256(r.command), runtime: runtime.label } };
  if (r.exit === null) return { ...withRun, status: 'incomplete', ...unfinished(ctx, r, total) };
  if (r.exit !== 0) return { ...withRun, status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `local lane exited ${r.exit} (${r.failed ?? '?'} failed of ${r.ran ?? '?'} ran; ${total} files; pipefail)`, fix: `read ${r.log}, fix the in-branch failure, rerun gstack-pregate --stage tests` };
  if (r.ran === 0) return { ...withRun, status: 'fail', code: 'PREGATE_LANE_FAILED', detail: `ZERO-RUN: the runner reported 0 tests${r.zero ? ` in ${r.zero}` : ''} (${total} selected file(s))`, fix: 'a bad selector, a missing file or a skipped describe; exit 0 is not a pass' };
  const detail = `${r.ran ?? 'count unavailable'} tests ran in ${total} file(s)${r.serial ? ` (${r.serial} serial)` : ''}, exit 0${sel.remote.length ? `; ${sel.remote.length} requires-remote obligation(s)` : ''}`;
  if (gap) return { ...withRun, status: 'incomplete', ...gap, detail: `${detail}; ${gap.detail}` };
  return { ...withRun, status: sel.remote.length ? 'requires-remote' : 'pass', detail };
}

function noLaneFix(ctx: PregateContext, noLane: readonly string[]): string {
  const device = noLane.some(isDeviceDart) ? `; pregate does not run device tests, so declare "**/integration_test/**": [] (and "**/test_driver/**": []) and let CI run them` : '';
  return `add a test that names the file, or declare its lane (or []) under dependencies — or empty_lanes for other documentation — in ${ctx.configFile}${device}`;
}

export const lanesCheck: CheckDef = { id: 'lanes', stage: 'tests', tier: 1, downgradable: true, needsRepoCommands: true, run };

/**
 * pregate check `lanes` (tier 1, tests stage): the touched files map to test
 * files (lib/pregate/lane-selection.ts); the local ones run under
 * `set -o pipefail` with the exit code and the runner's own summary judged
 * (zero tests ran is a failure, exit 0 or not); platform lanes this machine
 * cannot run become persisted `requires-remote` obligations. A touched file
 * with no lane is `FAIL lanes — <file> has no test lane` once any policy
 * exists; with no policy anywhere (no base `.gstack/pregate.json`, no
 * user-owned file) it is the `warn` PREGATE_NO_POLICY with a starter printed
 * (lib/pregate/starter.ts), never a pass either way.
 * Markdown no test depends on is the docs/no-tests empty lane instead
 * (lib/pregate/docs-lane.ts): it does not fail, and unmapped code still does.
 * A release manifest whose diff against the merge base changes only version
 * values is waived as version-stamp-only (lib/pregate/stamp-only.ts) and named
 * on its own line; any other change to it still needs a lane.
 * A removed test (deleted, or a rename's old name) no remaining test selects
 * owes no lane when nothing remaining imports it, and is named on its own
 * `removed (no lane owed)` line; it runs the tests of files that still name it,
 * and a deleted test runs its owning suite or names the files that lost their
 * last test (issue #3529). Any other removal owes what an edit owes.
 * A test that reads the file still selects that test.
 * Incidents: p0-4-pipe-hidden-failure (`false | tail` read as green),
 * p0-4-windows-lane-unrun (a Windows-only change merged with its lane unrun).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { baseInputs, sha256 } from '../context';
import { PREGATE_CONFIG_PATH } from '../config';
import { classifyCommandEnvironment, classifyEnvironment, environmentLine, environmentResult, launchCause } from '../environment';
import { checkScratch } from '../run-scratch';
import { starterPolicy } from '../starter';
import { isDeviceDart, listRepoFiles, readRepoFile } from '../import-graph';
import { selectLanes, type Selection } from '../lane-selection';
import { launchRuntime } from '../runtime';
import { cargoModel, type CargoModel } from '../rust';
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

/** The nearest directory at or above `file` holding `marker`, repo-relative; null when none does. `seen` memoises per directory (one map per marker). */
function nearestRoot(repoRoot: string, file: string, marker: string, seen: Map<string, string | null>): string | null {
  const walked: string[] = [];
  let found: string | null = null;
  for (let d = path.posix.dirname(file); ; d = path.posix.dirname(d)) {
    const rel = d === '.' ? '' : d;
    if (seen.has(rel)) { found = seen.get(rel)!; break; }
    walked.push(rel);
    if (fs.existsSync(path.join(repoRoot, rel, marker))) { found = rel; break; }
    if (d === '.' || d === '/' || d === '') break;
  }
  for (const w of walked) seen.set(w, found);
  return found;
}

/** The nearest directory at or above `file` holding a pubspec.yaml, repo-relative; null outside any Dart package. */
function dartRoot(repoRoot: string, file: string, seen: Map<string, string | null>): string | null { return nearestRoot(repoRoot, file, 'pubspec.yaml', seen); }

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

/** Whether `bin` is on the PATH of `env` (the PATH the runner will get). */
const onPath = (bin: string, env: NodeJS.ProcessEnv) => !!Bun.which(bin, { PATH: env.PATH ?? '' });

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
  const fvm = fvmPinned(repoRoot, root) && onPath('fvm', env);
  if (!fvm && !onPath(tool, env)) return { missing: tool };
  return { runner: `${fvm ? 'fvm ' : ''}${tool} test {files}` };
}

/**
 * `cargo test -p <name>` for a crate (cargo runs a crate's tests, never a file list), or the missing tool when cargo is
 * not on PATH. The name comes from the repo's Cargo.toml and reaches a shell and the `{files}` expansion: a name outside
 * Cargo's grammar (letters, digits, `_`, `-`) gets no runner (null), and a valid one is still quoted like every file and cwd.
 */
function cargoRunner(name: string, env: NodeJS.ProcessEnv): { runner: string } | { missing: string } | null {
  if (!/^[\p{ID_Continue}-]+$/u.test(name)) return null;
  return onPath('cargo', env) ? { runner: `cargo test -p ${quote(name)}` } : { missing: 'cargo' };
}

type PackageJson = { packageManager?: string; devDependencies?: Record<string, string>; dependencies?: Record<string, string>; scripts?: Record<string, string> };
function readPackageJson(repoRoot: string, dir: string): PackageJson | null {
  try { return JSON.parse(readRepoFile(repoRoot, path.posix.join(dir, 'package.json')) ?? 'null'); } catch { return null; }
}

const LOCKFILES: Array<[string, string]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']];
const PM_EXEC: Record<string, string> = { pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bun x', npm: 'npx' };

/** The package manager for a package: the first `packageManager` field or lockfile from its directory up to the repo root; npm when none. */
function packageManager(repoRoot: string, dir: string): string {
  for (let d = dir; ; d = path.posix.dirname(d)) {
    const rel = d === '.' ? '' : d;
    const declared = /^(pnpm|yarn|bun|npm)@/.exec(readPackageJson(repoRoot, rel)?.packageManager ?? '')?.[1];
    if (declared) return declared;
    const lock = LOCKFILES.find(([f]) => fs.existsSync(path.join(repoRoot, rel, f)));
    if (lock) return lock[1];
    if (rel === '') return 'npm';
  }
}

/**
 * The runner a nested package (not the repo root) declares for itself: vitest
 * or jest in its dependencies or its `test` script, through the package manager
 * its `packageManager` field or nearest lockfile names; null when it declares
 * neither, so its files stay with the root runner. `missing` names a package
 * manager that is not on PATH.
 */
function packageRunner(repoRoot: string, dir: string, env: NodeJS.ProcessEnv): { runner: string } | { missing: string } | null {
  const pkg = readPackageJson(repoRoot, dir);
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = pkg.scripts?.test ?? '';
  const tool = deps.vitest || /\bvitest\b/.test(script) ? 'vitest run' : deps.jest || /\bjest\b/.test(script) ? 'jest' : null;
  if (!tool) return null;
  const pm = packageManager(repoRoot, dir);
  const bin = pm === 'npm' ? 'npx' : pm;
  if (!onPath(bin, env)) return { missing: bin };
  return { runner: `${PM_EXEC[pm]} ${tool} {files}` };
}

/** The run plan: the groups that can run, the files no runner claims, tools missing from PATH, and `.dart` files with no pubspec.yaml above. */
export interface RunPlan { groups: RunGroup[]; unclaimed: string[]; missing: string[]; noPubspec: string[] }

/**
 * The invocations that run `files`. A declared runner takes every file. Otherwise
 * Dart tests run from their own package root (a sub-package's imports resolve
 * against its own pubspec); Rust tests run per crate as `cargo test -p <name>`
 * from the crate's workspace root; JS/TS tests owned by a nested package that
 * declares vitest or jest run from that package; the rest go to the detected
 * runner from the repo root. Files no runner claims (a tool missing from PATH,
 * a `.dart` file outside any package, a `.rs` file outside any crate or in a
 * crate whose name Cargo would reject, no detected runner) are `unclaimed`: the lane is `incomplete`, never a pass.
 */
export function planRuns(ctx: PregateContext, files: readonly string[]): RunPlan {
  if (ctx.config.runner) return { groups: [{ runner: ctx.config.runner, cwd: '', files: [...files] }], unclaimed: [], missing: [], noPubspec: [] };
  const groups: RunGroup[] = [];
  const dart = new Map<string, string[]>();
  const cargo = new Map<string, { name: string; cwd: string; files: string[] }>();
  const packages = new Map<string, string[]>();
  const seen = new Map<string, string | null>();
  const seenPackage = new Map<string, string | null>();
  let model: CargoModel | null = null;
  const pkgRunners = new Map<string, ReturnType<typeof packageRunner>>();
  const rest: string[] = [];
  const noPubspec: string[] = [];
  const unclaimed: string[] = [];
  const missing = new Set<string>();
  const add = <T>(map: Map<string, T[]>, key: string, value: T) => { let list = map.get(key); if (!list) map.set(key, (list = [])); list.push(value); };
  const under = (root: string, f: string) => (root ? f.slice(root.length + 1) : f);
  for (const f of files) {
    if (f.endsWith('.rs')) {
      model ??= cargoModel(listRepoFiles(ctx.repoRoot), rel => readRepoFile(ctx.repoRoot, rel));
      const crate = model.crateOf(f);
      const cwd = crate?.workspace ?? null;
      if (!crate || cwd === null) { unclaimed.push(f); continue; }
      const key = `${cwd}\0${crate.name}`;
      if (!cargo.has(key)) cargo.set(key, { name: crate.name, cwd, files: [] });
      cargo.get(key)!.files.push(under(cwd, f));
      continue;
    }
    const pkg = /\.[cm]?[jt]sx?$/.test(f) ? nearestRoot(ctx.repoRoot, f, 'package.json', seenPackage) : null;
    if (pkg) {
      if (!pkgRunners.has(pkg)) pkgRunners.set(pkg, packageRunner(ctx.repoRoot, pkg, ctx.env));
      const r = pkgRunners.get(pkg);
      if (r && 'missing' in r) { missing.add(r.missing); unclaimed.push(f); continue; }
      if (r) { add(packages, pkg, under(pkg, f)); continue; }
    }
    if (!f.endsWith('.dart')) { rest.push(f); continue; }
    const root = dartRoot(ctx.repoRoot, f, seen);
    if (root === null) { noPubspec.push(f); continue; }
    add(dart, root, under(root, f));
  }
  for (const [root, list] of [...dart].sort(([a], [b]) => a.localeCompare(b))) {
    const r = dartRunner(ctx.repoRoot, root, ctx.env);
    if ('missing' in r) { missing.add(r.missing); unclaimed.push(...list.map(f => (root ? `${root}/${f}` : f))); } else groups.push({ runner: r.runner, cwd: root, files: list });
  }
  for (const [, c] of [...cargo].sort(([a], [b]) => a.localeCompare(b))) {
    const r = cargoRunner(c.name, ctx.env);
    if (r && 'runner' in r) { groups.push({ runner: r.runner, cwd: c.cwd, files: c.files }); continue; }
    if (r) missing.add(r.missing);
    unclaimed.push(...c.files.map(f => (c.cwd ? `${c.cwd}/${f}` : f)));
  }
  if (rest.length) {
    const runner = detectRunner(ctx, rest);
    if (runner) groups.push({ runner, cwd: '', files: rest });
    else unclaimed.push(...rest);
  }
  for (const [root, list] of [...packages].sort(([a], [b]) => a.localeCompare(b))) groups.push({ runner: (pkgRunners.get(root) as { runner: string }).runner, cwd: root, files: list });
  return { groups, unclaimed: [...unclaimed, ...noPubspec], missing: [...missing].sort(), noPubspec };
}

/** Why `plan` leaves files unrun: their count, the missing SDKs, `.dart` files outside any package, and the fix. */
function planGap(ctx: PregateContext, plan: RunPlan, total: number): Pick<CheckResult, 'code' | 'detail' | 'fix' | 'cause' | 'environment'> {
  const { unclaimed, missing, noPubspec } = plan;
  const detail = `no test runner detected for ${unclaimed.length} of ${total} selected file(s): ${unclaimed.slice(0, 8).join(' ')}${unclaimed.length > 8 ? ' …' : ''}${missing.length ? `; not on PATH: ${missing.join(', ')}` : ''}${noPubspec.length ? `; no pubspec.yaml above ${noPubspec.length} .dart file(s)` : ''}`;
  // A tool missing from PATH is this machine's gap, not the diff's; no runner declared or no pubspec is the repo's.
  if (missing.length) return { code: 'PREGATE_ENVIRONMENT', cause: 'environment', environment: launchCause('missing-binary', `not on PATH: ${missing.join(', ')}`), detail, fix: `install ${missing.join(' and ')}${fvmPinnedFor(ctx.repoRoot, unclaimed) ? ' (or fvm, which this repo pins)' : ''} on this machine and rerun, or run the lane remotely; the diff is not at fault` };
  const fix = noPubspec.length ? `commit the Dart package's pubspec.yaml, or declare \`runner\` (with {files}) in ${ctx.configFile}`
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

/** cargo test: one `test result: ok|FAILED. N passed; M failed; …` line per test binary (unit tests, each integration test, doc-tests), summed; ignored and filtered-out tests did not run. */
function parseCargo(output: string): RunnerSummary | null {
  const lines = [...output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed;/gm)];
  if (!lines.length) return null;
  const failed = lines.reduce((n, m) => n + Number(m[2]), 0);
  return { ran: lines.reduce((n, m) => n + Number(m[1]), 0) + failed, failed };
}

/** The runner's own summary line: bun, node --test, vitest, jest, pytest, bats, dart/flutter test, cargo test. A bats, dart/flutter or cargo runner's summary is tried first (cargo's only there: its `N passed` lines would misread as another runner's); for any other runner the bats and dart formats are a last resort. `ran: null` when not recognised. Colour codes are dropped and a carriage return ends a line, so a coloured or redrawn verdict still reads. */
export function parseSummary(raw: string, runner = ''): RunnerSummary {
  const output = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
  if (/(?<![\w-])cargo\s+test(?![\w-])/.test(runner)) return parseCargo(output) ?? { ran: null, failed: null };
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

interface LocalRun { exit: number | null; outcome: Supervised['outcome']; signal: string | null; observedStart: boolean; ran: number | null; failed: number | null; tail: string[]; runner: string; command: string; files: string[]; lastFile: string | null; ms: number; error?: string }

const quote = (f: string) => `'${f.replace(/'/g, `'\\''`)}'`;

async function runOnce(ctx: PregateContext, env: NodeJS.ProcessEnv, g: RunGroup, files: string[], log: string, counter: Counter): Promise<LocalRun> {
  const joined = files.map(quote).join(' ');
  const run = g.runner.replace('{files}', () => joined);
  const command = g.cwd ? `(cd ${quote(g.cwd)} && ${run})` : run;
  const shown = g.cwd ? files.map(f => `${g.cwd}/${f}`) : files;
  const r = await supervise({ command: run, cwd: path.join(ctx.repoRoot, g.cwd), env: { ...env, CI: env.CI ?? '1' }, log, deadline: Date.now() + ctx.timeoutMs, stallMs: ctx.stallTimeoutMs, label: `lanes (${shown.length === 1 ? shown[0] : `${shown.length} files`})`, files, adapter: adapterFor(g.runner), counter, progress: ctx.progress });
  const output = readRange(log, r.start, r.end);
  const summary = parseSummary(output, g.runner);
  return { exit: r.exit, outcome: r.outcome, signal: r.signal, observedStart: r.observedStart, ...summary, tail: output.trim().split('\n').slice(-25), runner: g.runner, command, files: shown, lastFile: r.lastFile && g.cwd ? `${g.cwd}/${r.lastFile}` : r.lastFile, ms: r.ms, ...(r.error ? { error: r.error } : {}) };
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
  const dir = checkScratch(ctx.scratch, 'lanes');
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
function unfinished(ctx: PregateContext, r: Awaited<ReturnType<typeof runLocal>>, total: number): Pick<CheckResult, 'code' | 'detail' | 'fix' | 'environment'> {
  const stalled = r.runs.filter(x => x.outcome === 'stalled');
  const timedOut = r.runs.filter(x => x.outcome === 'timeout');
  const rest = r.failed ? `; ${r.failed} failed` : '';
  if (stalled.length) {
    return { code: 'PREGATE_STALLED', detail: `no test output for ${ctx.stallTimeoutMs / 1000} s; process group killed; last file started: ${stalled.map(x => x.lastFile ?? `(none reported; ${x.files.length} file(s))`).join(', ')}${rest}`, fix: `read ${r.log} for the stalled file; fix the hang, or raise --stall-timeout (stall_timeout_s in ${ctx.configFile}; 0 disables) for a test that is quiet for longer` };
  }
  const launch = r.runs.find(x => x.outcome === 'spawn-failed');
  if (launch) {
    const environment = { ...(classifyEnvironment(launch.error ?? '', null) ?? launchCause('missing-binary', launch.error ?? 'the runner could not be started')), proof: 'launch' as const };
    return { environment, detail: `the runner could not be launched (${total} files${rest}): ${environment.evidence}` };
  }
  if (!timedOut.length) {
    // The runner started and died without an exit code (a signal: OOM kill, SIGSEGV, an outside kill): incomplete, not the machine's missing binary.
    const killed = r.runs.find(x => x.outcome === 'exited' && x.exit === null);
    return { code: 'PREGATE_INCOMPLETE', detail: `the runner process ended without an exit code (killed by ${killed?.signal ?? 'a signal'}; ${total} files; last file started: ${killed?.lastFile ?? 'none reported'}${rest})`, fix: `read ${r.log}; a runner killed by a signal (out of memory, an outside kill) never passes; rerun, or split the selection` };
  }
  return { code: 'PREGATE_INCOMPLETE', detail: `a runner process timed out after ${ctx.timeoutMs} ms (${ctx.timeoutSource ?? '--timeout'} applies to each runner process; ${total} files; last file started: ${timedOut.map(x => x.lastFile ?? `(none reported; ${x.files.length} file(s))`).join(', ')}${rest})`, fix: 'raise --timeout or split the selection; a timed-out lane never passes' };
}

function describe(sel: Selection, noPolicy = false): string[] {
  const lines = noPolicy ? [`no policy: ${sel.noLane.join(' ')} have no test lane (a warning under no policy; the starter below maps them)`] : sel.noLane.map(f => `FAIL lanes — ${f} has no test lane`);
  for (const r of sel.removed) lines.push(`removed (no lane owed): ${r.file} — ${r.note}`);
  if (sel.emptyLane.length) lines.push(`docs/no-tests (empty lane): ${sel.emptyLane.join(' ')}`);
  if (sel.inert.length) lines.push(`no-tests (assets and tool config): ${sel.inert.join(' ')}`);
  if (sel.stampOnly.length) lines.push(`version-stamp-only (no lane needed): ${sel.stampOnly.join(' ')} — only version values changed against the merge base; a manifest whose other content changed still needs a lane`);
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
/** How many leading lines of a remote gate's output are read for an environment cause: its preamble, before any test output could stream. */
export const REMOTE_PREAMBLE_LINES = 40;
/** The `clear` command for an obligation: the remote gate's own output for remote_gate, a run URL otherwise. */
export const clearHint = (lane: string) => `gstack-pregate clear --remote ${lane} ${lane === REMOTE_GATE_LANE ? '--receipt <gate output file>' : '--run-url <url>'}`;
export interface RemoteReport { tree: string; tests: number; failed: number; spent?: string }

/** The last `PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n> [spent=<usd>]` line in a remote gate's output. */
export function parseRemoteReport(output: string): RemoteReport | null {
  const m = [...output.matchAll(/^PREGATE_REMOTE: tree=(\S+) tests=(\d+) failed=(\d+)(?: spent=(\d+(?:\.\d+)?))?\s*$/gm)].pop();
  return m ? { tree: m[1]!, tests: Number(m[2]), failed: Number(m[3]), spent: m[4] } : null;
}

/** The tree-mismatch clause `--remote`, `clear --receipt` and the stamp-only substitution (lib/pregate/remote-receipt.ts) all open with. */
export const treeMismatch = (tested: string, tree: string) => `the remote gate tested tree ${tested.slice(0, 12)}, not ${tree.slice(0, 12)}`;

/** Why a remote gate report does not clear the obligation for `tree` (`--remote` and `clear --receipt`), or null when it does. */
export function remoteReportProblem(report: RemoteReport, tree: string): string | null {
  if (report.tree !== tree) return treeMismatch(report.tree, tree);
  if (report.tests === 0) return 'the remote gate reported 0 tests';
  if (report.failed > 0) return `the remote gate reported ${report.failed} failed of ${report.tests}`;
  return null;
}

/**
 * `--remote`: run the declared remote gate now, under the spend cap. The
 * gate gets PREGATE_TREE, PREGATE_FILES_FILE, PREGATE_SPEND_CAP_USD and
 * PREGATE_TIMEOUT_S (this run's per-process timeout, whole seconds) and
 * must print `PREGATE_REMOTE: tree=<tree> tests=<n> failed=<n> [spent=<usd>]`;
 * the obligation clears only when that tree is the tested tree, tests > 0,
 * failed = 0 and the gate exited 0. Anything else leaves it uncleared and
 * the check incomplete. The gate is bounded by that timeout only: a gate
 * that waits on CI is quiet by design, so the stall timer does not apply,
 * and its heartbeat names the gate's last output line.
 */
async function runRemote(ctx: PregateContext, sel: Selection, base: CheckResult): Promise<CheckResult> {
  const lines = base.lines ?? [];
  if (!ctx.config.remote_gate) return { ...base, status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: `--remote runs only a declared remote gate; ${ctx.configLabel} has no remote_gate`, fix: `declare remote_gate (a command that prints PREGATE_REMOTE: tree=… tests=… failed=…) in ${ctx.configFile === PREGATE_CONFIG_PATH ? `${PREGATE_CONFIG_PATH} on the base branch` : ctx.configFile}, or run the tests locally without --remote` };
  const obligation = remoteObligation(ctx, sel);
  const cap = ctx.remote!.spendCapUsd;
  const dir = checkScratch(ctx.scratch, 'remote');
  const log = path.join(dir, 'remote.log');
  const filesFile = path.join(dir, 'files.txt');
  fs.writeFileSync(log, '');
  fs.writeFileSync(filesFile, sel.localTests.join('\n') + '\n');
  const r = await supervise({ command: obligation.command!, cwd: ctx.repoRoot, env: { ...ctx.env, PREGATE_TREE: ctx.wtree, PREGATE_FILES_FILE: filesFile, PREGATE_SPEND_CAP_USD: String(cap), PREGATE_TIMEOUT_S: String(Math.floor(ctx.timeoutMs / 1000)) }, log, deadline: Date.now() + ctx.timeoutMs, stallMs: 0, lastLine: true, label: `remote gate ${obligation.lane}`, progress: ctx.progress });
  const output = readRange(log, r.start, r.end);
  const reported = parseRemoteReport(output);
  const spent = reported?.spent;
  const spend = `spend: spent ${spent ? `$${spent}` : '$0'}, reserved $0, unknown ${spent ? '$0' : `$${cap} (no spent= reported; counted at the cap)`} (cap $${cap})`;
  ctx.progress(`PREGATE_REMOTE_SPEND: ${spend.slice('spend: '.length)}`);
  const runLines = [...lines, `remote gate: ${obligation.command}`, `log: ${log}`, spend, ...output.trim().split('\n').slice(-15).map(l => `  ${l}`)];
  const inputs = { ...base.inputs, command: sha256(obligation.command!) };
  const why = r.outcome === 'timeout' ? `the remote gate did not finish (timed out after ${ctx.timeoutMs / 1000} s, ${ctx.timeoutSource})`
    : r.outcome !== 'exited' ? `the remote gate did not finish (${r.outcome})`
    : !reported ? `the remote gate exited ${r.exit} without a PREGATE_REMOTE: line`
    : remoteReportProblem(reported, ctx.wtree) ?? (r.exit !== 0 ? `the remote gate exited ${r.exit}` : null);
  // A gate that printed no report and names a quota, network or missing-tool error in its preamble never ran the tests: the environment, not the diff.
  // Only the gate's first lines are read (a VM refusal or a network error comes before any test streams); exit 127 counts only when the gate's own binary is off PATH.
  const environment = why && !reported && r.outcome !== 'timeout'
    ? r.outcome === 'spawn-failed' ? { ...(classifyEnvironment(r.error ?? '', null) ?? launchCause('missing-binary', r.error ?? 'the remote gate could not be started')), proof: 'launch' as const } : classifyCommandEnvironment(obligation.command!, output.split('\n').slice(0, REMOTE_PREAMBLE_LINES).join('\n'), r.exit, ctx.env)
    : null;
  if (environment) return environmentResult({ ...base, inputs, lines: runLines, remote: [...sel.remote, obligation] }, environment, `${why}; requires-remote ${obligation.lane} stays uncleared`);
  if (why) return { ...base, inputs, lines: runLines, status: 'incomplete', remote: [...sel.remote, obligation], code: 'PREGATE_INCOMPLETE', detail: `${why}; requires-remote ${obligation.lane} stays uncleared`, fix: `read ${log}; the obligation clears only on PREGATE_REMOTE: tree=${ctx.wtree.slice(0, 12)}… tests>0 failed=0 with exit 0` };
  const cleared = { ...obligation, receipt: `remote-gate tree=${ctx.wtree.slice(0, 12)} tests=${reported!.tests}`, cleared_by: `gstack-pregate --remote ${new Date().toISOString()}` };
  return { ...base, inputs, lines: runLines, status: 'requires-remote', remote: [...sel.remote, cleared], detail: `remote gate ${obligation.lane}: ${reported!.tests} tests, 0 failed on tree ${ctx.wtree.slice(0, 12)}; ${spend}` };
}

/** The lanes verdict for a selection: the selected tests run (locally, remotely or as obligations) and the result names the diff or the machine. */
async function runSelected(ctx: PregateContext, sel: Selection, base: CheckResult): Promise<CheckResult> {
  const { inputs, lines = [] } = base;
  if (sel.tests.length === 0) {
    const classes = [sel.emptyLane.length ? `${sel.emptyLane.length} documentation file(s)` : '', sel.inert.length ? `${sel.inert.length} asset or tool-config file(s)` : '', sel.stampOnly.length ? `${sel.stampOnly.length} version-stamp-only manifest(s)` : ''].filter(Boolean);
    const label = sel.emptyLane.length ? 'docs/no-tests' : sel.inert.length ? 'no-tests' : 'version-stamp-only';
    const detail = classes.length ? `${label}: ${classes.join(' and ')}; nothing touched selects a test`
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
  if (!plan.groups.length) return { ...base, status: 'incomplete', ...gap, ...(gap?.environment ? { lines: [...lines, environmentLine(gap.environment)] } : {}) };
  const { groups } = plan;
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  const runtime = launchRuntime(ctx.repoRoot, ctx.env);
  if (runtime.refusal) return { ...base, ...runtime.refusal, cause: 'environment', environment: launchCause('runtime', runtime.refusal.detail), lines: [`runtime: ${runtime.label}`, environmentLine(launchCause('runtime', runtime.refusal.detail))] };
  const r = await runLocal(ctx, runtime.env, groups);
  const adapters = [...new Set(groups.map(g => adapterFor(g.runner)).filter(Boolean))];
  const runLines = [...lines, `runtime: ${runtime.label}`, `progress: ${adapters.join(', ') || 'none (no progress adapter for this runner; serial files and heartbeats only)'}`, `ran: ${r.command.length > 200 ? `${r.command.slice(0, 200)}…` : r.command}`, `log: ${r.log}`, ...r.tail.map(l => `  ${l}`)];
  const withRun = { ...base, lines: runLines, inputs: { ...inputs, command: sha256(r.command), runtime: runtime.label } };
  if (r.exit === null) {
    const why = unfinished(ctx, r, total);
    return why.environment ? environmentResult(withRun, why.environment, why.detail!) : { ...withRun, status: 'incomplete', ...why };
  }
  if (r.exit !== 0) {
    // The runner's own summary decides: a counted failure is the diff's. Only a run that reported no test at all, and whose runner was not seen
    // starting a test file (a test that exits the process before the summary cannot relabel itself), is read from its output; exit 127 counts
    // only when the runner's binary is off PATH.
    const environment = r.ran === null && r.bad && !r.bad.observedStart ? classifyCommandEnvironment(r.bad.runner, r.tail.join('\n'), r.exit, runtime.env) : null;
    if (environment) return environmentResult(withRun, environment, `the runner exited ${r.exit} before any test was counted (${total} files): ${environment.evidence}`);
    return { ...withRun, status: 'fail', cause: 'diff', code: 'PREGATE_LANE_FAILED', detail: `local lane exited ${r.exit} (${r.failed ?? '?'} failed of ${r.ran ?? '?'} ran; ${total} files; pipefail)`, fix: `read ${r.log}, fix the in-branch failure, rerun gstack-pregate --stage tests` };
  }
  if (r.ran === 0) return { ...withRun, status: 'fail', cause: 'diff', code: 'PREGATE_LANE_FAILED', detail: `ZERO-RUN: the runner reported 0 tests${r.zero ? ` in ${r.zero}` : ''} (${total} selected file(s))`, fix: 'a bad selector, a missing file or a skipped describe; exit 0 is not a pass' };
  const detail = `${r.ran ?? 'count unavailable'} tests ran in ${total} file(s)${r.serial ? ` (${r.serial} serial)` : ''}, exit 0${sel.remote.length ? `; ${sel.remote.length} requires-remote obligation(s)` : ''}`;
  if (gap) return { ...withRun, status: 'incomplete', ...gap, detail: `${detail}; ${gap.detail}`, ...(gap.environment ? { lines: [...runLines, environmentLine(gap.environment)] } : {}) };
  return { ...withRun, status: sel.remote.length ? 'requires-remote' : 'pass', detail };
}

/**
 * With no policy anywhere (no base `.gstack/pregate.json`, no user-owned
 * file), an unmapped file is a warning with a starter policy, not a hard
 * failure: the selected tests still ran and their verdict stands; a green run
 * becomes `warn` (PREGATE_NO_POLICY) so the first /ship in a new repo is not
 * blocked before the owner has written a lane policy.
 */
function withStarter(ctx: PregateContext, sel: Selection, result: CheckResult): CheckResult {
  const lines = [...(result.lines ?? []), ...starterPolicy(ctx, sel.noLane, detectRunner(ctx, sel.localTests.length ? sel.localTests : sel.tests))];
  const noted = `${sel.noLane.length} touched file(s) with no test lane under no policy (starter printed)`;
  if (result.status !== 'pass') return { ...result, lines, detail: `${result.detail}; ${noted}`, ...(result.status === 'requires-remote' && !result.code ? { code: 'PREGATE_NO_POLICY' } : {}) };
  return { ...result, status: 'warn', code: 'PREGATE_NO_POLICY', lines, detail: `${result.detail}; ${noted}`, fix: `review the starter above, write it with gstack-pregate init, edit each TODO, then commit ${PREGATE_CONFIG_PATH} on the base branch; from then on an unmapped file is PREGATE_NO_LANE` };
}

async function run(ctx: PregateContext): Promise<CheckResult> {
  const sel = selectLanes(ctx);
  ctx.explain.push(...sel.provenance);
  for (const [lane, set] of Object.entries(sel.laneSets)) ctx.explain.push(`lane ${lane}: ${set === '?' ? 'file set unknown' : `${set.length} files`}`);
  const inputs = baseInputs(ctx, { selection: sha256(sel.tests.join('\n')), localTests: sha256(sel.localTests.join('\n')), remote: sha256(sel.remote.map(r => `${r.lane}:${r.tests.join(',')}`).join('\n')) });
  const noPolicy = sel.noLane.length > 0 && ctx.configKind === 'none';
  const base: CheckResult = { id: 'lanes', stage: 'tests', status: 'pass', inputs, lines: describe(sel, noPolicy), remote: sel.remote };
  const lost = new Set(sel.removed.flatMap(r => r.lostCoverage)).size;
  const removedNote = sel.removed.length ? `${sel.removed.length} removed path(s)${lost ? `; ${lost} subject(s) lost their last test` : ''}` : '';
  const withRemoved = (r: CheckResult): CheckResult => (removedNote ? { ...r, detail: r.detail ? `${r.detail}; ${removedNote}` : removedNote } : r);
  if (sel.noLane.length && !noPolicy) {
    return withRemoved({ ...base, status: 'fail', cause: 'diff', code: 'PREGATE_NO_LANE', detail: `${sel.noLane.length} touched file(s) with no test lane: ${sel.noLane.join(' ')}`, fix: noLaneFix(ctx, sel.noLane) });
  }
  const result = withRemoved(await runSelected(ctx, sel, base));
  return noPolicy ? withStarter(ctx, sel, result) : result;
}

/**
 * The fix line for PREGATE_NO_LANE. When the branch edits `.gstack/pregate.json`
 * while the policy comes from elsewhere (the base copy, or the user-owned file),
 * a lane the branch adds does not count yet, and saying "declare its lane" again
 * sends the author round in a circle. That is the trust boundary working (a
 * branch cannot loosen its own gate), so the line says so and names the two
 * routes; it never switches to the head policy on its own.
 */
function noLaneFix(ctx: PregateContext, noLane: readonly string[]): string {
  const device = noLane.some(isDeviceDart) ? `; pregate does not run device tests, so declare "**/integration_test/**": [] (and "**/test_driver/**": []) on ${ctx.base} and let CI run them` : '';
  const fix = `add a test that names the file, or declare its lane (or []) under dependencies — or empty_lanes for other documentation — in ${ctx.configFile}${device}`;
  if (ctx.configKind === 'head' || !ctx.touched.some(t => t.path === PREGATE_CONFIG_PATH && t.status !== 'D')) return fix;
  return `this branch edits ${PREGATE_CONFIG_PATH}, but the policy comes from ${ctx.configLabel} so a branch cannot loosen its own gate, and a lane it adds counts only once it is on ${ctx.base}: land the policy change in its own PR first, or rerun with --policy-from head --allow-repo-commands (gstack-ship-preflight forwards it; a head policy may only add test lanes, and a [] declaration must land on ${ctx.base} first), which records the run as policy head (unreviewed); otherwise ${fix}`;
}

export const lanesCheck: CheckDef = { id: 'lanes', stage: 'tests', tier: 1, downgradable: true, needsRepoCommands: true, run };

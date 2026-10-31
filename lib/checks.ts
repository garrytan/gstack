/**
 * gstack-checks: the inner build-and-verify loop behind /verify (GST-116).
 *
 * detect: the repo's non-test checks (a CLAUDE.md gstack:verify: line, else its
 * Health Stack section, else manifests). Read-only.
 * run: those checks plus the tests pregate's own selector picks, run locally
 * under pregate's supervision. Tests come from lib/pregate only: there is no
 * second selector, so a /verify selection is the pregate selection. It never
 * writes .gstack/tmp/pregate.json or clears an obligation.
 * Consent: run executes nothing until the exact command set (checks, the pregate
 * runner and every selection manifest command) is trusted for this repo, or the
 * caller passes --allow-repo-commands.
 * status: reads the last run's ledger; READY_FOR_SHIP only when every check
 * passed at the current tree and command set. It runs nothing.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { slugFromEnvironment } from './bin-context';
import { resolveStateRoot } from './state-root';
import { wtreeFingerprint } from './script-invocation';
import type { PregateConfig } from './pregate/config';
import { buildContext, defaultUserConfigPath, describeRefusal, withFingerprint } from './pregate/context';
import { selectLanes } from './pregate/lane-selection';
import { lanesCheck } from './pregate/checks/lanes';
import { classifyCommandEnvironment } from './pregate/environment';
import { readRange, supervise } from './pregate/supervise';
import type { CheckResult, PregateContext } from './pregate/types';
import { resolveBaseBranch } from './ship-policy';

/** body: the package.json script behind a '<pm> run x' command, shown by detect; trust hashes the whole scripts map. */
export interface Check { name: string; command: string; source: string; body?: string }
export type Verdict = 'PASS' | 'FAIL' | 'ZERO_RUN' | 'UNMAPPED' | 'TOO_BROAD' | 'ENV' | 'TIMEOUT' | 'INCOMPLETE';
export interface Outcome { name: string; verdict: Verdict; ms: number; detail: string; lines: string[]; log?: string; notCovered?: string[] }
/** basis: the base commit and policy the selection was made against, so a moved base or changed policy is not READY. */
export interface Ledger { tree: string; set: string; basis: string; at: string; results: Array<Pick<Outcome, 'name' | 'verdict'>>; notCovered: string[] }

export const TESTS = 'tests';
export const MAX_LOCAL_TESTS = 300;
export const MAX_FAIL_LINES = 40;

const read = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The gstack:verify: declaration, parsed as bin/gstack-verify-gate's sed does (first line, -->, backticks and trailing space dropped). */
export function declaredVerify(claudeMd: string): string | null {
  for (const line of claudeMd.split('\n')) {
    const m = /^[ \t\r\f\v]*(?:<!--[ \t\r\f\v]*)?gstack:verify:[ \t\r\f\v]*(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[1].split('-->')[0].replace(/`/g, '').replace(/\s+$/, '');
    return cmd || null;
  }
  return null;
}

/** The '## Health Stack' section (/health's own format): '- key: command' rows. 'test' and 'tests' are left to pregate; a repeated key gets -2, -3 so every check has its own name. */
export function healthStack(claudeMd: string): Check[] {
  const lines = claudeMd.split('\n');
  const start = lines.findIndex(l => /^##\s+Health Stack\s*$/.test(l));
  if (start < 0) return [];
  const checks: Check[] = [];
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const m = /^\s*[-*]\s*([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (!m || ['test', TESTS].includes(m[1].toLowerCase())) continue;
    const key = m[1].toLowerCase();
    let n = seen.get(key) ?? 0;
    let name = key;
    while (taken.has(name)) name = `${key}-${++n + 1}`;
    seen.set(key, n);
    taken.add(name);
    checks.push({ name, command: m[2].replace(/`/g, ''), source: 'CLAUDE.md Health Stack' });
  }
  return checks;
}

function packageManager(root: string): { run: string; exec: string } {
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) return { run: 'bun run', exec: 'bunx' };
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return { run: 'pnpm run', exec: 'pnpm exec' };
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return { run: 'yarn run', exec: 'yarn' };
  return { run: 'npm run', exec: 'npx' };
}

/** Checks the manifests declare. Never invents a command: a tool is used only when the project declares it. */
export function manifestChecks(root: string): Check[] {
  const checks: Check[] = [];
  const pkgText = read(path.join(root, 'package.json'));
  if (pkgText) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try { pkg = JSON.parse(pkgText); } catch { /* an unreadable package.json declares nothing */ }
    const scripts = pkg.scripts ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = packageManager(root);
    if (scripts.typecheck) checks.push({ name: 'typecheck', command: `${pm.run} typecheck`, source: 'package.json', body: scripts.typecheck });
    else if (deps.typescript && fs.existsSync(path.join(root, 'tsconfig.json'))) checks.push({ name: 'typecheck', command: `${pm.exec} tsc --noEmit`, source: 'tsconfig.json' });
    if (scripts.lint) checks.push({ name: 'lint', command: `${pm.run} lint`, source: 'package.json', body: scripts.lint });
    else if (deps['@biomejs/biome'] && ['biome.json', 'biome.jsonc'].some(f => fs.existsSync(path.join(root, f)))) checks.push({ name: 'lint', command: `${pm.exec} biome check .`, source: 'biome.json' });
    else if (deps.eslint && fs.readdirSync(root).some(f => /^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\..+)?)$/.test(f))) checks.push({ name: 'lint', command: `${pm.exec} eslint .`, source: 'eslint config' });
    if (scripts.build) checks.push({ name: 'build', command: `${pm.run} build`, source: 'package.json', body: scripts.build });
  }
  const pyproject = read(path.join(root, 'pyproject.toml'));
  if (pyproject) {
    if (/\bruff\b/.test(pyproject)) checks.push({ name: 'lint', command: 'ruff check .', source: 'pyproject.toml' });
    if (/\bmypy\b/.test(pyproject)) checks.push({ name: 'typecheck', command: 'mypy .', source: 'pyproject.toml' });
  }
  const cargo = read(path.join(root, 'Cargo.toml'));
  if (cargo !== null) checks.push({ name: 'build', command: 'cargo check --all-targets', source: 'Cargo.toml' });
  if (cargo !== null && (/^\[(workspace\.)?lints\.clippy\]/m.test(cargo) || ['clippy.toml', '.clippy.toml'].some(f => fs.existsSync(path.join(root, f))))) checks.push({ name: 'lint', command: 'cargo clippy --all-targets', source: 'Cargo.toml' });
  if (fs.existsSync(path.join(root, 'go.mod'))) checks.push({ name: 'vet', command: 'go vet ./...', source: 'go.mod' }, { name: 'build', command: `go build -o ${process.platform === 'win32' ? 'NUL' : '/dev/null'} ./...`, source: 'go.mod' });
  const seen = new Set<string>();
  return checks.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

/** The non-test checks, in order of authority: a gstack:verify: declaration, a Health Stack section, the manifests. */
export function detectChecks(root: string): Check[] {
  const claude = read(path.join(root, 'CLAUDE.md')) ?? '';
  const declared = declaredVerify(claude);
  const stack = healthStack(claude);
  const checks = declared ? [{ name: 'verify', command: declared, source: 'CLAUDE.md gstack:verify:' }] : stack.length ? stack : manifestChecks(root);
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(read(path.join(root, 'package.json')) ?? '{}').scripts ?? {}; } catch { /* no scripts */ }
  return checks.map(c => {
    const script = /^(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)/.exec(c.command)?.[1];
    return c.body === undefined && script && scripts[script] ? { ...c, body: scripts[script] } : c;
  });
}

/** Every command a run could execute, read without executing any: the checks, the pregate runner and each selection manifest command. */
export function commandSet(root: string, checks: readonly Check[], config: Pick<PregateConfig, 'runner' | 'selection'>): string {
  return sha256(JSON.stringify({ checks: checks.map(c => [c.name, c.command, c.body ?? '']), scripts: packageScripts(root), runner: config.runner ?? detectedRunnerInputs(root), selection: Object.entries(config.selection ?? {}).sort(([a], [b]) => a.localeCompare(b)) }));
}

/** Every package.json script: a check or script can call any of them (npm run a && npm run b, yarn a, nested runs), so trust covers the whole map. */
function packageScripts(root: string): Array<[string, string]> {
  try { return Object.entries(JSON.parse(read(path.join(root, 'package.json')) ?? '{}').scripts ?? {}).map(([k, v]) => [k, String(v)] as [string, string]).sort(([a], [b]) => a.localeCompare(b)); } catch { return []; }
}

/** With no declared runner pregate picks one from lockfiles, bunfig.toml and test dependencies, so those are what trust covers. */
function detectedRunnerInputs(root: string): string[] {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(read(path.join(root, 'package.json')) ?? '{}'); } catch { /* none */ }
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(d => /^(vitest|jest|mocha|ava|@playwright\/test)$/.test(d)).sort();
  const markers = ['bun.lock', 'bun.lockb', 'bunfig.toml', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'].filter(f => fs.existsSync(path.join(root, f)));
  return ['detected', ...markers, ...deps];
}

const realRoot = (root: string) => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } };
export function trustStore(env: NodeJS.ProcessEnv = process.env): string { return path.join(resolveStateRoot(env), 'checks-trust'); }

function trustRows(store: string): Array<[string, string]> {
  return (read(store) ?? '').split('\n').filter(Boolean).map(l => l.split('\t') as [string, string]).filter(r => r.length === 2);
}

export function isTrusted(root: string, set: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = realRoot(root);
  return trustRows(trustStore(env)).some(([p, h]) => p === key && h === set);
}

/** Record root -> command-set hash (0600, atomic, one row per repo) and log the grant beside the verify-gate grants. */
export function recordTrust(root: string, set: string, checks: readonly Check[], config: Pick<PregateConfig, 'runner' | 'selection'>, env: NodeJS.ProcessEnv = process.env): void {
  const store = trustStore(env);
  const key = realRoot(root);
  fs.mkdirSync(path.dirname(store), { recursive: true });
  const rows = trustRows(store).filter(([p]) => p !== key).concat([[key, set]]);
  const tmp = `${store}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, rows.map(r => r.join('\t')).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, store);
  const sec = path.join(resolveStateRoot(env), 'security');
  fs.mkdirSync(sec, { recursive: true });
  const grant = { ts: new Date().toISOString(), root: key, set_sha256: set, checks: checks.map(c => c.command), runner: config.runner ?? 'detected', selection: config.selection ?? {}, tty: !!process.stdin.isTTY };
  fs.appendFileSync(path.join(sec, 'checks-trust-grants.jsonl'), JSON.stringify(grant) + '\n', { mode: 0o600 });
}

export function ledgerPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const state = resolveStateRoot(env);
  return path.join(state, 'projects', slugFromEnvironment(state, root), 'verify', sha256(realRoot(root)).slice(0, 12), 'last-run.json');
}

export function readLedger(file: string): Ledger | null {
  const text = read(file);
  if (!text) return null;
  try { return JSON.parse(text) as Ledger; } catch { return null; }
}

/** A pregate lanes result as a /verify verdict. Only a pass (or a pass whose platform lanes are owed remotely) is green. */
export function testVerdict(r: CheckResult): Pick<Outcome, 'verdict' | 'detail' | 'notCovered'> {
  const detail = r.detail ?? '';
  const notCovered = (r.remote ?? []).filter(o => !o.receipt).map(o => o.lane).sort();
  if (r.code === 'PREGATE_NO_LANE' || r.code === 'PREGATE_NO_POLICY') return { verdict: 'UNMAPPED', detail: `${detail} (no test covers a touched file: add one that does)` };
  if (r.cause === 'environment' || r.code === 'PREGATE_ENVIRONMENT') return { verdict: 'ENV', detail };
  if (r.code === 'PREGATE_STALLED' || (r.status === 'incomplete' && /timed out|timeout/i.test(detail))) return { verdict: 'TIMEOUT', detail };
  if (/^ZERO-RUN/.test(detail)) return { verdict: 'ZERO_RUN', detail };
  if (r.status === 'fail') return { verdict: 'FAIL', detail };
  if (r.status === 'pass' || (r.status === 'requires-remote' && !r.code)) return { verdict: 'PASS', detail, notCovered };
  return { verdict: 'INCOMPLETE', detail };
}

export interface RunOptions { root: string; only?: string[]; timeoutMs: number; env?: NodeJS.ProcessEnv }
export interface Loaded { ctx: PregateContext; checks: Check[]; set: string }
const basisOf = (ctx: PregateContext) => sha256(JSON.stringify([ctx.baseRef, ctx.baseSha, ctx.configLabel, ctx.configDigest ?? '']));

/** The pregate context /verify runs under: the base policy, tests local whatever the core count, no remote gate, quiet progress. */
export function load(root: string, base: string | undefined, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Loaded | { refused: string } {
  const b = resolveBaseBranch(root, base);
  const loaded = buildContext({ repoRoot: root, base: b, policyFrom: 'base', allowRepoCommands: true, timeoutMs, cores: Number.MAX_SAFE_INTEGER, testBackend: 'local', remote: null, userConfigPath: defaultUserConfigPath(root), env, progress: () => {} });
  if ('refused' in loaded) return { refused: describeRefusal(loaded.refused, b, 'gstack-checks').line };
  const checks = detectChecks(root);
  return { ctx: loaded.ctx, checks, set: commandSet(root, checks, loaded.ctx.config) };
}

async function runCommand(ctx: PregateContext, check: Check, dir: string, timeoutMs: number): Promise<Outcome> {
  const log = path.join(dir, `${check.name}.log`);
  fs.writeFileSync(log, '', { mode: 0o600 });
  const r = await supervise({ command: check.command, cwd: ctx.repoRoot, env: { ...ctx.env, CI: ctx.env.CI ?? '1' }, log, deadline: Date.now() + timeoutMs, stallMs: ctx.stallTimeoutMs, label: check.name, progress: () => {} });
  const output = readRange(log, r.start, r.end);
  const base = { name: check.name, ms: r.ms, log, lines: output.trim().split('\n').filter(Boolean).slice(-MAX_FAIL_LINES) };
  if (r.outcome === 'timeout' || r.outcome === 'stalled') return { ...base, verdict: 'TIMEOUT', detail: r.outcome === 'stalled' ? `no output for ${ctx.stallTimeoutMs / 1000} s` : `over ${timeoutMs / 1000} s` };
  if (r.outcome === 'spawn-failed') return { ...base, verdict: 'ENV', detail: r.error ?? 'could not start' };
  if (r.exit === 0) return { ...base, verdict: 'PASS', detail: 'exit 0', lines: [] };
  const env = classifyCommandEnvironment(check.command, output, r.exit, ctx.env);
  return env ? { ...base, verdict: 'ENV', detail: `${env.kind}: ${env.evidence}` } : { ...base, verdict: 'FAIL', detail: `exit ${r.exit}` };
}

async function runTests(ctx: PregateContext): Promise<Outcome> {
  const started = Date.now();
  const sel = selectLanes(ctx);
  if (sel.localTests.length > MAX_LOCAL_TESTS) return { name: TESTS, verdict: 'TOO_BROAD', ms: Date.now() - started, detail: `pregate selected ${sel.localTests.length} test files (over ${MAX_LOCAL_TESTS}); too broad for the inner loop, so /ship's pregate runs them`, lines: [] };
  const r = await withFingerprint(ctx, 'lanes', 'tests', () => lanesCheck.run(ctx));
  const v = testVerdict(r);
  return { name: TESTS, ms: Date.now() - started, ...v, lines: v.verdict === 'PASS' ? [] : (r.lines ?? []).slice(-MAX_FAIL_LINES) };
}

/** No declared check, no pregate policy and no test the no-policy selection finds: there is nothing to run, and nothing executes to find that out. */
export function nothingToRun(l: Loaded): boolean {
  return !l.checks.length && l.ctx.configKind === 'none' && !Object.keys(l.ctx.config.selection ?? {}).length && selectLanes(l.ctx).localTests.length === 0;
}

/** Run the checks (filtered by only) and the pregate-selected tests, then write the ledger. The caller has already checked consent. */
export async function runChecks(l: Loaded, o: RunOptions): Promise<{ outcomes: Outcome[]; ledger: Ledger }> {
  const want = (name: string) => !o.only?.length || o.only.includes(name);
  const file = ledgerPath(o.root, o.env);
  const dir = path.join(path.dirname(file), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const outcomes: Outcome[] = [];
  for (const check of l.checks) if (want(check.name)) outcomes.push(await runCommand(l.ctx, check, dir, o.timeoutMs));
  if (want(TESTS)) outcomes.push(await runTests(l.ctx));
  const after = wtreeFingerprint({ cwd: o.root, env: o.env });
  const moved = 'error' in after || after.tree !== l.ctx.wtree;
  const final = moved ? outcomes.map(x => (x.verdict === 'PASS' ? { ...x, verdict: 'INCOMPLETE' as Verdict, detail: 'the working tree changed during the run; rerun' } : x)) : outcomes;
  const prior = readLedger(file);
  const basis = basisOf(l.ctx);
  const same = !!prior && prior.tree === l.ctx.wtree && prior.set === l.set && prior.basis === basis;
  const keep = same ? prior!.results.filter(p => !final.some(f => f.name === p.name)) : [];
  const tests = final.find(f => f.name === TESTS);
  const ledger: Ledger = { tree: l.ctx.wtree, set: l.set, basis, at: new Date().toISOString(), results: [...keep, ...final.map(f => ({ name: f.name, verdict: f.verdict }))], notCovered: tests ? tests.notCovered ?? [] : same ? prior!.notCovered : [] };
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { outcomes: final, ledger };
}

/** READY_FOR_SHIP only when the ledger is for this tree and command set and every check and the tests passed. */
export function status(l: Loaded, ledger: Ledger | null): { ready: boolean; line: string } {
  const tree = l.ctx.wtree.slice(0, 12);
  const notReady = (why: string) => ({ ready: false, line: `NOT_READY tree=${tree}: ${why}` });
  if (!ledger) return notReady('no gstack-checks run recorded; run gstack-checks run');
  if (ledger.tree !== l.ctx.wtree) return notReady(`the last run was at ${ledger.tree.slice(0, 12)}; run gstack-checks run`);
  if (ledger.set !== l.set) return notReady('the check set changed since the last run; run gstack-checks run');
  if (ledger.basis !== basisOf(l.ctx)) return notReady(`the base or pregate policy changed since the last run (now ${l.ctx.configLabel}); run gstack-checks run`);
  const needed = [...l.checks.map(c => c.name), TESTS];
  const gaps = needed.map(n => [n, ledger.results.filter(r => r.name === n).map(r => r.verdict).find(v => v !== 'PASS') ?? (ledger.results.some(r => r.name === n) ? 'PASS' : 'not run')] as const).filter(([, v]) => v !== 'PASS');
  if (gaps.length) return notReady(gaps.map(([n, v]) => `${n}=${v}`).join(' '));
  return { ready: true, line: `READY_FOR_SHIP tree=${tree} checks=${needed.join(',')} not_covered=${ledger.notCovered.join(',') || 'none'}` };
}

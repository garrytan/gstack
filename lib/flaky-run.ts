/**
 * gstack-flaky run (GSTA-158): run a test command, read its JUnit, rerun once
 * when tests failed, and record flaky passes on a ledger. This is CREW rule 16
 * ("run the failed test again and note that it is flaky") for any runner that
 * writes JUnit, the per-test form of the free suite's GSTACK_FREE_RETRY_FLAKY.
 *
 * Rules (docs/flaky.md):
 * - A failed test gets one rerun when the runner made no retries of its own and
 *   at most maxReruns tests failed; more failures are a real red and nothing
 *   is rerun. When the runner retried (Playwright `retries` with retry-aware
 *   JUnit), its attempts stand and nothing is rerun again.
 * - The rerun repeats the whole command by default, and counts only on the
 *   runner's own full green verdict: exit 0, no failed test, every first-run
 *   test present, nothing counted outside the report. Only that verdict covers
 *   every reason a run can fail (a test it never reached, a coverage
 *   threshold, a fail-on-flaky policy).
 * - rerunScope 'test' (opt-in) reruns the failed test alone, and only with
 *   proof that the first run was complete: the runner's own summary, its
 *   test-failure exit status 1, no early stop, no coverage and no runner-flaky
 *   test; otherwise, and always for generic runners, the whole command reruns.
 * - A rerun makes a flaky pass only when its command exited 0 and the test ran
 *   exactly once and passed on its first attempt. The command is an argv run
 *   without a shell; a targeted rerun appends the adapter's selection, each one
 *   argv element.
 * - The JUnit file is removed before every attempt; a report that attempt did
 *   not write is missing. Missing, unreadable or empty JUnit is never green; a
 *   non-zero exit with no failed test and a runner killed by a signal are never
 *   green. When the runner's own summary counts failures or errors the JUnit
 *   omits (bun files that fail to load), the run is red and nothing is rerun.
 *   The first report is restored at the --junit path when the run ends; each
 *   rerun's report is kept beside it as <name>.rerun-<n>.xml.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn as spawnChild, spawnSync } from 'child_process';
import { finalAttempt, JunitError, readJunit, type JunitReport, type JunitRunner, type JunitTest } from './junit';
import { redactFindingSpans } from './redact-engine';
import { resolveStateRoot } from './state-root';

export type LedgerKind = 'flaky-pass' | 'rerun-fail';

export interface LedgerLine {
  ts: string;
  runner: 'junit';
  kind: LedgerKind;
  id: string;
  file: string;
  /** 'runner' when the runner's own retries decided, 'gstack-flaky' for our rerun. */
  rerun_by: 'runner' | 'gstack-flaky';
  /** For gstack-flaky reruns: the failed test alone, or the whole command when the first run could not be proven complete. */
  rerun_scope?: 'test' | 'command';
  attempts: string[];
  tree?: string;
  git_sha?: string;
  branch?: string;
  run_url?: string;
  excerpt: string[];
}

export interface RunOptions {
  command: string[];
  junit: string;
  runner?: JunitRunner;
  maxReruns: number;
  /** 'command' (default): rerun the whole command. 'test': rerun the failed test alone when the first run is proven complete. */
  rerunScope?: 'command' | 'test';
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Runs one attempt; resolves with its exit status and the tail of its combined output. */
  spawn?: (argv: string[], env: NodeJS.ProcessEnv, cwd: string) => Promise<Attempted>;
  now?: () => Date;
}

export interface TestOutcome {
  test: JunitTest;
  status: 'flaky-pass' | 'fail' | 'rerun-fail';
  attempts: string[];
  reason?: string;
}

export interface Attempted { exit: number; output: string; signal?: string }

export interface RunResult {
  exitCode: 0 | 1 | 3;
  code?: string;
  message?: string;
  tests: number;
  commandExit: number;
  outcomes: TestOutcome[];
  reruns: number;
  /** Why the rerun was the whole command (the default, or why a requested targeted rerun was refused); absent for targeted reruns. */
  wholeRerun?: string;
  ledger: LedgerLine[];
}

export const DEFAULT_MAX_RERUNS = 3;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Selection arguments a targeted rerun appends for one test, each one argv element. */
export function rerunSelection(runner: 'playwright' | 'bun', t: JunitTest): string[] {
  if (runner === 'bun') return [t.file, '--test-name-pattern', `^${escapeRegex(t.path.join(' '))}$`];
  const args = [escapeRegex(t.file), '--grep', `(?:^|\\s)${escapeRegex(t.path.join(' '))}(?:\\s|$)`];
  return t.project ? [...args, '--project', t.project] : args;
}

const OUTPUT_TAIL = 256 * 1024;

/** Set once gstack-flaky itself is asked to stop; every attempt after that counts as killed, whatever exit the runner chose. */
let cancelled: string | undefined;

/** Stream the child's output live (a quiet runner trips CI idle watchdogs) and keep its tail for reconciliation. */
function defaultSpawn(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Attempted> {
  return new Promise((resolve, reject) => {
    let tail = '';
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString('utf-8')).slice(-OUTPUT_TAIL); };
    const child = spawnChild(argv[0]!, argv.slice(1), { stdio: ['inherit', 'pipe', 'pipe'], env, cwd });
    const forward = (s: NodeJS.Signals) => { cancelled ??= s; child.kill(s); };
    const release = () => { process.off('SIGINT', forward); process.off('SIGTERM', forward); };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.stdout!.on('data', (c: Buffer) => { process.stdout.write(c); keep(c); });
    child.stderr!.on('data', (c: Buffer) => { process.stderr.write(c); keep(c); });
    child.on('error', e => { release(); reject(new JunitError('FLAKY_COMMAND_NOT_STARTED', `could not start ${argv[0]}: ${e.message}`)); });
    child.on('close', (code, signal) => {
      release();
      const killed = signal ?? cancelled;
      resolve({ exit: code ?? 128, output: tail, ...(killed ? { signal: killed } : {}) });
    });
  });
}

const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Failures a runner counted that its JUnit omits: bun leaves files that fail to
 * load out of the report ("N errors"), Playwright reports errors outside any
 * test. A rerun cannot clear those, so they keep the run red.
 */
export function unreportedFailures(runner: JunitRunner, output: string, reportedFailed: number): string | null {
  const text = plain(output);
  const last = (re: RegExp) => { const m = [...text.matchAll(re)].pop(); return m ? Number(m[1]) : 0; };
  if (runner === 'bun') {
    const errors = last(/^\s*(\d+) errors?\s*$/gm);
    const fails = last(/^\s*(\d+) fail\s*$/gm);
    if (errors > 0) return `bun reported ${errors} error(s) outside the JUnit report (a file failed to load or threw between tests)`;
    if (fails > reportedFailed) return `bun counted ${fails} failing tests, the JUnit report ${reportedFailed}`;
  }
  if (runner === 'playwright') {
    const outside = last(/(\d+) errors? (?:was|were) not a part of any test/g);
    const fails = last(/^\s*(\d+) failed\s*$/gm);
    if (outside > 0) return `Playwright reported ${outside} error(s) outside any test`;
    if (fails > reportedFailed) return `Playwright counted ${fails} failed tests, the JUnit report ${reportedFailed}`;
  }
  return null;
}

/**
 * Why the first run cannot be trusted to have run every test, so a rerun must
 * repeat the whole command; null when the runner's own output proves it
 * complete and its exit status explained by the failed tests alone. A run that
 * stopped early reports only the tests it reached, and a targeted rerun would
 * never run the rest; a coverage threshold or a fail-on-flaky policy fails the
 * run for a reason a narrowed rerun cannot reproduce.
 */
export function incompleteRun(runner: JunitRunner, output: string, exit: number, command: string[] = [], runnerFlaky = 0): string | null {
  if (runner === 'generic') return 'a generic runner cannot prove every test ran';
  if (exit !== 1) return `the command exited ${exit}, not the runner's test-failure status 1`;
  const text = plain(output);
  if (command.some(a => a === '--coverage' || a.startsWith('--coverage=')) || /%\s*Funcs\s*\|\s*%\s*Lines|coverage threshold/i.test(text)) return 'coverage is measured, and a narrowed rerun cannot reproduce a coverage failure';
  if (runnerFlaky) return `the runner retried ${runnerFlaky} flaky test(s), which a fail-on-flaky policy can fail the run on`;
  if (runner === 'bun') {
    if (/Bailed out after/.test(text)) return 'bun stopped early (--bail)';
    if (!/^\s*Ran \d+ tests? across \d+ files?/m.test(text)) return 'bun printed no run summary';
    return null;
  }
  const notRun = text.match(/\b(\d+) (did not run|interrupted)\b/);
  if (notRun) return `Playwright reports ${notRun[1]} ${notRun[2]}`;
  if (/Testing stopped early|Timed out waiting [\d.]+s for the (?:entire )?test run/.test(text)) return 'Playwright stopped early';
  if (!/^\s*\d+ failed\s*$/m.test(text)) return 'Playwright printed no summary (add a console reporter: --reporter=line,junit)';
  return null;
}

function git(args: string[], cwd: string): string | undefined {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

export function provenance(cwd: string, env: NodeJS.ProcessEnv): Pick<LedgerLine, 'tree' | 'git_sha' | 'branch' | 'run_url'> {
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}${env.GITHUB_RUN_ATTEMPT ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : ''}`
    : undefined;
  return {
    tree: git(['rev-parse', 'HEAD^{tree}'], cwd),
    git_sha: git(['rev-parse', 'HEAD'], cwd),
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    run_url: runUrl,
  };
}

/** Test ids and paths leave this process only through the redaction engine: a parameterized title can carry a credential. */
export function safeText(s: string): string {
  return redactFindingSpans(s) ?? '[withheld: the redaction scan could not run]';
}

/** Escape a value for a GitHub workflow command, so a test title cannot end the command or start another. */
export const workflowEscape = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** Failure text leaves this process only through the redaction engine; when it cannot scan, nothing leaves. */
export function safeExcerpt(lines: string[]): string[] {
  if (!lines.length) return [];
  const redacted = redactFindingSpans(lines.join('\n'));
  return redacted === null ? ['[excerpt withheld: the redaction scan could not run]'] : redacted.split('\n');
}

/** One attempt: remove the report, run, and read a report this attempt wrote. */
async function attempt(opts: RunOptions, argv: string[], cwd: string, env: NodeJS.ProcessEnv, runner = opts.runner): Promise<Attempted & { report?: JunitReport; error?: JunitError }> {
  const junit = path.resolve(cwd, opts.junit);
  fs.rmSync(junit, { force: true });
  const ran = await (opts.spawn ?? defaultSpawn)(argv, env, cwd);
  if (!fs.existsSync(junit)) return { ...ran, error: new JunitError('FLAKY_NO_RESULTS', `the command wrote no JUnit report at ${opts.junit} (exit ${ran.exit})`) };
  try { return { ...ran, report: readJunit(junit, runner) }; } catch (e) {
    if (e instanceof JunitError) return { ...ran, error: e };
    throw e;
  }
}

/**
 * What keeps a rerun from clearing anything even when it exited 0: failures
 * its runner counted outside the report and, for a whole-command rerun, any
 * failed test or any first-run test missing from its report.
 */
function rerunProblem(again: Attempted & { report?: JunitReport }, first: JunitReport, whole: boolean): string | undefined {
  if (!again.report) return undefined;
  const failedNow = again.report.tests.filter(x => finalAttempt(x) === 'fail');
  const unreported = unreportedFailures(first.runner, again.output, failedNow.length);
  if (unreported) return unreported;
  if (!whole) return undefined;
  if (failedNow.length) return `${failedNow.length} test(s) failed in the whole-command rerun`;
  const seen = new Set(again.report.tests.map(x => x.id));
  const missing = first.tests.filter(x => !seen.has(x.id)).length;
  return missing ? `${missing} test(s) of the first run are missing from the whole-command rerun` : undefined;
}

/** A rerun clears a test only when its command exited 0 and the test ran once and passed on its first attempt. */
function rerunVerdict(again: Attempted & { report?: JunitReport; error?: JunitError }, t: JunitTest, problem?: string): { status: 'flaky-pass' | 'rerun-fail'; attempts: string[]; reason?: string } {
  const match = again.report?.tests.find(x => x.id === t.id);
  if (!match) return { status: 'rerun-fail', attempts: [...t.attempts, 'fail'], reason: again.error ? `rerun: ${again.error.message}` : 'rerun: the report does not contain this test' };
  const attempts = [...t.attempts, ...match.attempts];
  if (again.signal) return { status: 'rerun-fail', attempts, reason: `rerun: killed by ${again.signal}` };
  if (again.exit !== 0) return { status: 'rerun-fail', attempts, reason: `rerun: the command exited ${again.exit}` };
  if (problem) return { status: 'rerun-fail', attempts, reason: `rerun: ${problem}` };
  if (match.executions !== 1 || match.attempts.join() !== 'pass') return { status: 'rerun-fail', attempts, reason: `rerun: the test did not pass once on its first attempt (${match.attempts.join(',')})` };
  return { status: 'flaky-pass', attempts };
}

export async function runFlaky(opts: RunOptions): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...(opts.env ?? process.env), PLAYWRIGHT_JUNIT_INCLUDE_RETRIES: '1' };
  const now = opts.now ?? (() => new Date());
  const empty = { tests: 0, outcomes: [], reruns: 0, ledger: [] };
  const first = await attempt(opts, opts.command, cwd, env);
  if (first.signal) return { exitCode: 3, code: 'FLAKY_COMMAND_KILLED', message: `the command was killed by ${first.signal}`, commandExit: first.exit, ...empty };
  if (!first.report) return { exitCode: 3, code: first.error!.code, message: first.error!.message, commandExit: first.exit, ...empty };
  const report = first.report;
  if (report.retriesHidden) {
    return { exitCode: 3, code: 'FLAKY_RETRIES_HIDDEN', commandExit: first.exit, ...empty, tests: report.tests.length,
      message: 'Playwright retried but its JUnit omits the retries; set PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1 (gstack-flaky run sets it for the command it starts)' };
  }
  const failed = report.tests.filter(t => finalAttempt(t) === 'fail');
  const runnerFlaky = report.tests.filter(t => finalAttempt(t) !== 'fail' && t.attempts.includes('fail'));
  if (first.exit !== 0 && failed.length === 0) {
    return { exitCode: 3, code: 'FLAKY_COMMAND_FAILED', commandExit: first.exit, ...empty, tests: report.tests.length,
      message: `the command exited ${first.exit} but its JUnit reports no failed test; a crash or a non-test step failed` };
  }
  const unreported = unreportedFailures(report.runner, first.output, failed.length);
  if (unreported) {
    return { exitCode: 1, code: 'FLAKY_UNREPORTED_FAILURES', commandExit: first.exit, ...empty, tests: report.tests.length,
      outcomes: failed.map(t => ({ test: t, status: 'fail' as const, attempts: t.attempts, reason: 'not rerun: the runner reported failures outside the JUnit report' })),
      message: `${unreported}; nothing was rerun` };
  }
  const prov = provenance(cwd, env);
  const line = (t: JunitTest, kind: LedgerKind, by: LedgerLine['rerun_by'], attempts: string[], scope?: LedgerLine['rerun_scope']): LedgerLine =>
    ({ ts: now().toISOString(), runner: 'junit', kind, id: safeText(t.id), file: safeText(t.file), rerun_by: by, ...(scope ? { rerun_scope: scope } : {}), attempts, ...prov, excerpt: safeExcerpt(t.excerpt) });
  const ledger: LedgerLine[] = runnerFlaky.map(t => line(t, 'flaky-pass', 'runner', t.attempts));
  const outcomes: TestOutcome[] = runnerFlaky.map(t => ({ test: t, status: 'flaky-pass' as const, attempts: t.attempts }));
  const eligible: JunitTest[] = [];
  for (const t of failed) {
    if (t.executions > 1) outcomes.push({ test: t, status: 'fail', attempts: t.attempts, reason: `it ran ${t.executions} times in this report and one failed; not rerun` });
    else if (t.attempts.length > 1) outcomes.push({ test: t, status: 'fail', attempts: t.attempts, reason: `the runner already retried (${t.attempts.length} attempts)` });
    else if (failed.length > opts.maxReruns) outcomes.push({ test: t, status: 'fail', attempts: t.attempts, reason: `${failed.length} tests failed, more than --max-reruns ${opts.maxReruns}; not rerun` });
    else eligible.push(t);
  }
  const wholeRerun = !eligible.length ? undefined
    : opts.rerunScope !== 'test' ? 'the default; --rerun-scope test reruns the failed test alone'
    : incompleteRun(report.runner, first.output, first.exit, opts.command, runnerFlaky.length) ?? undefined;
  const junit = path.resolve(cwd, opts.junit);
  const firstXml = fs.readFileSync(junit);
  let reruns = 0;
  const rerun = async (argv: string[]) => {
    reruns++;
    const again = await attempt(opts, argv, cwd, env, report.runner);
    if (fs.existsSync(junit)) fs.renameSync(junit, `${junit.replace(/\.xml$/i, '')}.rerun-${reruns}.xml`);
    return again;
  };
  const record = (t: JunitTest, v: ReturnType<typeof rerunVerdict>, scope: 'test' | 'command') => {
    outcomes.push({ test: t, status: v.status, attempts: v.attempts, ...(v.reason ? { reason: v.reason } : {}) });
    ledger.push(line(t, v.status, 'gstack-flaky', v.attempts, scope));
  };
  try {
    if (wholeRerun && outcomes.some(o => o.status === 'fail')) {
      for (const t of eligible) outcomes.push({ test: t, status: 'fail', attempts: t.attempts, reason: `not rerun: the run is already red, and a rerun would repeat the whole command (${wholeRerun})` });
    } else if (wholeRerun) {
      const again = await rerun(opts.command);
      const problem = rerunProblem(again, report, true);
      for (const t of eligible) record(t, rerunVerdict(again, t, problem), 'command');
    } else if (eligible.length) {
      let interrupted = false;
      for (const t of eligible) {
        if (interrupted) { outcomes.push({ test: t, status: 'fail', attempts: t.attempts, reason: 'not rerun: an earlier rerun was killed' }); continue; }
        const again = await rerun([...opts.command, ...rerunSelection(report.runner as 'playwright' | 'bun', t)]);
        interrupted = !!again.signal;
        record(t, rerunVerdict(again, t, rerunProblem(again, report, false)), 'test');
      }
    }
  } finally {
    if (reruns) fs.writeFileSync(junit, firstXml);
  }
  const red = outcomes.some(o => o.status !== 'flaky-pass');
  return { exitCode: red ? 1 : 0, tests: report.tests.length, commandExit: first.exit, outcomes, reruns, ...(wholeRerun && reruns ? { wholeRerun } : {}), ledger };
}

export function ledgerPath(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (flag) return flag;
  if (env.GSTACK_FLAKE_LEDGER_JUNIT) return env.GSTACK_FLAKE_LEDGER_JUNIT;
  return path.join(resolveStateRoot(env), 'flake-ledger-junit.jsonl');
}

/** Append ledger lines; an I/O error is a warning and never changes the verdict. */
export function appendLedger(lines: LedgerLine[], file: string, warn: (s: string) => void): void {
  if (!lines.length) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  } catch (e) {
    warn(`FLAKY_LEDGER_WRITE_FAILED: could not append ${file} (${(e as Error).message}); the verdict is unaffected`);
  }
}

/** Lines the bin prints: one per non-passing test, then the result line. */
export function renderResult(r: RunResult, ledger: string): string[] {
  const out: string[] = [];
  for (const o of r.outcomes) out.push(`FLAKY: ${o.status} ${safeText(o.test.id)} attempts=${o.attempts.join(',')}${o.reason ? ` (${o.reason})` : ''}`);
  const flaky = r.outcomes.filter(o => o.status === 'flaky-pass').length;
  const failed = r.outcomes.length - flaky;
  if (r.wholeRerun) out.push(`FLAKY_RERUN: scope=command (${r.wholeRerun})`);
  out.push(`FLAKY_RESULT: tests=${r.tests} failed=${failed} flaky=${flaky} reruns=${r.reruns} command_exit=${r.commandExit} verdict=${r.exitCode === 0 ? 'pass' : 'fail'} ledger=${r.ledger.length ? ledger : 'none'}`);
  return out;
}

/** A GitHub step summary for the flaky passes, so they are seen before any report reads the ledger. */
export function stepSummary(r: RunResult): string {
  const rows = r.outcomes.filter(o => o.status === 'flaky-pass');
  if (!rows.length) return '';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/`/g, "'").replace(/[\r\n]+/g, ' ');
  return ['### Flaky passes (gstack-flaky)', '', '| Test | Attempts | First error |', '|---|---|---|',
    ...rows.map(o => `| \`${cell(safeText(o.test.id))}\` | ${o.attempts.join(', ')} | ${cell(safeExcerpt(o.test.excerpt)[0] ?? '')} |`), ''].join('\n');
}

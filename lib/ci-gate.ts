import { spawnSync } from 'node:child_process';
import { MIN_POLL_MS, pollDelayMs, syncLimitEnv, withRateLimit } from './gh-poll';

export type CiVerdict = 'PASS' | 'FAIL' | 'PENDING' | 'NO_CHECKS' | 'ERROR';
export const CI_GATE_EXIT: Record<CiVerdict, number> = { PASS: 0, FAIL: 1, PENDING: 2, NO_CHECKS: 3, ERROR: 4 };
export const MIN_GH_VERSION = '2.50.0';

export interface GhResult { status: number | null; stdout: string; stderr: string; error?: string }
export type GhRunner = (args: string[]) => GhResult;

export interface CiGateOptions {
  repo: string;
  pr: string;
  expectHead: string;
  excludes: string[];
  overrideHead?: string;
  waitSeconds: number;
  intervalSeconds: number;
  registrationWaitSeconds: number;
}

export interface CiGateResult { verdict: CiVerdict; sha: string; lines: string[] }

type Required = 'y' | 'n' | '?';
type Klass = 'pass' | 'pending' | 'fail';
interface Row { name: string; bucket: string; link: string; required: Required }
type ChecksRead =
  | { kind: 'rows'; rows: { name: string; bucket: string; link: string }[] }
  | { kind: 'none' }
  | { kind: 'none-required' }
  | { kind: 'error'; cause: string; stderr: string };

const PASS_BUCKETS = new Set(['pass', 'skipping', 'neutral']);
const HEAD_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RANK: Record<Klass, number> = { pass: 0, pending: 1, fail: 2 };

export const CI_GATE_USAGE = `gstack-ci-gate --repo OWNER/NAME --pr NUMBER --expect-head SHA [options]

Decides whether a pull request's CI allows a merge of exactly SHA. Reads the
PR head, gates on every check (required ones and all others), and re-reads the
head afterwards; a moved head is ERROR.

Output (stdout), always first:
  VERDICT <PASS|FAIL|PENDING|NO_CHECKS|ERROR> <sha>
then one line per non-passing check:
  CHECK<TAB>name<TAB>bucket<TAB>required=y|n|?<TAB>link[<TAB>excluded|override-refused]
then NOTE / HEAD / CAUSE / STDERR / FIX lines. Act on the VERDICT line, not the exit code.

Exit codes: 0 PASS, 1 FAIL, 2 PENDING, 3 NO_CHECKS, 4 ERROR.

Buckets: pass, skipping and neutral pass; pending waits; fail, cancel and any
unknown bucket fail; a missing bucket field is ERROR (needs gh >= ${MIN_GH_VERSION}).

Options:
  --exclude NAME          drop one named non-required check from the verdict
                          (repeatable; needs --override-head; required checks
                          and checks of unknown required status are never dropped)
  --override-head SHA     head the exclusions were approved for; must equal
                          --expect-head
  --wait SECONDS          keep polling while PENDING, up to SECONDS (default 0)
  --interval SECONDS      poll interval (default and minimum 60, plus jitter;
                          a smaller value is raised to 60)
  --registration-wait S   when no check exists yet, re-poll up to S seconds
                          before reporting NO_CHECKS (default 0; use 60 right
                          after a push, when checks may not be registered yet)
  A GitHub rate limit waits for its reset, never retries at once (GST-1713).
  --help                  show this help`;

export function bucketClass(bucket: string): Klass {
  if (PASS_BUCKETS.has(bucket)) return 'pass';
  return bucket === 'pending' ? 'pending' : 'fail';
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}

export function parseChecks(result: GhResult): ChecksRead {
  if (result.error) return { kind: 'error', cause: result.error, stderr: lastLine(result.stderr) };
  const text = result.stdout.trim();
  if (text) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      return { kind: 'error', cause: 'gh pr checks printed output that is not JSON', stderr: lastLine(result.stderr) };
    }
    if (!Array.isArray(parsed)) return { kind: 'error', cause: 'gh pr checks JSON is not a list', stderr: lastLine(result.stderr) };
    const rows = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || typeof (item as { name?: unknown }).name !== 'string') {
        return { kind: 'error', cause: 'gh pr checks returned a check without a name', stderr: lastLine(result.stderr) };
      }
      const { name, bucket, link } = item as { name: string; bucket?: unknown; link?: unknown };
      if (typeof bucket !== 'string') {
        return { kind: 'error', cause: `gh pr checks returned no bucket field for "${name}"`, stderr: lastLine(result.stderr) };
      }
      rows.push({ name, bucket, link: typeof link === 'string' ? link : '' });
    }
    return { kind: 'rows', rows };
  }
  if (result.status === 0) return { kind: 'rows', rows: [] };
  if (/no required checks reported/.test(result.stderr)) return { kind: 'none-required' };
  if (/no checks reported/.test(result.stderr)) return { kind: 'none' };
  return { kind: 'error', cause: `gh pr checks exited ${result.status ?? 'abnormally'}`, stderr: lastLine(result.stderr) };
}

interface Evaluation { verdict: Exclude<CiVerdict, 'ERROR'>; lines: string[] }
type EvalOrError = Evaluation | { verdict: 'ERROR'; cause: string; stderr: string };

export function evaluateChecks(required: GhResult, all: GhResult, excludes: string[]): EvalOrError {
  const allRead = parseChecks(all);
  if (allRead.kind === 'error') return { verdict: 'ERROR', cause: allRead.cause, stderr: allRead.stderr };
  if (allRead.kind === 'none-required') return { verdict: 'ERROR', cause: 'gh pr checks without --required reported no required checks', stderr: '' };
  const reqRead = parseChecks(required);
  const notes: string[] = [];
  const requiredKnown = reqRead.kind === 'rows' || reqRead.kind === 'none-required';
  if (reqRead.kind === 'error') {
    notes.push(`NOTE required-check metadata unavailable (${reqRead.stderr || reqRead.cause}); gating on all checks, overrides refused`);
  } else if (reqRead.kind === 'none' && allRead.kind === 'rows' && allRead.rows.length > 0) {
    notes.push('NOTE checks registered while they were being read; required status unknown, overrides refused');
  }
  const requiredRows = reqRead.kind === 'rows' ? reqRead.rows : [];
  const requiredNames = new Set(requiredRows.map(row => row.name));
  if (requiredKnown && requiredNames.size === 0) notes.push('NOTE no required checks configured; gating on all checks');
  const rows = new Map<string, Row>();
  const observe = (obs: { name: string; bucket: string; link: string }) => {
    const required: Required = !requiredKnown ? '?' : requiredNames.has(obs.name) ? 'y' : 'n';
    const prior = rows.get(obs.name);
    if (!prior || RANK[bucketClass(obs.bucket)] > RANK[bucketClass(prior.bucket)]) rows.set(obs.name, { ...obs, required });
  };
  for (const obs of allRead.kind === 'rows' ? allRead.rows : []) observe(obs);
  for (const obs of requiredRows) observe(obs);
  if (rows.size === 0) return { verdict: 'NO_CHECKS', lines: notes.filter(n => !n.includes('no required checks')) };

  const excluded = new Set<string>();
  const lines: string[] = [];
  for (const name of excludes) {
    const row = rows.get(name);
    if (!row) notes.push(`NOTE override for unknown check "${name}" ignored`);
    else if (row.required === 'n') excluded.add(name);
  }
  let worst: Klass = 'pass';
  for (const row of [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const klass = bucketClass(row.bucket);
    const isExcluded = excluded.has(row.name);
    if (!isExcluded && RANK[klass] > RANK[worst]) worst = klass;
    if (klass === 'pass') continue;
    const marker = isExcluded ? '\texcluded' : excludes.includes(row.name) ? '\toverride-refused' : '';
    lines.push(`CHECK\t${row.name}\t${row.bucket}\trequired=${row.required}\t${row.link}${marker}`);
  }
  const verdict = worst === 'fail' ? 'FAIL' : worst === 'pending' ? 'PENDING' : 'PASS';
  return { verdict, lines: [...lines, ...notes] };
}

function readHead(gh: GhRunner, opts: CiGateOptions): { head: string } | { cause: string; stderr: string } {
  const result = gh(['pr', 'view', opts.pr, '--repo', opts.repo, '--json', 'headRefOid', '--jq', '.headRefOid']);
  if (result.error) return { cause: result.error, stderr: lastLine(result.stderr) };
  const head = result.stdout.trim();
  if (result.status !== 0 || !HEAD_RE.test(head)) {
    return { cause: `gh pr view could not read the PR head (exit ${result.status ?? 'abnormal'})`, stderr: lastLine(result.stderr) };
  }
  return { head };
}

function errorLines(cause: string, stderr: string): string[] {
  return [
    `CAUSE ${cause}`,
    ...(stderr ? [`STDERR ${stderr}`] : []),
    `FIX check \`gh auth status\`; gstack-ci-gate needs gh >= ${MIN_GH_VERSION} (\`gh --version\`)`,
  ];
}

function evaluateOnce(gh: GhRunner, opts: CiGateOptions): CiGateResult {
  const fail = (lines: string[]): CiGateResult => ({ verdict: 'ERROR', sha: opts.expectHead, lines });
  const before = readHead(gh, opts);
  if ('cause' in before) return fail(errorLines(before.cause, before.stderr));
  if (before.head !== opts.expectHead) {
    return fail([`HEAD ${before.head}`, 'CAUSE the PR head is not the approved head', 'FIX rerun /land-and-deploy from Step 1 for the new head']);
  }
  const checkArgs = ['pr', 'checks', opts.pr, '--repo', opts.repo];
  const fields = ['--json', 'name,state,bucket,link'];
  const required = gh([...checkArgs, '--required', ...fields]);
  const all = gh([...checkArgs, ...fields]);
  const after = readHead(gh, opts);
  if ('cause' in after) return fail(errorLines(after.cause, after.stderr));
  if (after.head !== before.head) {
    return fail([`HEAD ${after.head}`, 'CAUSE the PR head moved while checks were being read', 'FIX rerun /land-and-deploy from Step 1 for the new head']);
  }
  const evaluation = evaluateChecks(required, all, opts.excludes);
  if (evaluation.verdict === 'ERROR') return fail(errorLines(evaluation.cause, evaluation.stderr));
  return { verdict: evaluation.verdict, sha: opts.expectHead, lines: evaluation.lines };
}

function workflowsNote(gh: GhRunner, opts: CiGateOptions): string {
  const result = gh(['api', `repos/${opts.repo}/contents/.github/workflows?ref=${opts.expectHead}`, '--jq', 'length']);
  if (!result.error && result.status === 0 && /^\d+$/.test(result.stdout.trim())) {
    return Number(result.stdout.trim()) > 0 ? 'NOTE .github/workflows exists at this head' : 'NOTE .github/workflows is empty at this head';
  }
  if (/HTTP 404|Not Found/.test(result.stderr)) return 'NOTE .github/workflows does not exist at this head';
  return 'NOTE could not tell whether .github/workflows exists at this head';
}

export async function runCiGate(
  opts: CiGateOptions,
  gh: GhRunner,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => number = Date.now,
  random: () => number = Math.random,
): Promise<CiGateResult> {
  if (opts.excludes.length > 0 && opts.overrideHead !== opts.expectHead) {
    return {
      verdict: 'ERROR', sha: opts.expectHead,
      lines: ['CAUSE check overrides were not approved for this head', 'FIX approve overrides again in the readiness report for the current head'],
    };
  }
  const started = now();
  const elapsed = () => (now() - started) / 1000;
  const step = Math.max(opts.intervalSeconds, MIN_POLL_MS / 1000);
  let result = evaluateOnce(gh, opts);
  while (true) {
    const window = result.verdict === 'NO_CHECKS' ? opts.registrationWaitSeconds : result.verdict === 'PENDING' ? opts.waitSeconds : 0;
    if (elapsed() >= window) break;
    await sleep(pollDelayMs(step * 1000, random));
    result = evaluateOnce(gh, opts);
  }
  if (result.verdict === 'NO_CHECKS') {
    result.lines.push(`NOTE no CI ran on ${opts.expectHead} (looked for ${Math.round(elapsed())}s)`, workflowsNote(gh, opts));
  }
  if (result.verdict === 'PENDING' && opts.waitSeconds > 0) {
    result.lines.push(`NOTE still pending after waiting ${Math.round(elapsed())}s`);
  }
  return result;
}

export function parseCiGateArgs(argv: string[]): CiGateOptions | { help: true } | { error: string; expectHead?: string } {
  const opts: CiGateOptions = {
    repo: '', pr: '', expectHead: '', excludes: [], waitSeconds: 0, intervalSeconds: MIN_POLL_MS / 1000, registrationWaitSeconds: 0,
  };
  const seconds = (value: string | undefined, flag: string, positive = false): number | string => {
    if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return `${flag} needs a number of seconds`;
    const n = Number(value);
    return positive && n <= 0 ? `${flag} must be greater than 0` : n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--help' || flag === '-h') return { help: true };
    const take = (): string | undefined => { i++; return value; };
    switch (flag) {
      case '--repo': opts.repo = take() ?? ''; break;
      case '--pr': opts.pr = take() ?? ''; break;
      case '--expect-head': opts.expectHead = take() ?? ''; break;
      case '--override-head': opts.overrideHead = take() ?? ''; break;
      case '--exclude': {
        const name = take();
        if (!name) return { error: '--exclude needs a check name', expectHead: opts.expectHead };
        opts.excludes.push(name);
        break;
      }
      case '--wait': case '--interval': case '--registration-wait': {
        const parsed = seconds(take(), flag, flag === '--interval');
        if (typeof parsed === 'string') return { error: parsed, expectHead: opts.expectHead };
        if (flag === '--wait') opts.waitSeconds = parsed;
        else if (flag === '--interval') opts.intervalSeconds = parsed;
        else opts.registrationWaitSeconds = parsed;
        break;
      }
      default: return { error: `unknown argument ${flag}`, expectHead: opts.expectHead };
    }
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) return { error: '--repo OWNER/NAME is required', expectHead: opts.expectHead };
  if (!/^[1-9]\d*$/.test(opts.pr)) return { error: '--pr NUMBER is required', expectHead: opts.expectHead };
  if (!HEAD_RE.test(opts.expectHead)) return { error: '--expect-head needs a full commit SHA', expectHead: opts.expectHead };
  return opts;
}

/** gh as a GhRunner, with gh-poll's rate-limit rule: a rate-limited call sleeps until the reset instead of failing or retrying at once. */
export const spawnGh: GhRunner = withRateLimit(args => {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return { status: null, stdout: '', stderr: result.stderr ?? '', error: code === 'ENOENT' ? 'gh is not installed or not on PATH' : `gh failed to run (${code ?? result.error.message})` };
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}, syncLimitEnv);

export async function ciGateMain(argv: string[], gh: GhRunner = spawnGh, write: (text: string) => void = text => process.stdout.write(text)): Promise<number> {
  const parsed = parseCiGateArgs(argv);
  if ('help' in parsed) {
    write(`${CI_GATE_USAGE}\n`);
    return 0;
  }
  if ('error' in parsed) {
    write(`VERDICT ERROR ${parsed.expectHead || '-'}\nCAUSE ${parsed.error}\nFIX see gstack-ci-gate --help\n`);
    return CI_GATE_EXIT.ERROR;
  }
  const result = await runCiGate(parsed, gh);
  write([`VERDICT ${result.verdict} ${result.sha}`, ...result.lines].join('\n') + '\n');
  return CI_GATE_EXIT[result.verdict];
}

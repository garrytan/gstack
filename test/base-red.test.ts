/**
 * gstack-base-red (docs/ship-policy.md#base-red): a Step 5 failure is base-red
 * only when the base branch's policy declares how to reproduce it, every
 * failure is named, the PR touches none of the failing files or the paths
 * their signatures name, and the same test fails the same way at the base
 * head and at the PR head in scratch worktrees. A conditional receipt is
 * refused by every receipt consumer except /ship's own terminal line, which
 * reports SHIP_PAUSED; wait returns only once a new base head passes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyBaseRed, parseEvidence, pausePath, readPause, receiptBaseRed, shellRunner, waitBaseGreen, writePause, type FailureEvidence, type Runner } from '../lib/base-red';
import { EXIT } from '../lib/headless-artifacts';
import { bindReceipt, extractReceipt, placeReceiptFirst, receiptSummaryLine } from '../lib/ship-receipt';
import { BASE_RED_KEY_VERSION, validatePolicy, type BaseRedPolicy } from '../lib/ship-policy';

const ROOT = path.resolve(import.meta.dir, '..');
const ID = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const SELECT = 'for f in {files}; do bash "$f" || status=1; done; exit ${status:-0}';
const POLICY: BaseRedPolicy = { setup: null, select: SELECT, timeout_sec: 60 };
const FAIL_TEST = 'echo "(fail) totals add up"; echo "error: expected 3 got 4 in lib/sum.sh"; exit 1\n';
const PASS_TEST = 'echo "(pass) totals add up"\n';

let root = '';
let work = '';
let state = '';
const prevState = process.env.GSTACK_STATE_ROOT;
const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...ID } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), text); };
const policyJson = (base_red: BaseRedPolicy | null) => JSON.stringify({ base_red, min_gstack_version: base_red ? BASE_RED_KEY_VERSION : null }) + '\n';
const evidence = (over: Partial<FailureEvidence> = {}): FailureEvidence => ({ lane: 'tests', total: 1, failures: [{ id: 'totals add up', file: 't/sum.test.sh', signature: 'error: expected 3 got 4' }], ...over });
const counting = () => { const calls: string[] = []; const runner: Runner = (cwd, cmd, s) => { calls.push(cmd); return shellRunner(cwd, cmd, s); }; return { calls, runner }; };

/** origin/main carries a red test; the PR branch changes only README.md. */
function fixture(base: { test?: string; policy?: BaseRedPolicy | null } = {}) {
  write('t/sum.test.sh', base.test ?? FAIL_TEST);
  write('lib/sum.sh', 'echo 4\n');
  write('README.md', 'base\n');
  write('.gstack/ship-policy.json', policyJson(base.policy === undefined ? POLICY : base.policy));
  git('add', '-A'); git('commit', '-qm', 'base'); git('push', '-q', 'origin', 'HEAD:main'); git('fetch', '-q', 'origin');
  git('checkout', '-q', '-b', 'feat');
  write('README.md', 'pr\n'); git('commit', '-qam', 'pr: readme');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'base-red-'));
  work = path.join(root, 'work');
  state = path.join(root, 'state');
  process.env.GSTACK_STATE_ROOT = state;
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(root, 'origin.git')], { timeout: 30_000 });
  fs.mkdirSync(work);
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', path.join(root, 'origin.git'));
});
afterEach(() => {
  if (prevState === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prevState;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('classify', () => {
  test('a failure that reproduces at base and head in a file the PR does not touch is base-red, and leaves no worktree behind', () => {
    fixture();
    const r = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence(), policy: POLICY });
    expect(r.code).toBe('BASE_RED');
    expect(r.cases).toEqual([{ id: 'totals add up', file: 't/sum.test.sh', verdict: 'BASE_RED', reason: `fails the same way at base ${r.base_sha.slice(0, 12)}` }]);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    expect(fs.readdirSync(path.join(state, 'ship', 'base-red', 'worktrees'))).toEqual([]);
  });

  test('the PR touching the failing test, or a path its signature names, is in-branch without running anything', () => {
    fixture();
    write('t/sum.test.sh', FAIL_TEST + '# touched\n'); git('commit', '-qam', 'touch test');
    const a = counting();
    const touched = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence(), policy: POLICY, runner: a.runner });
    expect([touched.code, touched.cases[0]!.reason, a.calls]).toEqual(['IN_BRANCH', 'the PR changes t/sum.test.sh', []]);
    git('reset', '-q', '--hard', 'HEAD~1');
    write('lib/sum.sh', 'echo 5\n'); git('commit', '-qam', 'touch lib');
    const named = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence({ failures: [{ id: 'totals add up', file: 't/sum.test.sh', signature: 'error: expected 3 got 4 in lib/sum.sh' }] }), policy: POLICY, runner: a.runner });
    expect([named.code, named.cases[0]!.reason, a.calls]).toEqual(['IN_BRANCH', 'the PR changes lib/sum.sh', []]);
  });

  test('a test that passes on the base, or fails there with another signature, is in-branch', () => {
    fixture({ test: PASS_TEST });
    const passes = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence(), policy: POLICY });
    expect(passes.code).toBe('IN_BRANCH');
    expect(passes.cases[0]!.reason).toStartWith('passes at base ');
    const other = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence({ failures: [{ id: 'totals add up', file: 't/sum.test.sh', signature: 'error: timeout after 5000ms' }] }), policy: { ...POLICY, select: 'bash -c "echo totals add up; echo error: expected; exit 1" # {files}' } });
    expect([other.code, other.cases[0]!.reason.split(' at base')[0]]).toEqual(['IN_BRANCH', 'fails with a different signature']);
  });

  test('no base_red policy, an unnamed failure, or a failing setup keeps every failure in-branch', () => {
    fixture({ policy: null });
    expect(classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence(), policy: null }).code).toBe('BASE_RED_UNCONFIGURED');
    expect(classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence({ total: 2 }), policy: POLICY }).code).toBe('BASE_RED_UNNAMED');
    const setup = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence(), policy: { ...POLICY, setup: 'exit 7' } });
    expect([setup.code, setup.detail, setup.cases.every(c => c.verdict === 'IN_BRANCH')]).toEqual(['BASE_RED_REPRO_ERROR', 'setup exited 7', true]);
  });

  test('evidence must name the lane, the total and repo-relative files', () => {
    expect(parseEvidence({ lane: 'tests', total: 0, failures: [] })).toContain('total');
    expect(parseEvidence({ lane: 'tests', total: 1, failures: [{ id: 'x', file: '../escape.sh', signature: 's' }] })).toContain('repo-relative');
    expect(typeof parseEvidence(evidence())).toBe('object');
  });
});

describe('pause, receipt and wait', () => {
  test('the pause path hashes the branch; the receipt block from it is refused by default and bound only on request', () => {
    fixture();
    const ev = evidence();
    const r = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: ev, policy: POLICY });
    const { file } = writePause(work, 'feat/../../etc', r, ev, new Date('2026-10-29T00:00:00Z'));
    expect(file).toBe(pausePath(work, 'feat/../../etc'));
    expect(path.basename(file)).toMatch(/^[0-9a-f]{16}\.json$/);
    const pause = readPause(file);
    if (typeof pause === 'string') throw new Error(pause);
    expect(pause.expires_at).toBe('2026-10-30T00:00:00.000Z');
    const head = git('rev-parse', 'HEAD');
    const body = placeReceiptFirst('## Summary\n', { schema_version: 1, pr: 7, head, base: 'main', base_red: receiptBaseRed(pause) } as any);
    expect(extractReceipt(body).errors).toEqual([]);
    const refused = bindReceipt(body, '7', [head]);
    expect(refused.ok ? 'bound' : refused.code).toBe('QUEUE_RECEIPT_CONDITIONAL');
    expect(bindReceipt(body, '7', [head], { conditional: true }).ok).toBe(true);
  });

  test('the terminal line reports SHIP_PAUSED with status=incomplete, and carry refuses a conditional receipt', () => {
    fixture();
    const ev = evidence();
    fs.writeFileSync(path.join(root, 'ev.json'), JSON.stringify(ev));
    const bin = (name: string, args: string[]) => spawnSync('bun', [path.join(ROOT, 'bin', name), ...args], { cwd: work, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...ID, GSTACK_STATE_ROOT: state } });
    const c = bin('gstack-base-red', ['classify', '--failures', path.join(root, 'ev.json'), '--base', 'main', '--pause']);
    expect(c.status).toBe(EXIT.ok);
    const pauseLine = c.stdout.split('\n').find(l => l.startsWith('PAUSE: '))!;
    expect(c.stdout).toContain('BASE_RED_VERDICT: base-red lane=tests');
    const pause = readPause(pauseLine.slice(7));
    if (typeof pause === 'string') throw new Error(pause);
    const head = git('rev-parse', 'HEAD');
    const bodyFile = path.join(root, 'body.md');
    fs.writeFileSync(bodyFile, placeReceiptFirst('## Summary\n', { schema_version: 1, pr: 7, head, base: 'main', base_red: receiptBaseRed(pause) } as any));
    const res = bin('gstack-ship-receipt', ['result', '--body', bodyFile, '--head', head, '--out', path.join(root, 'run')]);
    expect(res.status).toBe(EXIT.fail);
    expect(res.stdout.trim()).toBe(`GSTACK_RESULT: skill=ship status=incomplete run=${path.join(root, 'run')}`);
    expect(res.stderr).toContain(`SHIP_PAUSED: base-red cases=1 base=${pause.base_sha.slice(0, 12)} lane=tests`);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'run', 'ship-run.json'), 'utf8')).status).toBe('incomplete');
    const carry = bin('gstack-ship-receipt', ['carry', '--body', bodyFile]);
    expect([carry.status, carry.stdout.split('\n')[0]]).toEqual([EXIT.refused, 'CARRY: refused (QUEUE_RECEIPT_CONDITIONAL)']);
  });

  test('wait skips a base move that still fails and returns on the first head that passes', () => {
    fixture();
    const ev = evidence();
    const r = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: ev, policy: POLICY });
    const pause = writePause(work, 'feat', r, ev).record;
    git('checkout', '-q', 'main');
    write('README.md', 'still red\n'); git('commit', '-qam', 'unrelated'); const stillRed = git('rev-parse', 'HEAD');
    write('t/sum.test.sh', PASS_TEST); git('commit', '-qam', 'fix'); const green = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', 'main');
    const heads = [pause.base_sha, stillRed, stillRed, green];
    let t = 0;
    const res = waitBaseGreen({ repoRoot: work, pause, policy: POLICY, timeoutSec: 600, pollSec: 5, lsRemote: () => heads.shift() ?? green, now: () => t, sleep: ms => { t += ms; } });
    expect(res).toEqual({ code: 'BASE_GREEN', sha: green, checked: 2 });
    const expired = waitBaseGreen({ repoRoot: work, pause: { ...pause, expires_at: '2000-01-01T00:00:00Z' }, policy: POLICY, timeoutSec: 60, pollSec: 5, lsRemote: () => green });
    expect(expired.code).toBe('BASE_RED_PAUSE_EXPIRED');
    let u = 0;
    const timeout = waitBaseGreen({ repoRoot: work, pause, policy: POLICY, timeoutSec: 30, pollSec: 5, lsRemote: () => pause.base_sha, now: () => u, sleep: ms => { u += ms; } });
    expect([timeout.code, timeout.checked]).toEqual(['BASE_RED_WAIT_TIMEOUT', 0]);
  });
});

describe('policy', () => {
  test('base_red needs {files} in select, bounded timeout, no unknown keys and the introducing min_gstack_version', () => {
    const codes = (base_red: unknown, min: string | null = BASE_RED_KEY_VERSION) => validatePolicy({ base_red, min_gstack_version: min }).map(e => `${e.code}@${e.path}`);
    expect(codes(POLICY)).toEqual([]);
    expect(codes({ ...POLICY, setup: 'bun install --frozen-lockfile' })).toEqual([]);
    expect(codes({ ...POLICY, select: 'bun test' })).toEqual(['POLICY_INVALID@base_red.select']);
    expect(codes({ ...POLICY, timeout_sec: 5 })).toEqual(['POLICY_INVALID@base_red.timeout_sec']);
    expect(codes({ ...POLICY, extra: 1 })).toEqual(['POLICY_INVALID@base_red.extra']);
    expect(codes({ ...POLICY, select: 'a {files}\nrm -rf /' })).toEqual(['POLICY_CONTAINMENT@base_red.select']);
    expect(codes(POLICY, null)).toEqual(['POLICY_INVALID@base_red']);
  });
});

describe('coverage audit additions', () => {
  // Generated by /ship Step 7 coverage audit (PR #3611).
  // Value: protects=a failure reproduced at base but not by the restricted run at the PR head stays in-branch, and one unreproduced case keeps the whole verdict in-branch;
  //   fails_when=the head reproduction or the every-case aggregation is dropped, so a PR that changes behaviour is paused as base-red; why_new=existing tests vary only the base run, with one case;
  //   seam=none; no_claim=real test runners (shell scripts stand in for the lane's tests)
  test('a case the head run does not reproduce, or a case the base output never names, keeps the verdict in-branch', () => {
    fixture();
    write('pr-only.txt', 'x\n'); git('add', '-A'); git('commit', '-qm', 'pr: marker');
    const headPasses = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence(), policy: { ...POLICY, select: `[ -f pr-only.txt ] && { echo "(pass) totals add up"; exit 0; }; ${SELECT}` } });
    expect([headPasses.code, headPasses.cases[0]!.reason]).toEqual(['IN_BRANCH', 'the restricted command passes at head']);
    const ghost = { id: 'ghost case', file: 't/sum.test.sh', signature: 'error: expected 3 got 4' };
    const mixed = classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: evidence({ total: 2, failures: [evidence().failures[0]!, ghost] }), policy: POLICY });
    expect(mixed.code).toBe('IN_BRANCH');
    expect(mixed.cases.map(c => c.verdict)).toEqual(['BASE_RED', 'IN_BRANCH']);
    expect(mixed.cases[1]!.reason).toStartWith('fails without naming this test at base ');
  });

  // Generated by /ship Step 7 coverage audit (PR #3611).
  // Value: protects=an unresolvable PR head is BASE_RED_REPRO_ERROR with every case in-branch and nothing run; fails_when=the commit-resolution guard is removed or inverted;
  //   why_new=no existing test resolves a missing commit; seam=none; no_claim=none beyond protects
  test('an unresolvable head is a reproduction error that runs nothing', () => {
    fixture();
    const a = counting();
    const r = classifyBaseRed({ repoRoot: work, base: 'main', head: 'no-such-ref', evidence: evidence(), policy: POLICY, runner: a.runner });
    expect([r.code, r.cases.every(c => c.verdict === 'IN_BRANCH'), a.calls]).toEqual(['BASE_RED_REPRO_ERROR', true, []]);
    expect([r.detail, r.cases[0]!.reason]).toEqual([`cannot resolve origin/main or no-such-ref`, 'unresolved commit']);
  });

  // Generated by /ship Step 7 coverage audit (PR #3611).
  // Value: protects=readPause rejects missing or non-pause files, and wait refuses BASE_RED_UNCONFIGURED once the base no longer declares base_red;
  //   fails_when=readPause accepts any JSON or wait polls without a usable base policy; why_new=existing tests read only valid pauses and never run the wait CLI;
  //   seam=none; no_claim=remote fetch over a network (local bare origin)
  test('readPause rejects non-pause files and the wait CLI refuses when the base declares no base_red', () => {
    fixture({ policy: null });
    const bogus = path.join(root, 'bogus.json');
    fs.writeFileSync(bogus, JSON.stringify({ kind: 'other', schema_version: 1, cases: [] }));
    expect(readPause(bogus)).toContain('is not a base-red pause record');
    expect(readPause(path.join(root, 'missing.json'))).toStartWith('cannot read ');
    const pauseFile = path.join(root, 'pause.json');
    fs.writeFileSync(pauseFile, JSON.stringify({ schema_version: 1, kind: 'base-red-pause', branch: 'feat', head: git('rev-parse', 'HEAD'), base: 'main', base_sha: git('rev-parse', 'origin/main'), lane: 'tests', cases: evidence().failures, created_at: '2026-10-29T00:00:00Z', expires_at: '2999-01-01T00:00:00Z' }));
    const w = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-base-red'), 'wait', '--pause', pauseFile, '--timeout', '30', '--poll', '5'], { cwd: work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...ID, GSTACK_STATE_ROOT: state } });
    expect(w.status).toBe(EXIT.refused);
    expect(w.stderr).toContain('BASE_RED_UNCONFIGURED');
  });

  // Generated by /ship Step 7 coverage audit (PR #3611), pass 2.
  // Value: protects=write --base-red adds the base_red block from a valid pause, and an unreadable or non-pause file exits usage with nothing written;
  //   fails_when=the flag is ignored, so an unconditional receipt is written for a paused run; why_new=no test runs write with --base-red;
  //   seam=none; no_claim=PR body upload via gh (local body file only)
  test('write --base-red makes the receipt conditional, and a bad pause file writes nothing', () => {
    fixture();
    const ev = evidence();
    const { file, record } = writePause(work, 'feat', classifyBaseRed({ repoRoot: work, base: 'main', head: 'HEAD', evidence: ev, policy: POLICY }), ev);
    const body = path.join(root, 'body.md');
    const run = (pause: string) => spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-ship-receipt'), 'write', '--pr', '7', '--base', 'main', '--session-kind', 'x', '--body', body, '--base-red', pause], { cwd: work, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...ID, GSTACK_STATE_ROOT: state } });
    for (const bad of [path.join(root, 'missing.json'), path.join(root, 'ev.json')]) {
      fs.writeFileSync(path.join(root, 'ev.json'), JSON.stringify(ev));
      fs.writeFileSync(body, 'prose\n');
      const r = run(bad);
      expect([r.status, r.stderr.includes('--base-red: '), r.stderr.includes('nothing written'), fs.readFileSync(body, 'utf8')]).toEqual([EXIT.usage, true, true, 'prose\n']);
    }
    const ok = run(file);
    expect(ok.status).toBe(EXIT.ok);
    const head = git('rev-parse', 'HEAD');
    const written = fs.readFileSync(body, 'utf8');
    expect(extractReceipt(written).receipt?.base_red).toEqual(receiptBaseRed(record));
    const bound = bindReceipt(written, '7', [head]);
    expect(bound.ok ? 'bound' : bound.code).toBe('QUEUE_RECEIPT_CONDITIONAL');
  });

  // Generated by /ship Step 7 coverage audit (PR #3611), pass 2.
  // Value: protects=the SHIP_RECEIPT summary line names base_red=<base12> for a conditional receipt and omits it otherwise; fails_when=the base_red part is dropped or printed unconditionally;
  //   why_new=summary-line tests cover carried_from only; seam=none; no_claim=none beyond protects
  test('the summary line names the red base only for a conditional receipt', () => {
    const base = 'c'.repeat(40);
    const plain = { schema_version: 1, head: 'a'.repeat(40), base: 'main' } as any;
    expect(receiptSummaryLine({ ...plain, base_red: { cases: ['x'], files: ['t/x.sh'], base, lane: 'tests', expires_at: '2026-10-30T00:00:00Z' } })).toContain(` base_red=${base.slice(0, 12)}`);
    expect(receiptSummaryLine(plain)).not.toContain('base_red=');
  });

  // Generated by /ship Step 7 coverage audit (PR #3611), pass 2.
  // Value: protects=classify exits usage on a missing --failures, an unreadable file or invalid evidence before any git fetch; fails_when=evidence checks move after the policy fetch or stop refusing;
  //   why_new=parseEvidence is unit-tested only, never through the CLI; seam=none; no_claim=none beyond protects (GIT_TRACE proves no fetch ran)
  test('classify refuses bad evidence with a usage exit before fetching anything', () => {
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const trace = path.join(root, 'git-trace.log');
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ lane: 'tests', total: 1, failures: [{ id: 'x', file: '/abs.sh', signature: 's' }] }));
    const cases: Array<[string[], string]> = [[[], '--failures <evidence.json> is required'], [['--failures', path.join(root, 'missing.json')], 'cannot read '], [['--failures', bad], 'must be repo-relative']];
    for (const [args, why] of cases) {
      const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-base-red'), 'classify', ...args], { cwd: work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...ID, GSTACK_STATE_ROOT: state, GIT_TRACE: trace } });
      expect([r.status, r.stderr.includes(why)]).toEqual([EXIT.usage, true]);
    }
    const traced = fs.readFileSync(trace, 'utf8');
    expect([traced.includes('rev-parse'), traced.includes('fetch')]).toEqual([true, false]);
  });
});

/**
 * INV-1 outside-review contract: classifyOutsideReview() separates execution,
 * findings and verdict; validateOutsideReview() and the two-argument CLI keep
 * their old shape for importers and installed skills that predate a re-render.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyOutsideReview, validateOutsideReview, type OutsideGate } from '../lib/outside-review-result';

const ROOT = path.resolve(import.meta.dir, '..');
const LIB = path.join(ROOT, 'lib', 'outside-review-result.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-review-result-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function file(content: string): string {
  const p = path.join(TMP, `f${n++}.txt`);
  fs.writeFileSync(p, content);
  return p;
}
function cli(args: string[]) {
  const r = spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const RECOMMEND = 'Recommendation: fix the guard because changed.ts loses data.';

describe('classifyOutsideReview: separate execution, findings and verdict', () => {
  const cases: Array<[string, { text: string; gate: OutsideGate; stderr?: string; exit?: number }, string, string | null, string | undefined]> = [
    ['clean review', { text: RECOMMEND, gate: 'review' }, 'clean', null, undefined],
    ['review with P1', { text: `[P1] data loss\n${RECOMMEND}`, gate: 'review' }, 'findings', 'P1', undefined],
    ['review with only P2', { text: `[P2] naming\n${RECOMMEND}`, gate: 'review' }, 'clean', 'P2', undefined],
    ['review missing recommendation', { text: 'A few observations.', gate: 'review' }, 'unavailable', null, 'missing_markers'],
    ['structured untagged prose', { text: 'The change looks reasonable overall.', gate: 'structured' }, 'unverified', null, 'untagged_review'],
    ['structured explicit clear', { text: 'NO_FINDINGS', gate: 'structured' }, 'clean', null, undefined],
    ['structured native P1 label', { text: 'P1: race in cleanup', gate: 'structured' }, 'findings', 'P1', undefined],
    ['spec passing score', { text: 'SCORE: 8\nAMBIGUITIES: NONE', gate: 'spec' }, 'clean', null, undefined],
    ['spec failing score', { text: 'SCORE: 4\nAMBIGUITIES: scope', gate: 'spec' }, 'findings', null, undefined],
    ['nonzero exit', { text: RECOMMEND, gate: 'review', exit: 1, stderr: '\nerror: 401 Unauthorized\n' }, 'unavailable', null, 'execution_failed'],
    ['timeout', { text: 'Partial', gate: 'review', exit: 124 }, 'unavailable', null, 'timeout'],
    ['empty', { text: ' \n', gate: 'structured' }, 'unavailable', null, 'empty_response'],
    ['refusal', { text: `I cannot review this request. ${RECOMMEND}`, gate: 'review' }, 'unavailable', null, 'review_refused'],
    ['consult answer without review markers', { text: 'Use a queue here; the writer pool blocks.', gate: 'execution', stderr: '' }, 'clean', null, undefined],
  ];
  for (const [label, input, verdict, highest, reason] of cases) {
    test(label, () => {
      const result = classifyOutsideReview(input);
      expect(result.verdict).toBe(verdict as any);
      expect(result.findings.highest).toBe(highest as any);
      expect(result.reason).toBe(reason as any);
      expect(result.execution.state).toBe(['execution_failed', 'timeout', 'empty_response', 'review_refused'].includes(reason ?? '') ? 'unavailable' : 'ran');
    });
  }

  test('a non-zero exit names the exit code and the first stderr line', () => {
    const result = classifyOutsideReview({ text: '', gate: 'review', exit: 1, stderr: '\nerror: 401 Unauthorized\nmore' });
    expect(result.detail).toBe('exit 1: error: 401 Unauthorized');
  });
});

describe('validateOutsideReview keeps the text-only shape for direct importers', () => {
  test('existing shapes are unchanged', () => {
    expect(validateOutsideReview('', 'review')).toEqual({ completed: false, reason: 'empty response' });
    expect(validateOutsideReview('I must refuse.', 'review')).toEqual({ completed: false, reason: 'review refused' });
    expect(validateOutsideReview('notes', 'review')).toEqual({ completed: false, reason: 'missing review completion recommendation' });
    expect(validateOutsideReview('notes', 'structured')).toEqual({ completed: false, reason: 'missing severity or explicit no-findings conclusion' });
    expect(validateOutsideReview('SCORE: 8', 'spec')).toEqual({ completed: false, reason: 'missing or invalid SCORE/AMBIGUITIES markers' });
    expect(validateOutsideReview('SCORE: 6\nAMBIGUITIES: NONE', 'spec')).toEqual({ completed: true, score: 6, gate: 'fail' });
    expect(validateOutsideReview(RECOMMEND, 'review')).toEqual({ completed: true });
    expect(validateOutsideReview('[P2] nit', 'structured')).toEqual({ completed: true, gate: 'pass' });
    expect(validateOutsideReview('[P1] bug', 'structured')).toEqual({ completed: true, gate: 'fail' });
  });

  test('B1b: the structured gate fails on P0 as well as P1', () => {
    for (const text of ['[P0] corrupts every row', 'P0: corrupts every row', '**P0:** corrupts every row', '[P3] nit\n[P0] corrupts every row']) {
      expect(validateOutsideReview(text, 'structured')).toEqual({ completed: true, gate: 'fail' });
    }
    expect(validateOutsideReview('[P2] naming\n[P3] nit', 'structured')).toEqual({ completed: true, gate: 'pass' });
  });
});

describe('outside-review-result CLI', () => {
  test('two-argument form keeps exit 0 completed / 1 unavailable / 2 usage, findings included', () => {
    expect(cli(['structured', file('[P1] data loss')]).status).toBe(0);
    expect(cli(['review', file(`[P0] data loss\n${RECOMMEND}`)]).status).toBe(0);
    const untagged = cli(['structured', file('looks fine')]);
    expect(untagged.status).toBe(1);
    expect(untagged.stderr).toBe('Outside review unavailable: missing severity or explicit no-findings conclusion; missing coverage.\n');
    expect(cli(['structured', path.join(TMP, 'missing-file')]).status).toBe(1);
    expect(cli(['bogus', file('x')]).status).toBe(2);
    expect(cli(['execution', file('x')]).status).toBe(2);
    expect(cli(['review']).status).toBe(2);
    // No VERDICT line: stale callers only read the status.
    expect(cli(['structured', file('[P1] data loss')]).stdout).toBe('');
  });

  test('verdict form prints VERDICT and exits 0 clean / 3 findings / 4 unverified / 1 unavailable', () => {
    const clean = cli(['--verdict', 'review', file(RECOMMEND)]);
    expect([clean.status, clean.stdout]).toEqual([0, 'VERDICT: clean\nFINDINGS: none\n']);
    const findings = cli(['--verdict', 'structured', file('[P0] corrupts data')]);
    expect([findings.status, findings.stdout]).toEqual([3, 'VERDICT: findings\nFINDINGS: P0\n']);
    const unverified = cli(['--verdict', 'structured', file('looks fine')]);
    expect(unverified.status).toBe(4);
    expect(unverified.stdout).toContain('VERDICT: unverified\n');
    expect(unverified.stderr).toContain('Outside review: ran, verdict unverified');
    const unavailable = cli(['--verdict', '--label', 'Codex outside review', 'review', file('')]);
    expect(unavailable.status).toBe(1);
    expect(unavailable.stdout).toContain('VERDICT: unavailable\nFINDINGS: none\nREASON: empty_response\n');
    expect(unavailable.stderr).toMatch(/^Codex outside review unavailable: the reviewer returned no response\. .*Fix: /);
  });

  test('--stderr and --exit imply the verdict form; a missing stderr file reads as empty', () => {
    const failed = cli(['--exit', '7', '--stderr', file('fatal: provider exploded\n'), 'review', file(RECOMMEND)]);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('REASON: execution_failed');
    expect(failed.stderr).toContain('(exit 7: fatal: provider exploded)');
    const missing = cli(['--stderr', path.join(TMP, 'never-written'), 'review', file(RECOMMEND)]);
    expect([missing.status, missing.stdout]).toEqual([0, 'VERDICT: clean\nFINDINGS: none\n']);
    expect(cli(['--exit', 'x', 'review', file(RECOMMEND)]).status).toBe(2);
  });

  test('an old rendered caller (pre-verdict skill text) still records findings as completed', () => {
    // The tail every generated outside-review fence carried before the verdict
    // form; bin/ and lib/ run live from the checkout, rendered text may lag.
    const response = file('[P1] Seeded data-loss bug\nREVIEW_COMPLETE');
    const old = `bun "$LIB" structured "$RESPONSE" || exit 1\necho 'OUTSIDE_STATUS: completed provider=codex host=claude'`;
    const r = spawnSync('bash', ['-c', old], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, LIB, RESPONSE: response } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('OUTSIDE_STATUS: completed provider=codex host=claude\n');
  });
});

describe('B1: a review whose sandbox could not start is unavailable, not clean', () => {
  const FIX = path.join(ROOT, 'test', 'fixtures', 'codex-sandbox');
  const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');
  const BWRAP = 'bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.';

  test('captured codex review in a container: exit 0, "no findings" text, bwrap failures on stderr', () => {
    const result = classifyOutsideReview({ text: read('review-userns-denied.stdout'), stderr: read('review-userns-denied.stderr'), exit: 0, gate: 'structured' });
    expect(result.verdict).toBe('unavailable');
    expect(result.reason).toBe('sandbox_unavailable');
    expect(result.detail).toStartWith(BWRAP);
    // The text-only wrapper (old importers) also stops passing it: the review says it could not read the diff.
    expect(validateOutsideReview(read('review-userns-denied.stdout'), 'structured').completed).toBe(false);
  });

  test('captured codex exec --json in a container: every command failed with a sandbox error', () => {
    const result = classifyOutsideReview({ text: 'hello', events: read('exec-json-userns-denied.jsonl'), gate: 'execution' });
    expect([result.verdict, result.reason]).toEqual(['unavailable', 'sandbox_unavailable']);
    expect(result.detail).toStartWith(BWRAP);
  });

  test('captured healthy runs count as executed even though Codex warns about bubblewrap', () => {
    const review = classifyOutsideReview({ text: read('review-healthy.stdout'), stderr: read('review-healthy.stderr'), gate: 'structured' });
    expect(review.execution.state).toBe('ran');
    expect(read('review-healthy.stderr')).toContain('could not find bubblewrap on PATH');
    expect(classifyOutsideReview({ text: 'hello', events: read('exec-json-healthy.jsonl'), gate: 'execution' }).verdict).toBe('clean');
  });

  test('a real review that discusses bwrap, namespaces, landlock and seccomp still passes', () => {
    const result = classifyOutsideReview({ text: read('review-mentions-sandbox.txt'), stderr: '', exit: 0, gate: 'review' });
    expect([result.verdict, result.findings.highest, result.execution.state]).toEqual(['clean', 'P2', 'ran']);
  });

  test('sandbox stderr with a non-zero exit (preflight fixtures) names the sandbox line', () => {
    const denied = classifyOutsideReview({ text: '', stderr: read('sandbox-userns-denied.stderr'), exit: 1, gate: 'review' });
    expect([denied.reason, denied.detail?.slice(0, BWRAP.length)]).toEqual(['sandbox_unavailable', BWRAP]);
    const missing = classifyOutsideReview({ text: '', stderr: read('sandbox-bwrap-missing.stderr'), exit: 101, gate: 'review' });
    expect(missing.reason).toBe('sandbox_unavailable');
    expect(missing.detail).toStartWith('bubblewrap is unavailable');
  });

  test('exact execution-failure phrases are the last fallback; positive evidence wins', () => {
    const probe = 'I could not run commands in this sandbox, so I reviewed nothing. No issues found.';
    expect(classifyOutsideReview({ text: probe, stderr: '', gate: 'structured' }).reason).toBe('commands_failed');
    expect(classifyOutsideReview({ text: `The diff could not be read.\n${RECOMMEND}`, gate: 'review' }).reason).toBe('commands_failed');
    const executed = '{"type":"item.completed","item":{"type":"command_execution","exit_code":0,"status":"completed","aggregated_output":"ok"}}';
    expect(classifyOutsideReview({ text: `If commands could not run, the helper retries.\n${RECOMMEND}`, events: executed, gate: 'review' }).verdict).toBe('clean');
    const failed = '{"type":"item.completed","item":{"type":"command_execution","exit_code":2,"status":"failed","aggregated_output":"fatal: not a git repository"}}';
    expect(classifyOutsideReview({ text: RECOMMEND, events: `${failed}\n${failed}`, gate: 'review' }).detail).toBe('all 2 commands failed');
  });

  test('a clean "I did not find any issues" with empty stderr still passes', () => {
    expect(classifyOutsideReview({ text: 'I did not find any issues.', stderr: '', exit: 0, gate: 'structured' }).verdict).toBe('clean');
  });

  test('the CLI reads --events', () => {
    const events = path.join(FIX, 'exec-json-userns-denied.jsonl');
    const r = cli(['--label', 'Codex outside review', '--events', events, 'execution', file('hello')]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('REASON: sandbox_unavailable');
    expect(r.stderr).toStartWith(`Codex outside review unavailable: Codex's sandbox could not start here (${BWRAP}`);
  });
});

describe('#3051: a mid-run Codex usage limit reads as unavailable (quota), with Codex\'s own line', () => {
  const LINE = "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 10th, 2026 2:55 AM.";

  test('failed call with the usage-limit line -> unavailable, reason quota_exhausted, detail is the line', () => {
    const result = classifyOutsideReview({ text: '', stderr: `Reading prompt from stdin...\n${LINE}\n`, exit: 1, gate: 'review' });
    expect([result.verdict, result.reason]).toEqual(['unavailable', 'quota_exhausted']);
    expect(result.detail).toBe(LINE);
  });

  test('a timeout whose partial stderr mentions a rate limit keeps the timeout reason', () => {
    const result = classifyOutsideReview({ text: '', stderr: 'retrying after rate limit\n', exit: 124, gate: 'review' });
    expect(result.reason).toBe('timeout');
  });

  test('a completed review that discusses rate limits is not unavailable', () => {
    const text = '[P2] the client ignores the API rate limit header\nRecommendation: fix the retry loop because it ignores Retry-After';
    const result = classifyOutsideReview({ text, stderr: '', exit: 0, gate: 'review' });
    expect(result.execution.state).toBe('ran');
  });

  test('the probe and the classifier recognise the same Codex lines', () => {
    const probe = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-codex-probe'), 'utf8').match(/_QUOTA_SIG="([^\n]+)"\n/)![1]!;
    for (const line of [LINE, 'ERROR: {"type":"error","status":429,"error":{"type":"rate_limit_exceeded"}}', 'insufficient_quota: You exceeded your current quota']) {
      const bash = spawnSync('bash', ['-c', `printf '%s' "$1" | grep -qiE "$2"`, '_', line, probe.replace(/\\"/g, '"')], { timeout: 5000 });
      expect({ line, bash: bash.status }).toEqual({ line, bash: 0 });
      expect(classifyOutsideReview({ text: '', stderr: line, exit: 1, gate: 'review' }).reason).toBe('quota_exhausted');
    }
  });
});

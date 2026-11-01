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
import { classifyOutsideReview, usageFromEvents, validateOutsideReview, type OutsideGate } from '../lib/outside-review-result';
import { gateOutcomeLine, type GateReason } from '../lib/gate-outcomes';

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

// A clean review states that it found nothing; an untagged finding is unverified (DX-11).
const RECOMMEND = 'No issues found in changed.ts.\nRecommendation: approve because changed.ts keeps its data.';
const UNTAGGED = 'Recommendation: fix the guard because changed.ts loses data.';

describe('classifyOutsideReview: separate execution, findings and verdict', () => {
  const cases: Array<[string, { text: string; gate: OutsideGate; stderr?: string; exit?: number }, string, string | null, string | undefined]> = [
    ['clean review', { text: RECOMMEND, gate: 'review' }, 'clean', null, undefined],
    ['review with an untagged finding', { text: UNTAGGED, gate: 'review' }, 'unverified', null, 'untagged_review'],
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

// #3294: "clean" comes only from a no-findings statement that concludes the reply,
// never from a "no X" phrase among untagged findings anywhere in it.
describe('a no-findings statement counts only as the reply\'s conclusion (#3294)', () => {
  const REPORTER = 'I found no actionable regressions in the staged, unstaged, or untracked changes.';
  const FINDING = 'The fallback path now swallows ENOENT and returns an empty config.';

  test("the reporter's exact codex review reply reads clean through the reporter's CLI invocation", () => {
    expect(classifyOutsideReview({ text: REPORTER, gate: 'structured' }).verdict).toBe('clean');
    const r = cli(['--label', 'probe', '--exit', '0', '--stderr', file(''), 'structured', file(REPORTER)]);
    expect([r.status, r.stdout]).toEqual([0, 'VERDICT: clean\nFINDINGS: none\n']);
  });

  test('clean conclusions, with the added regressions/defects vocabulary and the requested marker formatted', () => {
    for (const text of ['No regressions found.', 'I did not find any defects.', 'There are no actionable regressions.',
      'NO_FINDINGS', '**NO_FINDINGS**', '`NO_FINDINGS`', '- NO_FINDINGS',
      `The change adds a retry cap and its tests.\n${REPORTER}`, 'Reviewed the retry helper.\n\nNo issues found in this change.',
      'After reviewing the patch, I found no issues.', 'I found no issues in this read-only change.',
      'Summary of the retry helper\nNo issues found.', 'I found no actionable regressions in the staged\nchanges.',
      // Clean `codex review --uncommitted` replies captured from codex-cli 0.160.0 with gpt-6-sol.
      'The change validates the retry limit before execution. No actionable regression was found.',
      'The change validates `max` before retrying. No affected callers or tests are present in the repository, and no actionable regression is evident.']) {
      expect({ text, verdict: classifyOutsideReview({ text, gate: 'structured' }).verdict }).toEqual({ text, verdict: 'clean' });
    }
  });

  test('mixed replies: untagged findings beside a "no X" phrase are unverified, never clean', () => {
    for (const text of [
      'The parser change has no new issues. However, db/002_drop_idx.sql drops users_email_idx, which will regress login latency under load.',
      'Renaming the flag is no problem for callers, but the fallback path now swallows ENOENT and returns an empty config.',
      `No issues in the parser.\n\n${FINDING}`,
      `${FINDING}\n\nNo issues in the parser.`,
      `${FINDING} No regressions in the existing tests.`,
      'No regressions in the existing tests, but the fallback path now swallows ENOENT.',
      `${FINDING}\nI found no issues other than the fallback path.`,
      `${FINDING}\nNo other issues.`,
      'No issues found, except that the fallback path now swallows ENOENT.',
      'No issues in the parser, and the fallback path now swallows ENOENT.',
      'Missing configuration now silently disables authentication. No regressions were found by the existing tests.',
      'Missing configuration now silently disables authentication. No issues are apparent in the parser.',
      'The fallback path now swallows ENOENT, and no issues elsewhere.',
      'The diff adds a NO_FINDINGS check, but the regex misses lowercase input.',
      `${FINDING}\n\`\`\`\nNo issues found.\n\`\`\``,
    ]) {
      for (const gate of ['structured', 'review'] as const) {
        const r = classifyOutsideReview({ text: gate === 'review' ? `${text}\nRecommendation: ship because it looks fine.` : text, gate });
        expect({ text, gate, verdict: r.verdict, reason: r.reason }).toEqual({ text, gate, verdict: 'unverified', reason: 'untagged_review' });
      }
    }
  });

  test("a review's Recommendation because-clause concludes under the same rules", () => {
    const verdict = (text: string) => classifyOutsideReview({ text, gate: 'review' }).verdict;
    expect(verdict('Recommendation: ship because I found no regressions in this change.')).toBe('clean');
    expect(verdict(`The change adds a retry cap.\nRecommendation: ship because no issues remain.`)).toBe('clean');
    expect(verdict('No issues in the parser.\nRecommendation: fix the fallback because it swallows ENOENT.')).toBe('unverified');
    expect(verdict(`${FINDING}\nRecommendation: ship because no regressions in the existing tests.`)).toBe('unverified');
    expect(verdict(`${FINDING}\nRecommendation: ship because no issues remain, but the fallback needs a follow-up.`)).toBe('unverified');
    expect(verdict('Recommendation: address the migration because no regressions were found in the parser change,\nbut the migration drops users_email_idx.')).toBe('unverified');
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

describe('Codex token usage from --json events (#2948)', () => {
  const turn = (usage: Record<string, number>) => JSON.stringify({ type: 'turn.completed', usage });

  test('one turn: every counter the event carries, nothing invented', () => {
    expect(usageFromEvents(turn({ input_tokens: 12016, cached_input_tokens: 0, cache_write_input_tokens: 12013, output_tokens: 5, reasoning_output_tokens: 0 })))
      .toEqual({ input_tokens: 12016, cached_input_tokens: 0, cache_write_input_tokens: 12013, output_tokens: 5, reasoning_output_tokens: 0, usd: 'unknown' });
  });

  test('the latest turn wins (codex reports the running session total); malformed and unrelated lines are skipped', () => {
    const events = [turn({ input_tokens: 100, output_tokens: 10 }), 'not json', '{"type":"item.completed","item":{"type":"agent_message"}}', turn({ input_tokens: 150, output_tokens: 15, reasoning_output_tokens: 2 })].join('\n');
    expect(usageFromEvents(events)).toEqual({ input_tokens: 150, output_tokens: 15, reasoning_output_tokens: 2, usd: 'unknown' });
  });

  test('a cumulative total_token_usage snapshot wins over per-turn usage, latest first', () => {
    const snap = (n: number) => JSON.stringify({ msg: { type: 'token_count', info: { total_token_usage: { input_tokens: n, output_tokens: n / 10, total_tokens: n * 1.1 } } } });
    expect(usageFromEvents([turn({ input_tokens: 7 }), snap(100), snap(300)].join('\n'))).toEqual({ input_tokens: 300, output_tokens: 30, total_tokens: 330, usd: 'unknown' });
  });

  test('the CLI prints OUTSIDE_USAGE only when given --events, on every verdict', () => {
    const events = path.join(TMP, 'usage-events.jsonl');
    fs.writeFileSync(events, turn({ input_tokens: 1200, cached_input_tokens: 200, output_tokens: 340 }) + '\n');
    const withEvents = cli(['--events', events, 'review', file('No issues found.')]);
    expect(withEvents.stdout).toContain('OUTSIDE_USAGE: input=1200 cached_input=200 output=340\n');
    const empty = path.join(TMP, 'no-usage.jsonl');
    fs.writeFileSync(empty, '{"type":"thread.started"}\n');
    expect(cli(['--events', empty, 'review', file('')]).stdout).toContain('OUTSIDE_USAGE: unknown\n');
    expect(cli(['--verdict', 'review', file('No issues found.')]).stdout).not.toContain('OUTSIDE_USAGE');
  });
});

describe('a mid-run Codex usage limit is unavailable (quota_exhausted); a mid-run 429 is unavailable (rate_limited)', () => {
  const LINE = "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 10th, 2026 2:55 AM.";
  const RATE_429 = 'ERROR: {"type":"error","status":429,"error":{"type":"rate_limit_exceeded","message":"Rate limit reached"}}';
  const QUOTA_429 = 'ERROR: {"type":"error","status":429,"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}';
  const ECHOED = 'user\nCheck the usage limit banner and the insufficient_quota (429) retry path in this diff\n';

  test('failed call with the usage-limit line -> unavailable, reason quota_exhausted, detail is the line', () => {
    const result = classifyOutsideReview({ text: '', stderr: `Reading prompt from stdin...\n${LINE}\n`, exit: 1, gate: 'review' });
    expect([result.verdict, result.reason]).toEqual(['unavailable', 'quota_exhausted']);
    expect(result.detail).toBe(LINE);
  });

  test('failed call with a bare 429 -> unavailable, reason rate_limited, detail is the line', () => {
    const result = classifyOutsideReview({ text: '', stderr: `${ECHOED}${RATE_429}\n`, exit: 1, gate: 'review' });
    expect([result.verdict, result.reason, result.detail]).toEqual(['unavailable', 'rate_limited', RATE_429]);
    expect(gateOutcomeLine('Codex outside review', 'rate_limited', result.detail)).toContain('https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#codex-rate-limited');
  });

  test('a 429 body that also names insufficient_quota is the quota (quota wins over rate limit)', () => {
    const stderr = `stream error: exceeded retry limit, last status: 429 Too Many Requests; retrying 1/5\n${QUOTA_429}\n`;
    expect(classifyOutsideReview({ text: '', stderr, exit: 1, gate: 'review' }).reason).toBe('quota_exhausted');
  });

  test('an echoed prompt that names usage limit, insufficient_quota and 429 stays execution_failed', () => {
    const stderr = `${ECHOED}ERROR: unexpected status 500 Internal Server Error\n`;
    expect(classifyOutsideReview({ text: '', stderr, exit: 1, gate: 'review' }).reason).toBe('execution_failed');
    expect(classifyOutsideReview({ text: '', stderr: `ERROR: ${LINE.slice(7)}\nthen the session continued and failed\n`, exit: 1, gate: 'review' }).reason).toBe('execution_failed');
  });

  test('a timeout whose partial stderr has a usage-limit or rate-limit line keeps the timeout reason', () => {
    for (const line of [LINE, RATE_429]) {
      expect(classifyOutsideReview({ text: '', stderr: `${line}\n`, exit: 124, gate: 'review' }).reason).toBe('timeout');
    }
  });

  test('a completed review that discusses rate limits is not unavailable', () => {
    const text = '[P2] the client ignores the API rate limit header\nRecommendation: fix the retry loop because it ignores Retry-After';
    const result = classifyOutsideReview({ text, stderr: `${ECHOED}${RATE_429}\n`, exit: 0, gate: 'review' });
    expect(result.execution.state).toBe('ran');
  });

  test('the probe and the classifier give the same outcome for the same Codex error output', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-quota-parity-'));
    try {
      const stubDir = path.join(home, 'bin');
      const codexHome = path.join(home, '.codex');
      fs.mkdirSync(stubDir);
      fs.mkdirSync(codexHome);
      fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
      fs.writeFileSync(path.join(stubDir, 'codex'), '#!/usr/bin/env bash\nprintf \'%s\' "$STUB_STDERR" >&2\nexit 1\n', { mode: 0o755 });
      const cases: Array<[string, GateReason]> = [
        [`${LINE}\n`, 'quota_exhausted'],
        ['ERROR: Quota exceeded. Check your plan and billing details.\n', 'quota_exhausted'],
        [`${QUOTA_429}\n`, 'quota_exhausted'],
        [`${RATE_429}\n`, 'rate_limited'],
        ['stream error: exceeded retry limit, last status: 429 Too Many Requests\n', 'rate_limited'],
        [`${ECHOED}ERROR: unexpected status 500 Internal Server Error\n`, 'execution_failed'],
      ];
      for (const [stderr, reason] of cases) {
        fs.rmSync(path.join(home, '.gstack'), { recursive: true, force: true });
        const probe = spawnSync('bash', ['-c', `source "${path.join(ROOT, 'bin', 'gstack-codex-probe')}" && _gstack_codex_model_probe`], {
          encoding: 'utf8', timeout: 20_000,
          env: { PATH: `${stubDir}:${process.env.PATH ?? ''}`, HOME: home, CODEX_HOME: codexHome, GSTACK_HOME: path.join(home, '.gstack'), STUB_STDERR: stderr, _TEL: 'off' },
        });
        const probeReason = probe.stdout.includes('MODEL_QUOTA_EXHAUSTED') ? 'quota_exhausted'
          : probe.stdout.includes('MODEL_PROBE_RATE_LIMITED') ? 'rate_limited'
          : probe.stdout.includes('MODEL_PROBE_INCONCLUSIVE') ? 'execution_failed' : `other: ${probe.stdout}`;
        expect({ stderr, probe: probeReason }).toEqual({ stderr, probe: reason });
        expect({ stderr, classifier: classifyOutsideReview({ text: '', stderr, exit: 1, gate: 'review' }).reason }).toEqual({ stderr, classifier: reason });
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

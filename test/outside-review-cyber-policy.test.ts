/**
 * R95 (2026-11-13): OpenAI refuses some review briefs under its cyber-security policy (`cyber_policy`). That refusal
 * is its own outcome, cyber_policy_refused, never a generic failure, so Capy's /ship can retry it on GPT-6 Astra with
 * the read-only correctness brief (lib/review-brief.ts) and then Gemini 4 Carbon (lib/capy-review-pass.js).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyOutsideReview } from '../lib/outside-review-result';
import { GATE_OUTCOMES, gateOutcomeLine } from '../lib/gate-outcomes';
import { READ_ONLY_RETRY, renderBrief, sectionTexts } from '../lib/review-brief';

const ROOT = path.resolve(import.meta.dir, '..');
const LIB = path.join(ROOT, 'lib', 'outside-review-result.ts');
const CAPY_ERROR = fs.readFileSync(path.join(ROOT, 'test/fixtures/cyber-policy/capy-latest-error.txt'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyber-policy-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const REVIEW = 'Recommendation: ship as-is because no finding survived\nVERDICT: CLEAN';

describe('a cyber_policy refusal is its own outcome (R95)', () => {
  // Value: protects=the captured Capy refusal (GBRA-392's outside voice) classifies as cyber_policy_refused with the provider's line as detail, so /ship can tell it apart from auth, timeout and empty replies; fails_when=the host error is ignored, or the refusal falls into execution_failed or review_refused;
  //   why_new=R95; seam=lib/outside-review-result.ts execution(); no_claim=how often OpenAI refuses
  test("Capy's captured latest_error is cyber_policy_refused, with the provider's line as detail", () => {
    const c = classifyOutsideReview({ text: '', gate: 'review', exit: 1, providerError: CAPY_ERROR });
    expect(c).toMatchObject({ verdict: 'unavailable', reason: 'cyber_policy_refused' });
    expect(c.detail!.startsWith('OpenAI key declined the request: cyber_policy:')).toBe(true);
    expect(GATE_OUTCOMES.cyber_policy_refused.state).toBe('unavailable');
    const line = gateOutcomeLine('Outside voice', 'cyber_policy_refused', c.detail);
    expect(line).toContain('missing coverage, not a pass');
    expect(line).toContain('docs/troubleshooting.md#outside-review-cyber-policy');
  });

  // Value: protects=Codex's own trailing ERROR line with cyber_policy is the refusal, while a prompt echo that merely quotes cyber_policy is not; fails_when=the classifier reads the whole stderr (Codex echoes the prompt, and this PR's own diff names cyber_policy);
  //   why_new=R95; seam=lib/outside-review-result.ts codexErrorLines; no_claim=Codex's exact wording, which is synthetic here
  test("Codex's ERROR line is read; a prompt echo that quotes cyber_policy is not", () => {
    const echo = 'user\nReview this diff: + if (/cyber_policy/.test(err)) retry()\n';
    const refused = classifyOutsideReview({ text: '', gate: 'review', exit: 1, stderr: echo + 'ERROR: {"error":{"code":"cyber_policy","message":"This content was flagged for possible cybersecurity risk."}}\n' });
    expect(refused.reason).toBe('cyber_policy_refused');
    const auth = classifyOutsideReview({ text: '', gate: 'review', exit: 1, stderr: echo + 'ERROR: 401 Unauthorized: invalid API key\n' });
    expect(auth.reason).toBe('execution_failed');
  });

  // Value: protects=auth, timeout, empty, quota and plain failures keep their reasons, and a host error without cyber_policy changes nothing; fails_when=the new check swallows another failure or a non-refusal host error starts a retry;
  //   why_new=R95 (non-refusal failures unchanged); seam=lib/outside-review-result.ts execution(); no_claim=none
  test('non-refusal failures keep their reasons', () => {
    const cases: Array<[Parameters<typeof classifyOutsideReview>[0], string]> = [
      [{ text: '', gate: 'review', exit: 124, stderr: 'killed' }, 'timeout'],
      [{ text: '', gate: 'review', exit: 0 }, 'empty_response'],
      [{ text: '', gate: 'review', exit: 1, stderr: 'ERROR: You exceeded your current quota\n' }, 'quota_exhausted'],
      [{ text: '', gate: 'review', exit: 1, stderr: 'ERROR: 401 Unauthorized\n' }, 'execution_failed'],
      [{ text: '', gate: 'review', exit: 1, providerError: 'OpenAI key declined the request: invalid_api_key' }, 'execution_failed'],
      [{ text: 'I cannot review this change.', gate: 'review', exit: 0 }, 'review_refused'],
    ];
    for (const [input, reason] of cases) expect(classifyOutsideReview(input).reason).toBe(reason as never);
  });

  // Value: protects=a completed review that discusses cyber_policy, with or without cyber_policy on stderr after a clean exit, still counts as the review it is, while the host's own error (providerError) naming cyber_policy is the refusal whatever the reply says; fails_when=any mention of cyber_policy in the reply or on stderr makes it a refusal, or a host refusal is read as a clean review;
  //   why_new=R95 negative control; seam=lib/outside-review-result.ts; no_claim=none
  test('a normal review is never a refusal', () => {
    const text = 'The new check matches cyber_policy in the error.\n' + REVIEW;
    expect(classifyOutsideReview({ text, gate: 'review', exit: 0 })).toMatchObject({ verdict: 'clean' });
    expect(classifyOutsideReview({ text, gate: 'review', exit: 0, stderr: 'cyber_policy\n' })).toMatchObject({ verdict: 'clean' });
    expect(classifyOutsideReview({ text, gate: 'review', exit: 0, providerError: CAPY_ERROR }).reason).toBe('cyber_policy_refused');
  });

  // Value: protects=the CLI the Capy pass program calls reads --provider-error and prints REASON: cyber_policy_refused; fails_when=the flag is refused as usage or ignored;
  //   why_new=R95; seam=outside-review-result.ts --verdict; no_claim=none
  test('the --verdict CLI reads --provider-error', () => {
    const err = path.join(TMP, 'err.txt'), reply = path.join(TMP, 'reply.txt');
    fs.writeFileSync(err, CAPY_ERROR);
    fs.writeFileSync(reply, '');
    const r = spawnSync(process.execPath, [LIB, '--verdict', '--provider-error', err, '--exit', '1', '--label', 'Outside voice', 'review', reply], { encoding: 'utf8', timeout: 10_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('REASON: cyber_policy_refused');
    expect(r.stderr).toContain('Outside voice unavailable: OpenAI declined the review under its cyber-security policy (cyber_policy)');
  });
});

describe('the read-only retry brief (R95)', () => {
  const t = sectionTexts(ROOT);
  const slots = { diff_base: 'abc1234', diff: '+x' };
  // Value: protects=the retry brief drops attacker role-play, asks for file:line, the wrong-answer condition and the smallest fix, and keeps every marker collect needs, while the default outside brief is unchanged; fails_when=the retry text leaks into the default brief, or the retry loses the Recommendation/VERDICT markers;
  //   why_new=R95 (reworded only on the retry); seam=lib/review-brief.ts outside-voice; no_claim=that the retry finds what the original would
  test('only the retry render is reworded, and it keeps the reply markers', () => {
    const plain = renderBrief('outside-voice', slots, t);
    const retry = renderBrief('outside-voice', { ...slots, read_only: '1' }, t);
    expect(plain).toContain('Think like an attacker and a chaos engineer.');
    expect(plain).not.toContain(READ_ONLY_RETRY);
    expect(retry).toContain(READ_ONLY_RETRY);
    for (const gone of ['Think like an attacker', 'Be adversarial.', 'most exploitable']) expect(retry).not.toContain(gone);
    for (const kept of ['Severity: Critical|High|Medium|Low', 'Recommendation: <action> because', 'VERDICT: CLEAN', 'git diff "$DIFF_BASE"']) expect(retry).toContain(kept);
    expect(READ_ONLY_RETRY).toContain('For each defect give file:line, the condition under which the code returns the wrong answer, and the smallest fix');
    expect(() => renderBrief('outside-voice', { ...slots, read_only: '1' }, { ...t, outside: t.outside.replace('Be adversarial. ', '') })).toThrow(/placeholder Be adversarial/);
  });
});

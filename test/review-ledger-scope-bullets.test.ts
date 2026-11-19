/**
 * The collector read a reader's own scope list or passed-checks bullets as findings (GST-3201). On #4518 (p1, native adversarial
 * reader) "- a HIGH finding still refused;" in its list of what the tests cover collected as HIGH, and on #4519 (round 2, Red Team)
 * "- `missing_verdict` can't occur alongside P0 or P1 findings." in its list of checks that held collected as P0. Both replies
 * declared REVIEW_VERDICT: blocking=0, and both forced an owner ruling. Excerpts of the captured outputs below, as returned.
 */
import { describe, expect, test } from 'bun:test';
import { parseReply } from '../lib/review-ledger';

const CAPTURED_4518_P1_ADVERSARIAL = [
  'REVIEWED_TREE: 5733be6b184a1f8387580c089b4c0413beeb304b /workspace/gstack',
  'REVIEW_VERDICT: blocking=0',
  '',
  "I found no blocking findings. The weakest point is that the hand-off replaces the whole body from a fresh read, so it is only as safe as the agent's habit of publishing each file before the next gstack step.",
  '',
  '**Scope.** I read the full non-fixture diff from f13dbb0d to HEAD (6 commits, GST-3183): `bin/gstack-post`, `bin/gstack-ship-receipt`, `lib/host-publish.ts`, `lib/gstack-post.ts`, `lib/greptile-early.ts`, `scripts/lib/windows-curation.ts`, the ship section prose and templates, `docs/troubleshooting.md` and the changelog fragment. I reviewed the fixtures and tests in summary mode only (diff stat and test names, no payload bytes): `test/capy-host-publish.test.ts` (+320, new), `test/greptile-early.test.ts` (+11), and a size-ledger JSON. They cover:',
  '- that no gh write happens under `GSTACK_CAPY=1` for stub, stop, claim, carry and every gstack-post op;',
  '- a negative control without Capy;',
  '- two-repo, fork (`gh repo set-default` or `GH_REPO`) and GitHub Enterprise destinations;',
  "- refusal when the repository can't be resolved;",
  '- a HIGH finding still refused;',
  '- a detached HEAD on pr-create;',
  "- a hand-off that can't be written;",
  '- greptile-early exiting 3 on a hand-off.',
  '',
  '**Findings**',
  '',
  "2. **claim's re-read check is now always true on Capy, so two runs can claim one grant** (`bin/gstack-ship-receipt:1152-1153`). INVESTIGATE. Under host publishing, `again` is built locally from `read.body` plus this run's own marker. That makes the `first?.run !== run` re-read check a tautology. Two runs racing on one grant both print `GRANT_CLAIMED` and both dispatch a granted round; only a later `history` call catches it. This is documented, but it weakens a merge-check guard. A fix needs a design call, for example a second `claim --verify` step after publishing. Severity: Low. Blocks: no.",
  '',
  'Recommendation: Ship as-is because the strongest finding, the stale whole-body hand-off at `bin/gstack-ship-receipt:1069` overwriting an unpublished run entry, only happens when the agent skips the documented publish-before-next-step order, and no test or production path fails when that order is followed.',
].join('\n');

const CAPTURED_4519_R2_RED_TEAM = [
  'REVIEWED_TREE: 42315eacf53a28493d84f02f9c3701e295a04733 /workspace/gstack',
  'REVIEW_VERDICT: blocking=0',
  '',
  'I found 2 informational findings and nothing that blocks the merge. I read the non-fixture source diff in full. I reviewed the three changed test files in summary mode only, by their stats and test titles, so that part of the coverage is reduced. They add 118 lines covering: the final-failure-decides ordering, 402 in a request id or a duration versus 402 as a status, Claude Code error subtypes and its budget stop, reviewer-file versus closing-message selection (GST-3188), and refusing a prompt that is also an output file.',
  '',
  'The integration paths I checked hold up:',
  "- Claude Code's budget stop reaches `execution()` as `ERROR: <CLAUDE_CODE_BUDGET_STOP …>`, the last stderr line, so `codexErrorLines` picks it up. It gets matched before `QUOTA_FAILURE`.",
  "- The phase names and hex sha in `autoplan-prompts` `RESULT_FORMAT` match the runner's receipt regex. `parseReceipt` doesn't lowercase the expected phase, but the phases are already lowercase.",
  "- `missing_verdict` can't occur alongside P0 or P1 findings.",
  '',
  JSON.stringify({ severity: 'INFORMATIONAL', confidence: 5, path: 'lib/outside-review-result.ts', line: 73, category: 'red-team', summary: "The tighter BUDGET_FAILURE regex no longer recognizes some real 402 spellings that the old one caught, such as 'Request failed with status code (402)' and 'got 402 from proxy' (both checked at runtime: false). Those now fall through to execution_failed. The gate still fails closed, but the user gets generic advice instead of the budget_exhausted fix.", fix: "Allow '(' in the separator class, e.g. [\\s:=\"'(]{0,4}, or accept that these spellings are rare.", fingerprint: 'lib/outside-review-result.ts:73:red-team', specialist: 'red-team' }),
].join('\n');

const labels = (reader: string, out: string) => parseReply(reader, out, true, true).findings.map(f => [f.label, f.raw.slice(0, 40)]);

describe('a reader\'s scope and passed-checks bullets under a blocking=0 verdict', () => {
  // Value: protects=a bullet that names severities only as a kind of finding never blocks when the reader declared blocking=0;
  //   fails_when=#4518's or #4519's bullet collects as HIGH or P0 again, or a real finding loses its label; why_new=both forced
  //   owner rulings (GST-3201); seam=parseReply with the verdict ask, as collect calls it; no_claim=lead judgment downstream
  test('#4518: the scope-list bullet stays on record at INFORMATIONAL; the real finding keeps Severity: Low', () => {
    expect(labels('adversarial-native', CAPTURED_4518_P1_ADVERSARIAL)).toEqual([
      ['INFORMATIONAL', '- a HIGH finding still refused;'],
      ['Low', "2. **claim's re-read check is now always"],
    ]);
  });

  test('#4519: the passed-check bullet stays on record at INFORMATIONAL, and the verdict agrees', () => {
    const r = parseReply('red-team', CAPTURED_4519_R2_RED_TEAM, true, true);
    expect(r.findings.map(f => f.label)).toEqual(['INFORMATIONAL', 'INFORMATIONAL']);
    expect(r.verdict).toEqual({ state: 'valid', parsed: 0, declared: 0, agrees: true });
  });

  test('negative controls: the same bullet still collects as written without blocking=0, and a bullet that reports a defect still does', () => {
    const bullet = "- `missing_verdict` can't occur alongside P0 or P1 findings.";
    const reply = (verdict: string, line: string) => ['REVIEWED_TREE: 42315eacf53a28493d84f02f9c3701e295a04733 /workspace/gstack', verdict, '', line].join('\n');
    expect(labels('red-team', reply('REVIEW_VERDICT: blocking=1', bullet))[0]![0]).toBe('P0');
    expect(parseReply('red-team', bullet, true, false).findings.map(f => f.label)).toEqual(['P0']);
    expect(labels('adversarial-native', CAPTURED_4518_P1_ADVERSARIAL.replace('- a HIGH finding still refused;', '- a HIGH finding still refused at lib/host-publish.ts:40;'))[0]![0]).toBe('HIGH');
    const zero = 'REVIEW_VERDICT: blocking=0';
    expect(labels('red-team', reply(zero, '- P0: the gate drops a HIGH finding.'))[0]![0]).toBe('P0');
    expect(labels('red-team', reply(zero, '- a HIGH finding: the cache key drops the tree.'))[0]![0]).toBe('HIGH');
    expect(labels('red-team', reply(zero, '- a HIGH finding still refused. Severity: High'))[0]![0]).toBe('High');
    expect(labels('adversarial-native', reply(zero, '- a HIGH finding is dropped, FIXABLE.'))[0]![0]).toBe('CRITICAL');
    expect(labels('red-team', reply(zero, '- the HIGH path crashes when the ledger is empty.'))[0]![0]).toBe('HIGH');
  });
});

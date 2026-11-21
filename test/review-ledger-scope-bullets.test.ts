/**
 * The collector read a reader's own scope list or passed-checks bullets as findings (GST-3201). On #4518 (p1, native adversarial
 * reader) "- a HIGH finding still refused;" in its list of what the tests cover collected as HIGH, and on #4519 (round 2, Red Team)
 * "- `missing_verdict` can't occur alongside P0 or P1 findings." in its list of checks that held collected as P0. Both replies
 * declared REVIEW_VERDICT: blocking=0, and both forced an owner ruling, since a list item was never a summary candidate the lead could
 * lower. Such a bullet now keeps its label and becomes one. Excerpts of the captured outputs below, as returned.
 */
import { describe, expect, test } from 'bun:test';
import { judge, parseReply, type MergedLine } from '../lib/review-ledger';

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

const rows = (reader: string, out: string) => parseReply(reader, out, true, true).findings.map(f => [f.label, f.raw.slice(0, 40), !!f.summary]);
const reply = (verdict: string, line: string) => ['REVIEWED_TREE: 42315eacf53a28493d84f02f9c3701e295a04733 /workspace/gstack', verdict, '', line].join('\n');
const ZERO = 'REVIEW_VERDICT: blocking=0';
/** The merged lines collect writes for a reply, then lead judgment lowering every line to INFORMATIONAL with a reason. */
const lowered = (reader: string, out: string) => {
  const merged: MergedLine[] = parseReply(reader, out, true, true).findings.map((f, i) => ({ id: `${reader}#${i + 1}`, reader, label: f.label, raw: f.raw, output_sha256: 'x', ...(f.summary ? { summary_candidate: true as const } : {}) }));
  return judge(merged, merged.map(m => ({ id: m.id, severity: 'INFORMATIONAL', reason: 'the reader lists what passed; it reports no defect' })));
};

describe('a reader\'s scope and passed-checks bullets under a blocking=0 verdict', () => {
  // Value: protects=a bullet that names severities only as a kind of finding, in a reply declaring blocking=0, is a summary candidate
  //   the lead may lower with a reason, and still blocks until then; fails_when=#4518's or #4519's bullet cannot be lowered without an
  //   owner ruling again, or a bullet asserting a blocker ("Two P0 findings remain") loses its label; why_new=both forced owner
  //   rulings (GST-3201); seam=parseReply with the verdict ask and judge, as collect and the lead use them; no_claim=/ship's Step 11 prose
  test('#4518: the scope-list bullet keeps HIGH as a summary candidate; the real finding keeps Severity: Low', () => {
    expect(rows('adversarial-native', CAPTURED_4518_P1_ADVERSARIAL)).toEqual([
      ['HIGH', '- a HIGH finding still refused;', true],
      ['Low', "2. **claim's re-read check is now always", false],
    ]);
  });

  test('#4519: the passed-check bullet keeps P0 as a summary candidate, so the lead can lower it with a reason', () => {
    const r = parseReply('red-team', CAPTURED_4519_R2_RED_TEAM, true, true);
    expect(r.findings.map(f => [f.label, !!f.summary])).toEqual([['P0', true], ['INFORMATIONAL', false]]);
    expect(r.verdict).toEqual({ state: 'valid', parsed: 1, declared: 0, agrees: false });
    expect(lowered('red-team', CAPTURED_4519_R2_RED_TEAM)).toMatchObject({ ok: true, dismissed: ['red-team#1'], downgraded: [] });
    expect(lowered('adversarial-native', CAPTURED_4518_P1_ADVERSARIAL)).toMatchObject({ dismissed: ['adversarial-native#1'] });
  });

  test('negative controls: a bullet asserting a blocker keeps its label and blocks until judged; other shapes collect as before', () => {
    for (const line of ['- Two P0 findings remain unfixed.', '- The P0 finding is that the gate drops rows.']) {
      expect(rows('red-team', reply(ZERO, line))).toEqual([['P0', line.slice(0, 40), true]]);
      expect(parseReply('red-team', reply(ZERO, line), true, true).verdict).toMatchObject({ parsed: 1, agrees: false });
    }
    expect(rows('red-team', reply('REVIEW_VERDICT: blocking=1', "- `missing_verdict` can't occur alongside P0 or P1 findings."))[0]).toEqual(['P0', "- `missing_verdict` can't occur alongsid", false]);
    expect(parseReply('red-team', "- `missing_verdict` can't occur alongside P0 or P1 findings.", true, false).findings.map(f => [f.label, !!f.summary])).toEqual([['P0', false]]);
    expect(rows('adversarial-native', CAPTURED_4518_P1_ADVERSARIAL.replace('- a HIGH finding still refused;', '- a HIGH finding still refused at lib/host-publish.ts:40;'))[0]![2]).toBe(false);
    expect(rows('red-team', reply(ZERO, '- P0: the gate drops a HIGH finding.'))[0]).toEqual(['P0', '- P0: the gate drops a HIGH finding.', false]);
    expect(rows('red-team', reply(ZERO, '- a HIGH finding: the cache key drops the tree.'))[0]![2]).toBe(false);
    expect(rows('red-team', reply(ZERO, '- a HIGH finding still refused. Severity: High'))[0]![2]).toBe(false);
    expect(rows('adversarial-native', reply(ZERO, '- a HIGH finding is dropped, FIXABLE.'))[0]).toEqual(['CRITICAL', '- a HIGH finding is dropped, FIXABLE.', false]);
    expect(rows('red-team', reply(ZERO, '- the HIGH path crashes when the ledger is empty.'))[0]![2]).toBe(false);
    expect(lowered('red-team', reply(ZERO, '- P0: the gate drops a HIGH finding.'))).toMatchObject({ ok: false, downgraded: ['red-team#1'] });
  });
});

/**
 * #4553 (GSTA-666, 2026-11-20): the native reader's Scope bullets named findings the run already had by their status, "the 7 noted
 * CRITICAL duplicates" and "a deferred CRITICAL", and #4519's Red Team bullet named severities as a list with no "findings" after it.
 * Each collected as a blocker the lead could not lower, so two owner rulings cleared them. The captured output stayed on that run's
 * machine; this reply rebuilds its shape from the run's decision trail (rows 22-23) and the lane's report.
 */
const REBUILT_4553_P1_ADVERSARIAL = [
  'REVIEWED_TREE: f680df6d0000000000000000000000000000beef /workspace/gstack',
  'REVIEW_VERDICT: blocking=0',
  '',
  'I found no blocking findings.',
  '',
  '**Scope.** I read the full diff of gstack-review-read and its tests. The tests cover:',
  '- 22 rulings leave the 7 noted CRITICAL duplicates named;',
  '- a row listing fewer findings than it claims;',
  '- ruling every finding makes all three rows CURRENT;',
  '- a deferred CRITICAL and a gate finding.',
  '',
  'Recommendation: Ship as-is.',
].join('\n');

describe('a scope bullet naming a finding by its status or a list of severities (#4553, #4519)', () => {
  // Value: protects=a bullet that names findings by a status they already have (noted, deferred) or names severities as a list, in a
  //   reply declaring blocking=0, is a summary candidate the lead may lower with a reason; fails_when=#4553's Scope bullets or the
  //   bare "P0 or P1" passed check need an owner ruling again, or a bullet stating a blocker loses its label; why_new=GSTA-666 needed two
  //   Captain rulings for them; seam=parseReply with the verdict ask and judge, as collect and the lead use them; no_claim=-
  test('#4553: the noted and deferred CRITICAL bullets keep CRITICAL as summary candidates the lead can lower', () => {
    expect(rows('adversarial-native', REBUILT_4553_P1_ADVERSARIAL)).toEqual([
      ['CRITICAL', '- 22 rulings leave the 7 noted CRITICAL ', true],
      ['CRITICAL', '- a deferred CRITICAL and a gate finding', true],
    ]);
    expect(lowered('adversarial-native', REBUILT_4553_P1_ADVERSARIAL)).toMatchObject({ ok: true, dismissed: ['adversarial-native#1', 'adversarial-native#2'], downgraded: [] });
  });

  test('#4519: a passed check naming "P0 or P1" with no noun after it is a summary candidate too', () => {
    const line = '- `missing_verdict` cannot occur alongside P0 or P1';
    expect(rows('red-team', reply(ZERO, line))).toEqual([['P0', line.slice(0, 40), true]]);
    expect(lowered('red-team', reply(ZERO, line))).toMatchObject({ ok: true, dismissed: ['red-team#1'] });
  });

  test('negative controls: a status or list that leads a claim, a located line and a reply with no blocking=0 still block', () => {
    expect(rows('red-team', reply(ZERO, '- a deferred CRITICAL: the gate drops rows.'))[0]![2]).toBe(false);
    expect(rows('red-team', reply(ZERO, '- a deferred CRITICAL in lib/gate.ts:12 drops rows.'))[0]![2]).toBe(false);
    expect(rows('red-team', reply(ZERO, '- the CRITICAL path drops rows.'))[0]![2]).toBe(false);
    expect(rows('red-team', reply('REVIEW_VERDICT: blocking=1', '- a deferred CRITICAL and a gate finding.'))[0]).toEqual(['CRITICAL', '- a deferred CRITICAL and a gate finding', false]);
    expect(parseReply('red-team', '- `missing_verdict` cannot occur alongside P0 or P1', true, false).findings.map(f => [f.label, !!f.summary])).toEqual([['P0', false]]);
    expect(lowered('red-team', reply(ZERO, '- a deferred CRITICAL: the gate drops rows.'))).toMatchObject({ ok: false, downgraded: ['red-team#1'] });
  });
});

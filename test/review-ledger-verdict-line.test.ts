/**
 * GSTA-258 L4 addendum: the collector raised the native reader's own verdict line to CRITICAL. On #3901 (pass 2, gstack 1.94
 * branch) "There are three low-severity findings, all FIXABLE, and none blocks." collected as a blocker beside the three
 * findings it summarizes, each of which already said "Severity: Low. Blocks: no". Excerpt of that captured output below.
 */
import { describe, expect, test } from 'bun:test';
import { parseFindings } from '../lib/review-ledger';

const CAPTURED_3901_P2 = [
  'REVIEWED_TREE: 7be72149fbd6d1b8e713c7c42ef4cd9ba6373e20 /workspace/gstack',
  '',
  'I found no blocking defects in this range. There are three low-severity findings, all FIXABLE, and none blocks.',
  '',
  '### Findings',
  '',
  '1. **The remote-gate route hint ignores `--no-ci-carry`** (`lib/pregate/checks/lanes.ts`, the `route` condition). The hint prints whenever `remote_gate_runs` is declared. FIXABLE. Severity: Low. Blocks: no.',
  '',
  'Recommendation: Ship as-is.',
].join('\n');

const labels = (out: string, reader = 'adversarial-native') => parseFindings(reader, out, true).map(f => f.label);

describe('native verdict line (collector severity inflation)', () => {
  test('the captured #3901 verdict line stays FIXABLE; the finding keeps its own Severity: Low', () => {
    expect(labels(CAPTURED_3901_P2)).toEqual(['FIXABLE', 'Low']);
  });

  test('negative controls: a line that says something blocks, names a file:line, or leads with FIXABLE is still CRITICAL', () => {
    expect(labels('Three findings are FIXABLE, and one blocks.')).toEqual(['CRITICAL']);
    expect(labels('The token leak in log.ts:3 is FIXABLE, and none of the others blocks.')).toEqual(['CRITICAL']);
    expect(labels('FIXABLE: none blocks the merge but the cache key drops the tree.')).toEqual(['CRITICAL']);
    expect(labels('- FIXABLE, and nothing blocks')).toEqual(['CRITICAL']);
  });

  // ggstack#71 (GGST-15, gstack 1.94.4.0, gate-class plan): four identically shaped native findings, the first labeled CRITICAL
  // because its Severity field followed a closing quote ('… its base." Severity: Low'). Excerpt of findings 1 and 2, as returned.
  test('ggstack#71: a Severity field after a closing quote is still the finding\'s own field', () => {
    const out = ['## Findings', '', "**1. The CHANGELOG describes the \"behind main\" rule wrongly (CHANGELOG.md:10).** It says \"a pull request that doesn't contain main's tip runs the suite here as before.\" gstack's actual rule is different: the run's merge-commit tree must equal the head's tree. That means the head had to contain its base as it was when CI ran, and that base isn't always main (stacked PRs). Nothing in `findCarry` or `verifyRun` compares against main's current tip, so a run from before main moved still carries. /ship's own merge of the base usually changes the tree before this matters, but the text states a guarantee the code doesn't make. FIXABLE: reword it to something like \"a pull_request run made while the branch was behind its base.\" Severity: Low. Blocks: no", '', "**2. `files` is a static file listing, and run.sh skips Godot silently (test.yml:46, pregate.json:7).** tree.json's `files` comes from the same `ls -1 test/*.sh test/*.py test/*.gd` as the inventory, so the coverage check passes by construction. The receipt's `tests=9` counts files, not tests. run.sh prints SKIP and exits 0 when `$GODOT` isn't executable or neither `xvfb-run` nor `DISPLAY` is available. Web has `REQUIRE_WEB`, but nothing equivalent makes a missing Godot fail. Today the Godot and xvfb install steps fail hard, so nothing falsely carries. If a later workflow edit makes either step soft, CI would still list the `.gd` tests as covered. A local run without Godot skips them the same way, so the carry is never weaker than the lane it replaces. FIXABLE: add `REQUIRE_GODOT=1`, or fail the record step when the run.sh output contains `test: SKIP`. Severity: Low. Blocks: no", '', 'Recommendation: Ship as-is.'].join('\n');
    expect(labels(out)).toEqual(['Low', 'Low']);
    expect(labels('1. **Wording (a.md:3).** FIXABLE: say \'the base\'. Severity: Low. Blocks: no')).toEqual(['Low']);
    expect(labels('1. **Wording (a.md:3).** FIXABLE: say \u201cthe base.\u201d Severity: Low. Blocks: no')).toEqual(['Low']);
    expect(labels('1. **Data loss (a.ts:3).** FIXABLE: guard it." Severity: Low. Blocks: yes')).toEqual(['CRITICAL']);
  });

  test('a stated Blocks field on the line wins: Blocks: yes stays CRITICAL', () => {
    expect(labels('All FIXABLE, none blocks. Blocks: yes')).toEqual(['CRITICAL']);
  });
});

// FOUN-298 (founderstar#926, gstack 1.99.1.0): the native reader's verdict line counted its findings at a severity and tagged them
// FIXABLE ("I found nothing that blocks. There are three Low findings, all FIXABLE, ..."), which neither the FIXABLE-only verdict line
// nor the closing summary covered, so it collected as CRITICAL and the receipt said blocking_found=1. Excerpt of that output.
const CAPTURED_FOUN298_P1 = [
  'REVIEWED_TREE: 139756ffddaf11a8ca20037b5844e1f68d829a62 /workspace/founderstar',
  '',
  'I found nothing that blocks. There are three Low findings, all FIXABLE, and none can change outcomes, draws or save replay.',
  '',
  '**Findings**',
  '',
  '1. **A meeting take is checked against a different line than the one it replaces at runtime.** `_validate_takes` (content.gd ~1160) compares a take\'s slots with the voice\'s `lines.open`. No take has slots today, so this can\'t happen yet. FIXABLE: validate takes against each stock `open_*` line with `Meeting.slots`. Severity: Low. Blocks: no.',
  '',
  '2. **Which typed line shows depends on the stock line\'s text being unique.** Both `typed_line` (game.gd ~7101) and `_demo_line` (game.gd ~12476) find the drawn line\'s position with `stock.find(line)`. There are no duplicates today. FIXABLE: reject duplicate stock lines in `_validate_shadow`. Severity: Low. Blocks: no.',
  '',
  '3. **Some new support has no content behind it.** `TYPED_POOLS` and five call sites send `sideways`, `polite`, `maybe`, `paid` and `callback` through `typed_line`. INVESTIGATE: either fill these pools in a content follow-up or drop them from `TYPED_POOLS`. Severity: Low. Blocks: no.',
  '',
  'Recommendation: Ship as-is because the strongest finding is the take-validation mismatch at meeting.gd:36.',
].join('\n');

describe('native verdict line that counts its findings at a severity (FOUN-298)', () => {
  test('the captured FOUN-298 verdict line collects at its counted Low on both classes, never CRITICAL', () => {
    expect(labels(CAPTURED_FOUN298_P1)).toEqual(['Low', 'Low', 'Low', 'Low']);
    expect(parseFindings('adversarial-native', CAPTURED_FOUN298_P1, false).map(f => f.label)).toEqual(['Low', 'Low', 'Low', 'Low']);
    expect(parseFindings('adversarial-native', CAPTURED_3901_P2, false).map(f => f.label)).toEqual(['FIXABLE', 'Low']);
  });

  test('the no-blocker clause is read in its common phrasings, with or without a counted severity', () => {
    const denials = ['nothing that blocks', 'nothing blocking', 'nothing which would block', 'none of which blocks', 'none of them is a blocker',
      'no finding that would block', 'no blockers', 'no blocking issues', 'nothing here blocks', 'none blocks', 'neither is blocking'];
    for (const d of denials) {
      expect([d, labels(`I found ${d}. There are two Low findings, all FIXABLE.`)]).toEqual([d, ['Low']]);
      expect([d, labels(`Two findings, both FIXABLE, and ${d}.`)]).toEqual([d, ['FIXABLE']]);
    }
    expect(labels('There are three findings, all FIXABLE, but none blocks.')).toEqual(['FIXABLE']);
    expect(labels('Nothing that blocks: one Medium and two Low findings, all FIXABLE.')).toEqual(['Medium']);
    expect(labels('Three Low findings, all FIXABLE, and nothing blocks.')).toEqual(['Low']);
    expect(labels('Two Low findings, all FIXABLE; none of them would block.')).toEqual(['Low']);
  });

  test('a looping reader\'s very long count line is not read as a verdict line and collects as CRITICAL', () => {
    expect(labels(`I found nothing that blocks. There are ${'three Low and '.repeat(5000)}two Low findings, all FIXABLE.`)).toEqual(['CRITICAL']);
  });

  test('a counted severity is kept as written, never lowered', () => {
    expect(labels('I found nothing that blocks. There are three High findings, all FIXABLE.')).toEqual(['High']);
    expect(labels('I found nothing that blocks. There are two CRITICAL findings, all FIXABLE.')).toEqual(['CRITICAL']);
  });

  test('negative controls: blockers, exceptions, named findings and mixed text still collect as CRITICAL', () => {
    expect(labels('CRITICAL: the token leak in log.ts:3 ships the API key.')).toEqual(['CRITICAL']);
    expect(labels('1. **The cache key drops the tree (key.ts:3).** FIXABLE: key on the tree hash.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing that blocks except the token leak, and it is FIXABLE. There are two Low findings.')).toEqual(['CRITICAL']);
    expect(labels('Apart from the token leak, nothing that blocks; three Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('Nothing that blocks, but the cache key drops the tree; three Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('I found one blocker. There are three Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('Nothing else blocks. Blocks: the cache key drops the tree, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing that blocks. One finding blocks the merge: three Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing that blocks. The cache key drops the reviewed tree, FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing that blocks. Three Low findings, all FIXABLE; the token leak in log.ts:3 is FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing that blocks. There are two Low findings, all FIXABLE. Blocks: yes')).toEqual(['CRITICAL']);
    expect(labels(['I found nothing that blocks. There are two Low findings, all FIXABLE.', '', '1. **The cache key drops the tree (key.ts:3).** FIXABLE: key on the tree hash.'].join('\n')))
      .toEqual(['Low', 'CRITICAL']);
  });

  // #4301 review (outside voice): a "nothing blocks" line that also names a blocker, in a shape the first rule missed, collected at Low.
  test('negative controls: a verdict line with any sentence beyond the verdict clauses still collects as CRITICAL', () => {
    expect(labels('I found nothing that blocks. There are three Low findings, all FIXABLE, with one exception: the migration drops user rows.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing that blocks. However, the API key is logged in plain text. There are two Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('Nothing blocks, though the API key is logged; two Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('There are two Low findings, all FIXABLE, and none of them matter though the key is logged.')).toEqual(['CRITICAL']);
    expect(labels('I found nothing that blocks. The migration drops user rows on retry. There are two Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('The migration drops user rows, but nothing blocks; two Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels(['I reviewed the migration, and apart from the dropped user rows', 'nothing that blocks; two Low findings, all FIXABLE.'].join('\n'))).toEqual(['CRITICAL']);
    expect(labels('Nothing blocking an unauthenticated caller from the admin route; two Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('There are two Low findings, all FIXABLE, and nothing blocking an unauthenticated caller from the admin route.')).toEqual(['CRITICAL']);
    expect(labels('Probably nothing blocks; two Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
    expect(labels('I think nothing should block. There are two Low findings, all FIXABLE.')).toEqual(['CRITICAL']);
  });

  // #4301 review (adversarial-native): on the relaxed class the verdict line was re-read with its joined continuation and raised again.
  test('a verdict line keeps its label on the relaxed class when a field line binds to it', () => {
    const out = ['I found nothing that blocks. There are two Low findings, all FIXABLE.', 'Severity: Low'].join('\n');
    expect(parseFindings('adversarial-native', out, false).map(f => f.label)).toEqual(labels(out));
  });
});

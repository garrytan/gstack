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

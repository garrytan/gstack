/**
 * GSTA-258 L4 addendum: the collector raised the native reader's own verdict line to CRITICAL. On #3901 (pass 2, gstack 1.94
 * branch) "There are three low-severity findings, all FIXABLE, and none blocks." collected as a blocker beside the three
 * findings it summarizes, each of which already said "Severity: Low. Blocks: no". Excerpt of that captured output below.
 */
import { describe, expect, test } from 'bun:test';
import { parseFindings, parseReply } from '../lib/review-ledger';

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

// Value: protects=lines under a reviewer's "what I checked and found sound" heading never collect as findings unless they are shaped
//   as one (GSTA-830 #4800, adversarial-native#5); fails_when=a prose line naming "Critical" and a file:line in that list blocks with
//   REVIEW_VERDICT blocking=0 (parsed=2, agrees=false); seam=lib/review-ledger.ts parseReply; no_claim=a "Summary" heading, whose
//   lines may restate the only copy of a finding, keeps collecting
describe('GST-4111 fix 4: a sound-checks section is not a findings section', () => {
  const SOUND = ['NO FINDINGS', '', '## What I checked and found sound', '', '- The Critical path in lib/foo.ts:42 handles the empty case.',
    '- Critical branch at lib/bar.ts:9 is covered by test/bar.test.ts.', '', 'REVIEW_VERDICT: blocking=0'].join('\n');
  test('every reader role parses no finding from a sound-checks list and the verdict agrees', () => {
    for (const role of ['specialist', 'red-team', 'adversarial-native', 'outside-voice', 'targeted']) {
      const r = parseReply(role, SOUND, true, true);
      expect(r.findings, role).toEqual([]);
      expect(r.verdict, role).toEqual({ state: 'valid', parsed: 0, declared: 0, agrees: true });
    }
    for (const heading of ['### What holds up', '**Verified:**', '## Checked and found clean', '## Looks good']) {
      expect(parseReply('specialist', SOUND.replace('## What I checked and found sound', heading), true, true).findings, heading).toEqual([]);
    }
  });
  test('negative controls: a labelled finding inside the section, a findings heading after it, and a Summary heading still collect', () => {
    const inside = ['## What I checked and found sound', '', '- The Critical path in lib/foo.ts:42 is fine.', '- CRITICAL: lib/auth.ts:7 skips the token check.', '- lib/q.ts:3 drops rows. Blocks: yes'].join('\n');
    expect(parseReply('specialist', inside).findings.map(f => f.label)).toEqual(['CRITICAL', 'CRITICAL']);
    const after = ['## What I checked and found sound', '', '- The Critical path in lib/foo.ts:42 is fine.', '', '## Findings', '', '- The Critical path in lib/foo.ts:50 drops the lock.'].join('\n');
    expect(parseReply('outside-voice', after).findings.map(f => f.raw)).toEqual(['- The Critical path in lib/foo.ts:50 drops the lock.']);
    const summary = ['## Summary', '', '- The Critical path in lib/foo.ts:42 drops the lock.'].join('\n');
    expect(parseReply('red-team', summary).findings.map(f => f.label)).toEqual(['Critical']);
    const lead = ['**What holds up.**', '', '- The Critical path in lib/foo.ts:42 is fine.', '', '**Finding 1 (FIXABLE): the lock in lib/foo.ts:50 is never released.** It leaks.', '1. CRITICAL lib/foo.ts:60 drops rows'].join('\n');
    expect(parseReply('adversarial-native', lead).findings.map(f => f.raw.slice(0, 13))).toEqual(['**Finding 1 (', '1. CRITICAL l']);
    const broken = ['## What I verified was broken', '', '- Dropped writes at lib/cache.ts:42 when the queue fills.', '  Severity: High', '  Blocks: yes'].join('\n');
    expect(parseReply('outside-voice', broken).findings.map(f => f.raw)).toEqual([expect.stringContaining('lib/cache.ts:42')]);
    expect(parseReply('specialist', ['## What I verified', '', '- src/a.ts:42 null deref crashes the worker on empty input (High)'].join('\n')).findings.map(f => f.label)).toEqual(['High']);
    const fielded = ['## What I checked and found sound', '', '- Dropped writes at lib/cache.ts:42 when the queue fills.', 'Severity: High', 'Blocks: yes'].join('\n');
    expect(parseReply('specialist', fielded).findings.map(f => f.raw)).toEqual([expect.stringContaining('lib/cache.ts:42')]);
    expect(parseReply('specialist', ['## Verified issues', '', '- The Critical path in lib/foo.ts:42 drops the lock.'].join('\n')).findings).toHaveLength(1);
  });
});

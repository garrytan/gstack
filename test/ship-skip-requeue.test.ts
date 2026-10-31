import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ALL_HOST_CONFIGS } from '../hosts';
import { generateAdversarialStep } from '../scripts/resolvers/outside-voice-steps';
import { generateCrossReviewDedup, generateSharedCodeReuse } from '../scripts/resolvers/review-scope';
import { HOST_PATHS } from '../scripts/resolvers/types';
import { expectMentions } from './helpers/prompt-structure';

const compact = (text: string) => text.replace(/\s+/g, ' ');
const review = compact(readFileSync(new URL('../ship/sections/review-army.md.tmpl', import.meta.url), 'utf8'));

describe.each(ALL_HOST_CONFIGS.map(({ name }) => name))('%s ship skip/requeue contract', host => {
  const ctx = { host, skillName: 'ship', tmplPath: '', paths: HOST_PATHS[host] };
  const dedup = compact(generateCrossReviewDedup(ctx));
  const adversarial = compact(generateAdversarialStep(ctx));
  const finish = adversarial.slice(adversarial.indexOf('### Finish the adversarial phase'));

  test('unchanged explicit skips are matched before the actionable queue drives a repeat', () => {
    const match = finish.indexOf("Apply Step 9.3's matching procedure");
    expect(match).toBeGreaterThan(-1);
    expect(match).toBeLessThan(finish.indexOf('2. **Fixes queued'));
    expectMentions(finish, [['only', 'unmatched', 'reopened']], 'finish');
    expect(dedup).toContain('Only explicit `skipped` actions qualify');
    expectMentions(dedup, [['do not', 'unrelated', 'finding']], 'dedup');
    const steps = ['1. **Validate severity.**', '2. **Read decisions.**',
      '3. **Match evidence.**', '4. **Match shared-code structurally.**', '5. **Apply dispositions.**'];
    const positions = steps.map(step => dedup.indexOf(step));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(review).toContain('Classify only unmatched or reopened findings as AUTO-FIX or ASK');
  });

  test('dedup and persistence include queued sources and preserve the explicit decision', () => {
    expect(review).toContain('preserve `advisory`, `evidence_paths` and `helper_target`');
  });

  test('working-tree changes and new evidence reopen matching identities', () => {
    expect(dedup).toContain('git diff --name-only <prior-review-commit>');
    expect(dedup).not.toContain('git diff --name-only <prior-review-commit> HEAD');
    expect(dedup).toContain('honoring later user decisions');
    expect(dedup).toContain('as a shortlist, not proof');
  });

  test('fixed regressions and missing Skip proof are not suppressed', () => {
    expect(dedup).toContain('never `fixed`, `auto-fixed` or unanswered questions');
    expectMentions(dedup, [['not', 'comparisons', 'suppression']], 'dedup');
    expect(finish).toContain('Keep scoped approvals');
    expect(finish).toContain('never jump to 9.3 or mint a late REVIEW_START');
  });

  test('shared-code and advisory collisions retain stricter identity checks', () => {
    expect(dedup).toContain('they cannot suppress defects');
    expect(dedup).toContain('remove `advisory`, never downgrade severity');
    expect(dedup).toContain('Reject contradictory saved decisions');
    expectMentions(dedup, [['never', 'metadata', 'ordinary']], 'dedup');
    expectMentions(dedup, [['cannot', 'prior-review', 'additionally']], 'dedup');
    const checker = compact(generateSharedCodeReuse(ctx));
    expect(checker).toContain('Only `reusable: true` permits suppression');
    expectMentions(checker, [['do not', 'snapshot', 'coverage']], 'checker');
  });

  test('skipped defects stay unresolved and required failures stay failed', () => {
    expectMentions(dedup, [['not', 'unresolved', 'defects']], 'dedup');
    expect(dedup).toContain('Keep required-probe failures failed');
    expectMentions(review, [['not', 'acceptance', 'skipping']], 'review');
    expectMentions(review, [['never', 'inconclusive', 'required']], 'review');
    expect(review).toContain('VERIFY_RESULT stays fail');
    expectMentions(adversarial, [['do not', 'acknowledged', 'findings']], 'adversarial');
  });

  test('fresh review after edits, native coverage and cycle limits remain required', () => {
    expect(finish).toContain('**Required native review incomplete:** STOP');
    expectMentions(finish, [['before', 'pending', 'insert']], 'finish');
    expectMentions(finish, [['never', 'three-cycle', 'resets']], 'finish');
    expect(review).toContain('Set CYCLES to 0 on first entry only');
    expect(review).toContain('Increment CYCLES once if fixes were applied');
    expectMentions(review, [['do not', 'fourth', 'fixing']], 'review');
    expectMentions(finish, [['never', 'preparation', 'directly']], 'finish');
  });
});

test('ship invocation matching does not change standalone review routing', () => {
  const ctx = { host: 'claude' as const, skillName: 'review', tmplPath: '', paths: HOST_PATHS.claude };
  expect(generateCrossReviewDedup(ctx)).not.toContain('5. **Apply dispositions.**');
  expect(generateAdversarialStep(ctx)).not.toContain('### Finish the adversarial phase');
});

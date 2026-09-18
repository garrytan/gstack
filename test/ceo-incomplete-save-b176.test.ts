/** Free replay only. Both actual paid failures remain rejected; completions are synthetic. */
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { createCeoPaymentFindingCounter, ceoPaymentFinding } from './helpers/ceo-payment-findings';
import { nativePlanCallFingerprint, ceoFirstReviewAUQ } from './helpers/claude-pty-runner';
import fixture from './fixtures/ceo-incomplete-save-b176.json';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const replaceOnce = (value: string, from: string, to: string) => {
  expect(value.split(from)).toHaveLength(2);
  return value.replace(from, to);
};
for (const [attemptIndex, capture] of fixture.captures.entries()) {
  const addSavedNativeFacts = (plan: string, omitLastCons = false) => {
    const paragraphs = capture.call.questions[0]!.options.map((option, i) => {
      // Only saved formatting is synthetic. Facts come from actual native descriptions;
      // effort S / risk low are already present in the original saved comparison.
      const label = option.label.replace(/^[A-D][.):]\s*/i, '').replace(/\s*\((?:recommended|as planned)\)$/i, '');
      const [pros, ...cons] = option.description!.split('❌');
      expect(pros).toContain('✅'); expect(cons).toHaveLength(1);
      return `**${String.fromCharCode(65 + i)}) ${label}.** Effort S. Risk low. Pros: ${pros!.replaceAll('✅', '').trim()}` +
        (omitLastCons && i === 2 ? '' : ` Cons: ${cons[0]!.trim()}`);
    }).join('\n\n');
    return replaceOnce(plan, '### R2 commitment comparison', paragraphs + '\n\n### R2 commitment comparison');
  };
  const citeSource = (plan: string) => plan.replace(/^(\| R1[^|]+\|\s*)([^|]+)(\|)/m,
    (whole, prefix, evidence, end) => evidence.includes('PLAN.md') ? whole : prefix + 'PLAN.md: ' + evidence + end);
  const scenarios = [
    { name: 'actual incomplete save stays rejected', expected: 'Unsupported', plan: () => capture.savedPlan },
    { name: 'synthetic full facts still require row source', expected: attemptIndex === 0 ? 'recorded' : 'Unsupported', plan: () => addSavedNativeFacts(capture.savedPlan) },
    { name: 'synthetic source alone cannot replace full facts', expected: 'Unsupported', plan: () => citeSource(capture.savedPlan) },
    { name: 'synthetic complete facts and source count the same R1', expected: 'recorded', plan: () => addSavedNativeFacts(citeSource(capture.savedPlan)) },
    { name: 'synthetic missing con stays rejected', expected: 'Unsupported', plan: () => addSavedNativeFacts(citeSource(capture.savedPlan), true) },
    { name: 'synthetic archived comparison stays rejected', expected: 'Unsupported', plan: () => replaceOnce(addSavedNativeFacts(citeSource(capture.savedPlan)), '### R1 commitment comparison', '### Archived R1 commitment comparison') },
    { name: 'synthetic complete save without ACK stays rejected', expected: 'Invalid', missingAck: true, plan: () => addSavedNativeFacts(citeSource(capture.savedPlan)) },
  ];
  for (const scenario of scenarios) test(`b176 paired attempt ${attemptIndex + 1}: ${scenario.name}`, () => {
    expect(sha(capture.seed)).toBe(capture.sourceRecord.sha256);
    expect(sha(capture.savedPlan)).toBe(capture.savedRecord.sha256);
    const savedPlan = scenario.plan(), call = structuredClone(capture.call);
    if (scenario.missingAck) call.answered = false;
    const fp = nativePlanCallFingerprint(call, 1, true);
    // Existing proposed tests cannot earn the separate seeded "no tests" finding.
    expect(ceoPaymentFinding(fp, capture.seed, savedPlan)).toBeNull();
    const counter = createCeoPaymentFindingCounter(capture.seed, () => savedPlan, ceoFirstReviewAUQ);
    if (scenario.expected === 'recorded') {
      expect(counter.isReviewAUQ(fp, structuredClone(capture.priorCalls))).toBe(true);
      expect(counter.trace).toHaveLength(1);
      expect(counter.trace[0]).toMatchObject({ kind: 'recorded-decision', ledgerId: 'R1' });
    } else expect(() => counter.isReviewAUQ(fp, structuredClone(capture.priorCalls))).toThrow(scenario.expected);
  });
}

import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fixture from './fixtures/ceo-conditional-option-facts-c6fc.json';
import { createCeoPaymentFindingCounter, ceoPaymentFinding } from './helpers/ceo-payment-findings';
import { ceoFirstReviewAUQ, nativePlanCallFingerprint } from './helpers/claude-pty-runner';

const originalCons = 'if the prior lookup helper is library-adapter-owned it may need a small extraction into app code.';
const replaceOnce = (text: string, before: string, after: string) => {
  expect(text.split(before)).toHaveLength(2);
  return text.replace(before, after);
};
const cons = (plan: string, text: string) => replaceOnce(plan, `Cons: ${originalCons}`, `Cons: ${text}`);
const fingerprint = (index: number) => {
  const capture = fixture.captures[index]!;
  return capture.fingerprint ? structuredClone(capture.fingerprint)
    : nativePlanCallFingerprint(structuredClone(capture.nativeCall), capture.observedAtMs, false);
};
type Fingerprint = ReturnType<typeof fingerprint>;
function count(plan = fixture.captures[1]!.savedPlan, change?: (fp: Fingerprint) => void) {
  let saved = fixture.captures[0]!.savedPlan;
  const counter = createCeoPaymentFindingCounter(fixture.seed, () => saved, ceoFirstReviewAUQ);
  const first = fingerprint(0), second = fingerprint(1);
  expect(counter.isReviewAUQ(first, [])).toBe(true);
  expect(counter.trace).toEqual([{signature: first.signature, kind: 'recorded-decision', ledgerId: 'D1', phase: 'currentDecision: D1'}]);
  saved = plan;
  change?.(second);
  const result = counter.isReviewAUQ(second, [first.nativeCall!]);
  return {result, trace: counter.trace, second};
}

test('original c6fc D1 then D2: complete conditional option risk counts without a SQL synonym', () => {
  for (const capture of fixture.captures)
    expect(createHash('sha256').update(capture.savedPlan).digest('hex')).toBe(capture.savedSha256);
  const {result, trace, second} = count();
  expect(result).toBe(true);
  expect(ceoPaymentFinding(second, fixture.seed, fixture.captures[1]!.savedPlan)).toBeNull();
  expect(ceoFirstReviewAUQ(second)).toBe(false);
  expect(trace).toEqual([
    {signature: fingerprint(0).signature, kind: 'recorded-decision', ledgerId: 'D1', phase: 'currentDecision: D1'},
    {signature: second.signature, kind: 'recorded-decision', ledgerId: 'D2', phase: 'currentDecision: D2'},
  ]);
});

for (const text of [
  originalCons,
  'If the prior lookup helper remains library-adapter-owned, extracting it may cost extra work.',
  'unless the prior lookup helper is already application-owned, a small extraction into app code may be needed.',
  'a small extraction into app code may be needed if the prior lookup helper is library-adapter-owned.',
  'a small extraction into app code may be needed unless the prior lookup helper is already application-owned.',
  'when the prior lookup helper remains library-adapter-owned, a small extraction may be needed.',
]) test(`a current option can state its conditional cost: ${text}`, () => {
  expect(count(cons(fixture.captures[1]!.savedPlan, text)).result).toBe(true);
});

for (const [name, change] of Object.entries({
  'withdrawn option': (p: string) => cons(p, originalCons + ' This option is withdrawn.'),
  'resolved decision': (p: string) => cons(p, originalCons + ' This decision is resolved.'),
  'conditional clause cannot shelter withdrawal': (p: string) => cons(p, 'if the helper needs extraction, this option is no longer current.'),
  'quoted withdrawal remains active when explicitly attributed': (p: string) => cons(p, originalCons + ' This option is now "withdrawn".'),
  'historical fact': (p: string) => cons(p, 'Previously the helper needed extraction.'),
  'conditional historical fact': (p: string) => cons(p, 'if previously the helper needed extraction.'),
  'missing current comparison': (p: string) => p.slice(0, p.indexOf('## currentDecision: D2')),
  'wrong current comparison identity': (p: string) => replaceOnce(p, '## currentDecision: D2', '## currentDecision: OTHER'),
  'historical comparison': (p: string) => replaceOnce(p, '## currentDecision: D2', '## Historical currentDecision: D2'),
  'foreign source': (p: string) => p.replaceAll('PLAN.md', 'OTHER.md'),
  'missing cons field': (p: string) => replaceOnce(p, `Cons: ${originalCons}`, `Notes: ${originalCons}`),
  'missing risk field': (p: string) => replaceOnce(p, 'Risk low. Pros: injection impossible', 'Exposure low. Pros: injection impossible'),
  'duplicated effort field': (p: string) => replaceOnce(p, 'Risk low. Pros: injection impossible', 'Effort S. Risk low. Pros: injection impossible'),
  'conditional risk scalar': (p: string) => replaceOnce(p, 'Risk low. Pros: injection impossible', 'Risk if approved, low. Pros: injection impossible'),
  'conditional effort scalar': (p: string) => replaceOnce(p, 'Effort S (human ~1 hour / CC ~5 min). Risk low.', 'Effort if approved, S. Risk low.'),
  'conditional benefit claim': (p: string) => replaceOnce(p, 'Pros: injection impossible by construction;', 'Pros: if approved, injection impossible by construction;'),
})) test(`a conditional cost cannot validate ${name}`, () => {
  expect(() => count(change(fixture.captures[1]!.savedPlan))).toThrow();
});

for (const [name, change] of Object.entries({
  'failed ACK': (fp: Fingerprint) => { fp.nativeCall!.failed = true; },
  'missing ACK': (fp: Fingerprint) => { fp.nativeCall!.answered = false; fp.nativeCall!.answers = {}; },
  'foreign signature': (fp: Fingerprint) => { fp.signature = 'foreign:call'; },
  'unoffered selection': (fp: Fingerprint) => { fp.nativeCall!.answers = {[fp.nativeCall!.questions[0]!.question]: 'Other'}; },
  'foreign option contract': (fp: Fingerprint) => {
    const q = fp.nativeCall!.questions[0]!;
    q.options[0]!.label = 'A) Publish account credentials';
    q.options[0]!.description = 'Effort S, risk high. ✅ Easier access. ✅ Fewer prompts. ❌ Exposes accounts.';
    fp.options[0]!.label = q.options[0]!.label; fp.nativeCall!.answers = {[q.question]: q.options[0]!.label};
  },
})) test(`current conditional costs preserve ${name} rejection`, () => {
  expect(() => count(fixture.captures[1]!.savedPlan, change)).toThrow();
});

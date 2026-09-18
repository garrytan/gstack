import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fixture from './fixtures/ceo-source-attribution-6aef.json';
import { ceoPaymentFinding, createCeoPaymentFindingCounter } from './helpers/ceo-payment-findings';
import type { AskUserQuestionFingerprint } from './helpers/claude-pty-runner';

const savedPlan = fixture.savedPlanSegments.map(segment => segment.text).join('\n');
const sourceLine = savedPlan.split('\n').find(line => line.startsWith('Source under review:'))!;
const declaration = (value: string) => savedPlan.replace(sourceLine, value);
const fingerprint = (): AskUserQuestionFingerprint => structuredClone(fixture.fingerprint);
const count = (plan = savedPlan, fp = fingerprint()) => {
  const counter = createCeoPaymentFindingCounter(fixture.seed, () => plan, () => false);
  const result = counter.isReviewAUQ(fp);
  return { result, counter };
};

test('captured source, full ledger and literal native packet retain the actual R2 ownership', () => {
  for (const segment of fixture.savedPlanSegments) {
    expect(createHash('sha256').update(segment.text).digest('hex')).toBe(segment.sha256);
  }
  const call = fixture.fingerprint.nativeCall;
  expect(fixture.fingerprint.signature).toBe(`${call.sessionId}:${call.toolUseId}`);
  expect(call.answered).toBe(true);
  expect(call.failed).toBe(false);
  const question = call.questions[0]!;
  expect(savedPlan).toContain(`Question: ${question.question}\nHeader: ${question.header}`);
  for (const option of question.options) expect(savedPlan).toContain(`${option.label}\n${option.description}`);
  expect(savedPlan).toContain('| raw SQL fragment | pending |');
  expect(ceoPaymentFinding(fixture.fingerprint, fixture.seed, savedPlan)).toBeNull();
  const { result, counter } = count();
  expect(result).toBe(true);
  expect(counter.trace).toMatchObject([{ kind: 'recorded-decision', ledgerId: 'R2' }]);
  expect(() => counter.isReviewAUQ(fingerprint(), [call])).toThrow(/duplicated/);
});

// These labels all assert one current source. They must share both acceptance
// and foreign/ambiguous source rules; a label-specific exception is insufficient.
const labels = ['Source', 'Source plan', 'Source under review', 'Source plan under review',
  'Source document', 'Source file under review', 'Plan under review', 'Document under review',
  'File under review', 'Reviewed plan', 'Review target plan', 'Input plan'];
for (const label of labels) {
  test(`current source declaration accepts ${label}`, () => {
    expect(count(declaration(`${label}: \`PLAN.md\` (repo root, commit e4bae55).`)).result).toBe(true);
  });
  for (const [name, value] of Object.entries({
    foreign: `${label}: OTHER.md.`,
    duplicate: `${label}: PLAN.md.\n\nSource under review: PLAN.md.`,
    conflict: `Source plan: PLAN.md.\n\n${label}: OTHER.md.`,
    'quoted conflicting field': `Source plan: PLAN.md.\n\n${label}: "OTHER.md".`,
    'missing conflicting field': `Source plan: PLAN.md.\n\n${label}:`,
    'negated conflicting field': `Source plan: PLAN.md.\n\n${label}: not PLAN.md.`,
    quoted: `> ${label}: PLAN.md.\n`,
    literal: `"${label}: PLAN.md."`,
    code: `\`\`\`md\n${label}: PLAN.md.\n\`\`\``,
    historical: `## History\n\n${label}: PLAN.md.\n\n## Current review`,
    withdrawn: `## Withdrawn attribution\n\n${label}: PLAN.md.\n\n## Current review`,
    conditional: `${label}: PLAN.md if the user approves it.`,
    inactive: `${label}: PLAN.md, but this source is no longer current.`,
  })) test(`${label} rejects ${name} attribution`, () => {
    expect(() => count(declaration(value))).toThrow(/cannot exclude/);
  });
}

for (const [name, value] of Object.entries({
  'paragraph metadata after a sentence': 'Working plan for the current CEO review. Source under review: PLAN.md (repo root).',
  'multiple metadata lines': 'Working plan for the current CEO review.\nSource under review: PLAN.md (repo root).\nMode: HOLD SCOPE.',
  'inline source formatting': '**Source under review:** `PLAN.md` (repo root).',
  'copied source metadata': 'Source under review: PLAN.md (copied into CLAUDE.md as the session request).',
  'byte-identical source copy metadata': 'Source under review: PLAN.md (byte-identical to the plan embedded in CLAUDE.md).',
  'prior source in separate inactive scope': '## History\n\nSource under review: OTHER.md.\n\n## Current source\n\nSource under review: PLAN.md.',
  'nested inactive scope closes': '## Metadata\n\n### Archived source\n\nSource plan: OTHER.md.\n\n### Current source\n\nSource under review: PLAN.md.',
})) test(`current attribution supports ${name}`, () => expect(count(declaration(value)).result).toBe(true));

for (const value of [
  'PLAN.md or OTHER.md', 'PLAN.md and OTHER.md', 'PLAN.md versus OTHER.md',
  'PLAN.md / OTHER.md', 'PLAN.md, OTHER.md', 'PLAN.md; OTHER.md',
  'PLAN.md (repo root) or OTHER.md', 'PLAN.md rather than OTHER.md',
  'PLAN.md instead of OTHER.md', 'PLAN.md or PLAN.md',
  'PLAN.md & OTHER.md', 'PLAN.md + OTHER.md', 'PLAN.md vs. OTHER.md',
  'PLAN.md (repo root; or OTHER.md)', 'PLAN.md at repo root & OTHER.md',
  'PLAN.md (copied into CLAUDE.md or OTHER.md)',
]) test(`a compound current source is not reduced to its first filename: ${value}`, () => {
  expect(() => count(declaration(`Source under review: ${value}.`))).toThrow(/cannot exclude/);
});

for (const [name, value] of Object.entries({
  absent: '',
  'unrelated filename': 'The review happens to mention PLAN.md.',
  'quoted source filename': 'Source under review: "PLAN.md".',
  'conditional prefix': 'If approved, Source under review: PLAN.md.',
  'historical paragraph prefix': 'Historical metadata. Source under review: PLAN.md.',
  'history paragraph prefix': 'History: earlier review. Source under review: PLAN.md.',
  'negative prefix': 'Not the Source under review: PLAN.md.',
  'negated source': 'Source under review: not PLAN.md.',
  'conditional suffix': 'Source under review: PLAN.md would be used after approval.',
  'current source withdrawn later in paragraph': 'Source under review: PLAN.md. This source is withdrawn.',
  'foreign declaration later in paragraph': 'Source plan: PLAN.md. Source under review: OTHER.md.',
  'duplicate declaration later in paragraph': 'Source under review: PLAN.md. Input plan: PLAN.md.',
})) test(`pending R2 rejects ${name}`, () => expect(() => count(declaration(value))).toThrow(/cannot exclude/));

for (const [name, mutate] of Object.entries({
  'foreign row source': (plan: string) => plan.replace('from `request.params.userId` (PLAN.md:16-31, 110-112)', 'from `request.params.userId` (OTHER.md:16-31, 110-112)'),
  'missing row source': (plan: string) => plan.replace('from `request.params.userId` (PLAN.md:16-31, 110-112)', 'from `request.params.userId` (no evidence)'),
  'withdrawn row': (plan: string) => plan.replace('| R2 (backend owner)', '| R2 (withdrawn backend owner)'),
  'compound row status': (plan: string) => plan.replace('| raw SQL fragment | pending |', '| raw SQL fragment | pending / approved |'),
  'quoted row status': (plan: string) => plan.replace('| raw SQL fragment | pending |', '| raw SQL fragment | "pending" |'),
  'historical currentDecision': (plan: string) => plan.replace('## currentDecision (R2)', '## Historical currentDecision (R2)'),
  'different saved header': (plan: string) => plan.replace('Header: Lookup query', 'Header: Foreign lookup'),
  'different saved question': (plan: string) => plan.replace('Question: D2 — R2:', 'Question: D2 — R3:'),
  'missing full saved option': (plan: string) => plan.replace(fixture.fingerprint.nativeCall.questions[0]!.options[1]!.description, 'Summary only.'),
})) test(`source attribution does not weaken ${name}`, () => expect(() => count(mutate(savedPlan))).toThrow(/cannot exclude/));

for (const [name, mutate] of Object.entries({
  signature: (fp: ReturnType<typeof fingerprint>) => { fp.signature = 'foreign'; },
  unanswered: (fp: ReturnType<typeof fingerprint>) => { fp.nativeCall!.answered = false; },
  failed: (fp: ReturnType<typeof fingerprint>) => { fp.nativeCall!.failed = true; },
  'missing answer': (fp: ReturnType<typeof fingerprint>) => { fp.nativeCall!.answers = {}; },
  'pending answer': (fp: ReturnType<typeof fingerprint>) => { fp.nativeCall!.unansweredQuestionIndices = [0]; },
  'foreign answer': (fp: ReturnType<typeof fingerprint>) => { fp.nativeCall!.answers = { foreign: 'A' }; },
})) test(`source attribution retains native ${name} ownership rejection`, () => {
  const fp = fingerprint(); mutate(fp);
  expect(() => count(savedPlan, fp)).toThrow();
});

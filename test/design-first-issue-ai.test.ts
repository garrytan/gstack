import { expect, test } from 'bun:test';
import captured from './fixtures/design-first-issue-ai.json';
import { isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import { designStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';

const findings = captured.calls.filter(row => row.ordinal >= 3 && row.ordinal <= 7);
test.each(findings)('actual completed Design D$ordinal starts review', ({ fingerprint }) => {
  expect(isDesignCountFirstReview(fingerprint)).toBe(true);
  expect(planCountQuestionPhase(fingerprint, false, designStep0Boundary, isDesignCountFirstReview, isDesignCountSetup)).toMatchObject({ preReview: false, reviewStarted: true });
});

function first(): any { return structuredClone(findings[0]!.fingerprint); }
function question(fp: any, text: string) {
  const call = fp.nativeCall, old = call.questions[0].question;
  call.questions[0].question = text;
  call.answers = { [text]: call.answers[old] };
}
function options(fp: any, change: (q: any) => void) {
  const call = fp.nativeCall, q = call.questions[0];
  change(q);
  fp.options = q.options.map((o: any, i: number) => ({ index: i + 1, label: o.label }));
  call.answers = { [q.question]: q.options[0].label };
}

test('actual routing, learnings and future typography TODO do not start a design review', () => {
  for (const row of captured.calls.filter(row => [1, 2, 9].includes(row.ordinal)))
    expect(isDesignCountFirstReview(row.fingerprint)).toBe(false);
});

test('any offered answer and menu order can resolve a substantive finding', () => {
  for (const row of findings) {
    for (const option of row.fingerprint.nativeCall.questions[0]!.options) {
      const fp: any = structuredClone(row.fingerprint);
      fp.nativeCall.answers = { [fp.nativeCall.questions[0].question]: option.label };
      expect(isDesignCountFirstReview(fp)).toBe(true);
    }
    const fp: any = structuredClone(row.fingerprint);
    options(fp, q => q.options.reverse());
    expect(isDesignCountFirstReview(fp)).toBe(true);
  }
});

test('native completion, request identity, current answers and aligned menu are required', () => {
  for (const change of [
    (f: any) => { delete f.nativeCall; },
    (f: any) => { f.nativeCall.answered = false; },
    (f: any) => { f.nativeCall.failed = true; },
    (f: any) => { f.nativeCall.sessionId = 'foreign'; },
    (f: any) => { f.nativeCall.toolUseId = 'stale-request'; },
    (f: any) => { f.nativeQuestionIndex = 1; },
    (f: any) => { f.nativeCall.unansweredQuestionIndices = [0]; },
    (f: any) => { f.nativeCall.answers = {}; },
    (f: any) => { f.nativeCall.answers[f.nativeCall.questions[0].question] = 'not offered'; },
    (f: any) => { f.nativeCall.questions[0].question += '\nCorrection: this is a new question.'; },
    (f: any) => { f.nativeCall.answeredAt = 'invalid'; },
    (f: any) => { f.nativeCall.questions.push(structuredClone(f.nativeCall.questions[0])); },
    (f: any) => { f.nativeCall.questions[0].multiSelect = true; },
    (f: any) => { f.options.reverse(); },
    (f: any) => { f.nativeCall.questions[0].header = 'Issue 7'; },
  ]) { const fp = first(); change(fp); expect(isDesignCountFirstReview(fp)).toBe(false); }
});

test('numbered issue and all choice identifiers agree without depending on D numbering', () => {
  const fp = first(); question(fp, fp.nativeCall.questions[0].question.replace('D3 —', 'D27:'));
  expect(isDesignCountFirstReview(fp)).toBe(true);
  for (const change of [
    (q: any) => { q.options[0].label = q.options[0].label.replace('1A:', '2A:'); },
    (q: any) => { q.options[1].label = q.options[0].label; },
  ]) { const f = first(); options(f, change); expect(isDesignCountFirstReview(f)).toBe(false); }
});

test('a design Issue heading cannot borrow review content for setup, navigation or future work', () => {
  for (const title of [
    'Should we run outside design voices now?',
    'How should we configure design review routing?',
    'What review should run after the design review?',
    'Should we record an app-wide typography TODO?',
    'What type scale will form labels use after a future redesign?',
  ]) {
    const fp = first(); question(fp, fp.nativeCall.questions[0].question.replace(/Issue 1: [^\n]+/, `Issue 1: ${title}`));
    expect(isDesignCountFirstReview(fp)).toBe(false);
  }
  for (const replacement of ['PLAN.md onboarding', 'PLAN.md post-review TODO', 'PLAN.md engineering review']) {
    const fp = first(); question(fp, fp.nativeCall.questions[0].question.replace('PLAN.md design review', replacement));
    expect(isDesignCountFirstReview(fp)).toBe(false);
  }
});

test('quoted, hypothetical and withdrawn declarations cannot start the phase', () => {
  for (const change of [
    (text: string) => `Example: ${text}`,
    (text: string) => `\`\`\`text\n${text}\n\`\`\``,
    (text: string) => text.replace('ELI10: ', 'ELI10: Example only: '),
    (text: string) => `${text}\nCorrection: that question was hypothetical and is withdrawn.`,
    (text: string) => text.replace('How should Save', 'If we later proceed, how should Save'),
  ]) { const fp = first(); question(fp, change(fp.nativeCall.questions[0].question)); expect(isDesignCountFirstReview(fp)).toBe(false); }
});

test('concrete design conformance and an opposed current violation belong to different offered choices', () => {
  for (const change of [
    (q: any) => { q.options.forEach((o: any) => { o.description = 'This is an available option.'; }); },
    (q: any) => { q.options[0].description = '✅ Example only: ' + q.options[0].description; },
    (q: any) => { q.options[2].description = 'No current design gap remains.'; },
    (q: any) => { q.options[0].label = '1A: Run primary review (recommended)'; },
  ]) { const fp = first(); options(fp, change); expect(isDesignCountFirstReview(fp)).toBe(false); }
});

import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
test('the new exact public fixture and controls select only the design count workflow', () => {
  for (const path of ['test/design-first-issue-ai.test.ts', 'test/fixtures/design-first-issue-ai.json'])
    expect(selectTests([path], E2E_TOUCHFILES, []).selected).toEqual(['plan-design-finding-count']);
});

test('the assessment asserts a current defect, preserving conditional stakes and quoted history', () => {
  for (const change of [
    (s: string) => s.replace('ELI10: The header', 'ELI10: Suppose the header'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, "ELI10: '$1'"),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (s: string) => s.replace('\nStakes if we pick wrong:', ' This issue is withdrawn.\nStakes if we pick wrong:'),
    (s: string) => s.replace('\nStakes if we pick wrong:', ' We have resolved this finding.\nStakes if we pick wrong:'),
  ]) { const fp = first(); question(fp, change(fp.nativeCall.questions[0].question)); expect(isDesignCountFirstReview(fp)).toBe(false); }
  const conditional = first(); question(conditional, conditional.nativeCall.questions[0].question.replace('Stakes if we pick wrong:', 'Stakes if we pick wrong: If we leave this unchanged,'));
  expect(isDesignCountFirstReview(conditional)).toBe(true);
  const history = first(); question(history, history.nativeCall.questions[0].question.replace('\nStakes if we pick wrong:', ' The old report claimed "We have resolved this finding.", but that claim was wrong.\nStakes if we pick wrong:'));
  expect(isDesignCountFirstReview(history)).toBe(true);
});

test('an explicit no-current-issue assessment cannot borrow the offered fixes', () => {
  const fp = first();
  question(fp, fp.nativeCall.questions[0].question.replace(/^ELI10: .+$/m, 'ELI10: The header shows four clearly differentiated buttons. DESIGN.md is fully followed. No current issue remains.'));
  expect(isDesignCountFirstReview(fp)).toBe(false);
});

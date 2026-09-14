import { describe, expect, test } from 'bun:test';
import captured from './fixtures/design-compact-primary-aw-call.json';
import { nativePlanCallFingerprint, designStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const fresh = () => structuredClone(captured.call) as NativePlanQuestionCall;
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const accepted = (call: NativePlanQuestionCall) => isDesignCountFirstReview(fingerprint(call));
type Question = NativePlanQuestionCall['questions'][number];
function change(edit: (q: Question, c: NativePlanQuestionCall) => void) {
  const call = fresh(), q = call.questions[0]!;
  edit(q, call);
  call.answers = { [q.question]: q.options[0]!.label };
  return call;
}

describe('compact numbered design decision fields', () => {
  test('the exact acknowledged primary issue starts review without changing the call', () => {
    const call = fresh(), before = JSON.stringify(call);
    expect(accepted(call)).toBe(true);
    expect(planCountQuestionPhase(fingerprint(call), false, designStep0Boundary, isDesignCountFirstReview, isDesignCountSetup)).toEqual({
      preReview: false, reviewStarted: true,
    });
    expect(JSON.stringify(call)).toBe(before);
  });

  test('layout, explanatory prose, names, tokens, ordinals and offered answers may vary', () => {
    expect(accepted(change(q => {
      q.question = q.question.replaceAll('has no', 'lacks');
      for (const field of ['Project/branch/task:', 'ELI10:', 'Stakes if we pick wrong:', 'Recommendation:', 'Completeness:', 'Net:']) {
        q.question = q.question.replace(` ${field}`, `\n${field}`);
      }
    }))).toBe(true);
    expect(accepted(change(q => { q.question = q.question.replace('The user came to do one thing: save. When everything shouts, nothing is heard, and a scanning user can hit Reset by mistake.', 'If a user scans the header, identical styles conceal the intended action.'); }))).toBe(true);
    expect(accepted(JSON.parse(JSON.stringify(fresh()).replaceAll('Save', 'Publish').replaceAll('Reset', 'Revert').replaceAll('#1d4ed8', '#234abc').replaceAll('white', 'black')))).toBe(true);
    expect(accepted(change(q => {
      q.header = 'Issue 9'; q.question = q.question.replace('D2', 'D17').replace('Issue 1', 'Issue 9').replace(/\b1([AB])\b/g, '9$1');
      q.options.forEach(o => { o.label = o.label.replace(/^1/, '9'); });
    }))).toBe(true);
    expect(accepted(change(q => { q.options.reverse(); }))).toBe(true);
    for (const option of fresh().questions[0]!.options) {
      const call = fresh(); call.answers = { [call.questions[0]!.question]: option.label };
      expect(accepted(call)).toBe(true);
    }
    expect(accepted(change(q => {
      q.question = q.question.replaceAll(', Export', '').replaceAll('four', 'three');
      q.options.forEach(o => { o.label = o.label.replace('four', 'three'); o.description = o.description?.replace('/Export', ''); });
    }))).toBe(true);
  });

  test('completed native identity and exact offered selection remain mandatory', () => {
    for (const edit of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.answeredAt; },
      (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; },
      (c: NativePlanQuestionCall) => { c.sessionId = ''; },
      (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'unoffered' }; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    ]) { const call = fresh(); edit(call); expect(accepted(call)).toBe(false); }
    for (const edit of [
      (fp: ReturnType<typeof fingerprint>) => { fp.signature = 'other:call'; },
      (fp: ReturnType<typeof fingerprint>) => { fp.nativeCall!.sessionId = 'other'; },
      (fp: ReturnType<typeof fingerprint>) => { fp.nativeQuestionIndex = 1; },
      (fp: ReturnType<typeof fingerprint>) => { fp.options.reverse(); },
    ]) { const fp = fingerprint(fresh()); edit(fp); expect(isDesignCountFirstReview(fp)).toBe(false); }
  });

  test('a numbered setup, mismatched issue or source packet cannot supply a current finding', () => {
    for (const header of ['Scope', 'Routing', 'Issue 2', 'Outside voices']) expect(accepted(change(q => { q.header = header; }))).toBe(false);
    for (const field of ['Project/branch/task:', 'ELI10:', 'Stakes if we pick wrong:', 'Recommendation:', 'Completeness:', 'Net:']) {
      expect(accepted(change(q => { q.question = q.question.replace(field, ''); }))).toBe(false);
      expect(accepted(change(q => { q.question += ` ${field} Extra.`; }))).toBe(false);
    }
    for (const prefix of ['Historical example:\n', 'Source:\n', 'If approved, ', '> ', '```text\n']) {
      expect(accepted(change(q => { q.question = prefix + q.question + (prefix.startsWith('```') ? '\n```' : ''); }))).toBe(false);
    }
    for (const edit of [
      (q: Question) => { q.question = q.question.replace('Save has no primary-action hierarchy.', 'How should we route the next reviewer?'); },
      (q: Question) => { q.question = q.question.replace('ELI10: The header', 'ELI10: Previously, the header'); },
      (q: Question) => { q.question = q.question.replace('ELI10: The header', 'ELI10: If approved, the header'); },
      (q: Question) => { q.question = q.question.replace('ELI10: The header shows Save, Reset, Cancel, Export as four identical buttons.', 'ELI10: "The header shows Save, Reset, Cancel, Export as four identical buttons."'); },
      (q: Question) => { q.question = q.question.replace('main, Pass 1', 'Historical example: main, Pass 1'); },
      (q: Question) => { q.options[0]!.label = q.options[0]!.label.replace('1A', '2A'); },
      (q: Question) => { q.question = q.question.replace('Recommendation: 1A', 'Recommendation: 2A'); },
    ]) expect(accepted(change(edit))).toBe(false);
  });

  test('same current actors, style, choice and unresolved opposition must agree', () => {
    for (const edit of [
      (q: Question) => { q.question = q.question.replace('as four identical', 'as three identical'); },
      (q: Question) => { q.question = q.question.replace('shows Save, Reset', 'shows Publish, Reset'); },
      (q: Question) => { q.question = q.question.replace('shows Save, Reset', 'shows Save, Save'); },
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace('Save:', 'Publish:'); },
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace('Reset/Cancel/Export', 'Save/Cancel/Export'); },
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace('#1d4ed8', '#abcdef'); },
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace('white', 'black'); },
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace('filled', 'outlined'); },
      (q: Question) => { q.options[1]!.label = '1B) Keep three equal buttons'; },
      (q: Question) => { q.options[1]!.description = 'No current gap remains; no fix is needed.'; },
      (q: Question) => { q.question = q.question.replace('1A) Filled primary', '1B) Filled primary').replace('1B) Keep four', '1A) Keep four'); },
      (q: Question) => { q.question = q.question.replace('Save becomes the only filled', 'Publish becomes the only filled'); },
      (q: Question) => { q.question = q.question.replace('become neutral ghost buttons', 'become filled primary buttons'); },
    ]) expect(accepted(change(edit))).toBe(false);
    for (const index of [0, 1]) for (const prefix of ['Historical example: ', 'If approved, ', 'Do not apply: ', '> ']) {
      expect(accepted(change(q => { q.options[index]!.description = prefix + q.options[index]!.description; }))).toBe(false);
    }
  });

  test('owned current withdrawals and approval conditions override affirmative earlier prose', () => {
    for (const target of [-1, 0, 1]) for (const suffix of [
      '\nThis finding is withdrawn.', '; This finding is "no longer current".', '; This option is \'withdrawn\'.',
      '\nThis amendment is ‘no longer current’.', '; This style is `withdrawn`.', '\nIssue 1 is resolved.',
      '\nCorrection: this gap is already resolved.', '\nNo current violation remains.',
      '\nOnce approved, apply this amendment.', '\nProvided approval, apply this amendment.',
      '\nDo not apply this amendment.', '\nNever use these tokens.', '\nSave is already the primary action.',
      '\nThis finding has no current defect.', '\nThis amendment keeps all four buttons identical.',
    ]) expect(accepted(change(q => {
      if (target < 0) q.question = q.question.replace('Which option?', `${suffix}\nWhich option?`);
      else q.options[target]!.description += suffix;
    }))).toBe(false);
  });

  test('quoted history, foreign issues and behavior conditions cannot withdraw the current decision', () => {
    for (const target of [-1, 0, 1]) for (const suffix of [
      ' Prior note: "This finding is withdrawn."', '\n> This amendment is withdrawn.',
      ' Earlier review said `This finding is withdrawn.`', '\nIssue 7 is withdrawn.',
      '\nIf a user scans the header, Save remains easiest to find.',
    ]) expect(accepted(change(q => {
      if (target < 0) q.question = q.question.replace('Which option?', `${suffix}\nWhich option?`);
      else q.options[target]!.description += suffix;
    }))).toBe(true);
  });

  test('the small public fixture and focused regression select only Design finding count', () => {
    for (const dependency of ['test/design-compact-primary-aw.test.ts', 'test/fixtures/design-compact-primary-aw-call.json']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(dependency)).map(([name]) => name)).toEqual(['plan-design-finding-count']);
    }
  });
});

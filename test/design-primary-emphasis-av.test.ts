import { describe, expect, test } from 'bun:test';
import captured from './fixtures/design-primary-emphasis-av-calls.json';
import { nativePlanCallFingerprint, designStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';
import { isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff } from './helpers/design-count-review';
import { isDesignArtifactGeneration } from './helpers/design-artifact-question';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';

const batches = [captured.calls, captured.retry.calls] as NativePlanQuestionCall[][];
const indices = [1, 2];
const fresh = (index: number) => structuredClone(batches[index]![indices[index]!]!);
const fingerprint = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
const accepted = (call: NativePlanQuestionCall) => isDesignCountFirstReview(fingerprint(call));
type Question = NativePlanQuestionCall['questions'][number];
function change(index: number, edit: (question: Question, call: NativePlanQuestionCall) => void): NativePlanQuestionCall {
  const call = fresh(index), question = call.questions[0]!;
  edit(question, call);
  call.answers = { [question.question]: question.options[0]!.label };
  return call;
}

describe('current primary emphasis and annotated header signal decisions', () => {
  test('exact public first and retry calls enter review at their first real issue', () => {
    for (const [index, batch] of batches.entries()) {
      const before = JSON.stringify(batch);
      let started = false;
      const phases = batch.map(call => {
        const phase = planCountQuestionPhase(fingerprint(call), started, designStep0Boundary,
          isDesignCountFirstReview, isDesignCountSetup, isDesignCompletionHandoff, isDesignArtifactGeneration);
        started = phase.reviewStarted;
        return phase;
      });
      expect(batch.map(accepted)).toEqual(batch.map((_, i) => i === indices[index]));
      expect(phases.map(phase => phase.preReview)).toEqual(batch.map((_, i) => i < indices[index]!));
      expect(phases.filter(phase => phase.administrative)).toHaveLength(0);
      // Five actual issues satisfy the original floor without relying on the
      // retry's later TODO question, which is outside this first-entry fix.
      expect(phases.slice(indices[index], indices[index]! + 5).filter(phase => !phase.preReview)).toHaveLength(5);
      expect(JSON.stringify(batch)).toBe(before);
    }
  });

  test('consistent actors, palette, finding ordinal and offered selections preserve meaning', () => {
    for (const index of [0, 1]) {
      const renamed = JSON.parse(JSON.stringify(fresh(index)).replaceAll('Save', 'Submit').replaceAll('Reset', 'Revert').replaceAll('#1d4ed8', '#234abc'));
      expect(accepted(renamed)).toBe(true);
      const ordinal = change(index, q => {
        q.header = q.header.replace('Issue 1', 'Issue 9');
        q.question = q.question.replace('Issue 1', 'Issue 9').replace(/\b1([ABC])\b/g, '9$1');
        q.options.forEach(option => { option.label = option.label.replace(/^1/, '9'); });
      });
      expect(accepted(ordinal)).toBe(true);
      for (const option of fresh(index).questions[0]!.options) {
        const call = fresh(index);
        call.answers = { [call.questions[0]!.question]: option.label };
        expect(accepted(call)).toBe(true);
      }
      expect(accepted(change(index, q => q.options.reverse()))).toBe(true);
      expect(accepted(change(index, q => {
        q.question = q.question.replace(/D[23] —/, 'D17 —');
      }))).toBe(true);
    }
    for (const header of ['Primary CTA', 'Header hierarchy', 'Issue 1', 'Issue 1: Save']) {
      expect(accepted(change(1, q => { q.header = header; }))).toBe(true);
    }
    expect(accepted(change(1, q => { q.question = q.question.replace('(G1)', '(G19)'); }))).toBe(true);
  });

  test('unacknowledged, failed, foreign and mismatched native identities do not start review', () => {
    const mutations = [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.answeredAt; },
      (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'unoffered answer' }; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
    ];
    for (const index of [0, 1]) {
      for (const mutation of mutations) { const call = fresh(index); mutation(call); expect(accepted(call)).toBe(false); }
      for (const mutation of [
        (fp: ReturnType<typeof fingerprint>) => { fp.signature = 'foreign:call'; },
        (fp: ReturnType<typeof fingerprint>) => { fp.nativeCall!.sessionId = 'foreign'; },
        (fp: ReturnType<typeof fingerprint>) => { fp.nativeCall!.toolUseId = 'foreign'; },
        (fp: ReturnType<typeof fingerprint>) => { fp.nativeQuestionIndex = 1; },
        (fp: ReturnType<typeof fingerprint>) => { fp.options.reverse(); },
      ]) { const fp = fingerprint(fresh(index)); mutation(fp); expect(isDesignCountFirstReview(fp)).toBe(false); }
    }
  });

  test('descriptive headers cannot override conflicting ordinals or become setup navigation', () => {
    for (const index of [0, 1]) {
      for (const header of ['Issue 2', 'Issue 2: Save', 'Scope', 'Routing', 'Learnings', 'Outside voices', 'Next steps']) {
        expect(accepted(change(index, q => { q.header = header; }))).toBe(false);
      }
      expect(accepted(change(index, q => { q.options[0]!.label = q.options[0]!.label.replace('1A', '2A'); }))).toBe(false);
      expect(accepted(change(index, q => { q.question = q.question.replace('Save primary emphasis', 'the reviewer primary emphasis').replace('that Save is', 'that the reviewer is'); }))).toBe(false);
      expect(accepted(change(index, q => { q.question = q.question.replace('primary emphasis', 'review readiness').replace('primary action?', 'next reviewer?'); }))).toBe(false);
    }
  });

  test('current equal-weight premise cannot come from a quote, source or future condition', () => {
    for (const index of [0, 1]) for (const edit of [
      (q: Question) => { q.question = 'Historical example:\n' + q.question; },
      (q: Question) => { q.question = '```text\n' + q.question + '\n```'; },
      (q: Question) => { q.question = q.question.replace('ELI10: Right now', 'ELI10: Previously'); },
      (q: Question) => { q.question = q.question.replace('ELI10: Right now', 'ELI10: If approved, right now'); },
      (q: Question) => { q.question = q.question.replace(/^ELI10: (.+)$/m, '> ELI10: $1'); },
      (q: Question) => { q.question = q.question.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'); },
      (q: Question) => { q.question = q.question.replace(/(?:all )?look (?:the same|identical)/, 'do not look identical'); },
      (q: Question) => { q.question += '\nELI10: No current gap remains.'; },
      (q: Question) => { q.question += '\nCorrection: this gap is already resolved.'; },
      (q: Question) => { q.question = q.question.replace('Right now Save,', 'Right now Publish,'); },
    ]) expect(accepted(change(index, edit))).toBe(false);
  });

  test('the current named correction and distinct unresolved choice must both be present', () => {
    for (const index of [0, 1]) for (const edit of [
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace('✅ Save', '✅ Publish'); },
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace('; Reset', '; Save, Reset'); },
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace(/filled/g, 'outlined'); },
      (q: Question) => { q.options[0]!.description = q.options[0]!.description!.replace(/DESIGN\.md/g, 'ARCHIVED.md'); },
      (q: Question) => { q.options[2]!.label = '1C Choose another workflow'; },
      (q: Question) => { q.options[2]!.description = 'All buttons already comply; no violation remains.'; },
      (q: Question) => { q.options[2]!.description += '\nCorrection: the violation is now closed.'; },
    ]) expect(accepted(change(index, edit))).toBe(false);
    for (const index of [0, 1]) for (const option of [0, 2]) for (const prefix of ['Historical source excerpt: ', 'If approved later: ', '> ', 'Do not apply: ']) {
      expect(accepted(change(index, q => { q.options[option]!.description = prefix + q.options[option]!.description; }))).toBe(false);
    }
  });

  test('owned current withdrawal overrides earlier assertions while quoted history does not', () => {
    for (const index of [0, 1]) for (const target of [-1, 0, 2]) {
      for (const suffix of ['\nThis finding is withdrawn.', '\nThis finding is "no longer current".', '\nThis finding is \'withdrawn\'.', '\nThis finding is ‘no longer current’.', '\nThis finding is `no longer current`.', '\nAssessment complete; This finding is withdrawn.', '\nAssessment complete; This finding is \'no longer current\'.', '\nCorrection: this gap is already resolved.', '\nProvided approval, apply this amendment.', '\nOnce approved, apply this amendment.']) {
        expect(accepted(change(index, q => { if (target < 0) q.question += suffix; else q.options[target]!.description += suffix; }))).toBe(false);
      }
      for (const suffix of [' Prior note: "This finding is withdrawn."', '\n> This amendment is withdrawn.', ' Earlier review said `This finding is withdrawn.`', '\nIf a user scans the header, Save remains easiest to find.']) {
        expect(accepted(change(index, q => { if (target < 0) q.question += suffix; else q.options[target]!.description += suffix; }))).toBe(true);
      }
    }
  });

  test('new public fixture and regression tests select the Design finding-count workflow only', () => {
    for (const dependency of ['test/design-primary-emphasis-av.test.ts', 'test/fixtures/design-primary-emphasis-av-calls.json']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([, paths]) => paths.includes(dependency)).map(([name]) => name)).toEqual(['plan-design-finding-count']);
    }
  });
});

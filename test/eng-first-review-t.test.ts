import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativePlanCallFingerprint, planCountQuestionPhase, engStep0Boundary, engSetupAUQ, engFirstReviewAUQ } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';

const calls: NativePlanQuestionCall[] = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/eng-batching-t-calls.json'), 'utf8'));
const fresh = () => structuredClone(calls[0]!);
const first = (call: NativePlanQuestionCall) => engFirstReviewAUQ(nativePlanCallFingerprint(call, 0, true));
function question(call: NativePlanQuestionCall, text: string) {
  const q = call.questions[0]!; const answer = call.answers![q.question];
  call.answers = { [text]: answer! }; q.question = text;
}

describe('T Eng first architecture choice', () => {
  test('the actual first architecture issue starts review on this call', () => {
    const call = fresh(); const fp = nativePlanCallFingerprint(call, 0, true);
    expect(engSetupAUQ(fp)).toBe(false);
    expect(first(call)).toBe(true);
    expect(planCountQuestionPhase(fp, false, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ))
      .toEqual({ preReview: false, reviewStarted: true });
  });

  test('all five exact native decisions remain separate review calls', () => {
    let started = false;
    const phases = calls.map(call => {
      const fp = nativePlanCallFingerprint(call, 0, !started);
      const phase = planCountQuestionPhase(fp, started, engStep0Boundary, engFirstReviewAUQ, engSetupAUQ);
      started = phase.reviewStarted; return phase.preReview;
    });
    expect(phases).toEqual([false, false, false, false, false]);
  });

  test('offered answer identity survives reorder and either alternative decision', () => {
    const call = fresh(); call.questions[0]!.options.reverse();
    expect(first(call)).toBe(true);
    for (const option of call.questions[0]!.options) {
      call.answers![call.questions[0]!.question] = option.label;
      expect(first(call)).toBe(true);
    }
  });

  test('requires one completed native question and exact offered answer', () => {
    const variants: Array<(c: NativePlanQuestionCall) => void> = [
      c => { c.answered = false; }, c => { c.failed = true; },
      c => { delete c.unansweredQuestionIndices; }, c => { c.unansweredQuestionIndices = [0]; },
      c => { c.answers = {}; }, c => { c.answers![c.questions[0]!.question] = 'Foreign answer'; },
      c => { c.questions.push(structuredClone(c.questions[0]!)); },
      c => { c.questions[0]!.multiSelect = true; },
      c => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
    ];
    for (const change of variants) { const call = fresh(); change(call); expect(first(call)).toBe(false); }
    const fp = nativePlanCallFingerprint(fresh(), 0, true); fp.signature = 'foreign:identity';
    expect(engFirstReviewAUQ(fp)).toBe(false);
    delete fp.nativeCall; expect(engFirstReviewAUQ(fp)).toBe(false);
  });

  test('whole-plan approach, setup, missing identity and quoted examples cannot start review', () => {
    for (const header of ['Approach', 'Scope', 'Routing rules', 'Next review']) {
      const call = fresh(); call.questions[0]!.header = header; expect(first(call)).toBe(false);
    }
    const original = fresh().questions[0]!.question;
    for (const text of [
      original.replace('arch-retry-scheduler', 'arch-setup'), original.replace(/ <gstack-qid:[^>]+>/, ''),
      original.replace('Architecture: Custom retry scheduler', 'Approach: Which whole-plan direction'),
      '> ' + original, '```text\n' + original + '\n```', original + ' Should we start another review?',
    ]) { const call = fresh(); question(call, text); expect(first(call)).toBe(false); }
  });

  test('requires an affirmative existing defect, not a neutral or negated comparison', () => {
    for (const description of [
      'Both implementations are equally valid choices.',
      'Each worker gets its own copy. There is no DRY violation.',
      fresh().questions[0]!.options[2]!.description!.replace('acknowledged DRY violation', 'no DRY violation'),
      fresh().questions[0]!.options[2]!.description!.replace('Creates 5 divergence points', 'No longer creates 5 divergence points'),
      '```text\n' + fresh().questions[0]!.options[2]!.description + '\n```',
    ]) { const call = fresh(); call.questions[0]!.options[2]!.description = description; expect(first(call)).toBe(false); }
    const call = fresh(); call.questions[0]!.options[0]!.label = 'Run /office-hours';
    call.answers![call.questions[0]!.question] = 'Run /office-hours'; expect(first(call)).toBe(false);
  });
});

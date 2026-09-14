import { expect, test } from 'bun:test';
import captured from './fixtures/design-primary-action-aj.json';
import { isDesignCountFirstReview, isDesignCountSetup } from './helpers/design-count-review';
import { designStep0Boundary, planCountQuestionPhase } from './helpers/claude-pty-runner';

test('the exact completed current primary-action choice starts Design review', () => {
  expect(isDesignCountFirstReview(captured)).toBe(true);
  expect(planCountQuestionPhase(captured, false, designStep0Boundary, isDesignCountFirstReview, isDesignCountSetup))
    .toMatchObject({ preReview: false, reviewStarted: true });
});

function fresh(): any { return structuredClone(captured); }
function changeText(fp: any, change: (text: string) => string) {
  const q = fp.nativeCall.questions[0], answer = fp.nativeCall.answers[q.question];
  q.question = change(q.question); fp.nativeCall.answers = { [q.question]: answer };
}
function changeMenu(fp: any, change: (q: any) => void) {
  const q = fp.nativeCall.questions[0]; change(q);
  fp.options = q.options.map((o: any, i: number) => ({ index: i + 1, label: o.label }));
  fp.nativeCall.answers = { [q.question]: q.options[0].label };
}

test('an offered deferral, reordered menu and consistently renamed control remain review decisions', () => {
  for (const option of captured.nativeCall.questions[0]!.options) {
    const fp = fresh(); fp.nativeCall.answers = { [fp.nativeCall.questions[0].question]: option.label };
    expect(isDesignCountFirstReview(fp)).toBe(true);
  }
  const reordered = fresh(); changeMenu(reordered, q => q.options.reverse());
  expect(isDesignCountFirstReview(reordered)).toBe(true);
  const renamed = fresh(); changeText(renamed, s => s.replaceAll('Save', 'Submit'));
  changeMenu(renamed, q => q.options.forEach((o: any) => {
    o.label = o.label.replaceAll('Save', 'Submit'); o.description = o.description.replaceAll('Save', 'Submit');
  }));
  expect(isDesignCountFirstReview(renamed)).toBe(true);
  const numbered = fresh(); changeText(numbered, s => s.replaceAll('Issue 1', 'Issue 6').replaceAll('1A', '6A').replaceAll('1B', '6B').replaceAll('1C', '6C'));
  changeMenu(numbered, q => { q.header = 'Issue 6'; q.options.forEach((o: any) => { o.label = o.label.replace(/^1/, '6'); }); });
  expect(isDesignCountFirstReview(numbered)).toBe(true);
});

test('native completion, owned identity, offered answers and aligned numbering are necessary', () => {
  for (const change of [
    (f: any) => { delete f.nativeCall; },
    (f: any) => { f.nativeCall.answered = false; },
    (f: any) => { f.nativeCall.failed = true; },
    (f: any) => { f.nativeCall.sessionId = 'foreign-session'; },
    (f: any) => { f.nativeCall.toolUseId = 'foreign-request'; },
    (f: any) => { f.nativeCall.answeredAt = 'invalid'; },
    (f: any) => { delete f.nativeCall.answeredAt; },
    (f: any) => { f.nativeCall.unansweredQuestionIndices = [0]; },
    (f: any) => { f.nativeQuestionIndex = 1; },
    (f: any) => { f.nativeCall.answers = {}; },
    (f: any) => { f.nativeCall.answers[f.nativeCall.questions[0].question] = 'unoffered'; },
    (f: any) => { f.nativeCall.questions[0].question += ' altered'; },
    (f: any) => { f.nativeCall.questions[0].header = 'Issue 2'; },
    (f: any) => { f.nativeCall.questions[0].multiSelect = true; },
    (f: any) => { f.options.reverse(); },
    (f: any) => { changeMenu(f, q => { q.options[0].label = q.options[0].label.replace('1A', '2A'); }); },
  ]) { const fp = fresh(); change(fp); expect(isDesignCountFirstReview(fp)).toBe(false); }
});

test('quoted, hypothetical, future and explicitly withdrawn assessments cannot borrow style choices', () => {
  for (const change of [
    (s: string) => 'Example: ' + s,
    (s: string) => '```text\n' + s + '\n```',
    (s: string) => s.replace('ELI10: Right now', 'ELI10: Suppose right now'),
    (s: string) => s.replace('ELI10: Right now', 'ELI10: If approved, right now'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, "ELI10: '$1'"),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: $1 This issue is withdrawn.'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: $1 We have resolved this finding.'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: $1 No current gap remains.'),
    (s: string) => s + '\nCorrection: this issue is withdrawn.',
    (s: string) => s.replace('make Save the only filled primary action?', 'make Save the only filled primary action in a future redesign?'),
    (s: string) => s.replace('make Save the only filled primary action?', 'make the primary reviewer the next step?'),
    (s: string) => s.replace('ELI10: Right now Save,', 'ELI10: Right now Publish,'),
  ]) { const fp = fresh(); changeText(fp, change); expect(isDesignCountFirstReview(fp)).toBe(false); }
});

test('the named amendment and unresolved violation belong to distinct current offered choices', () => {
  for (const change of [
    (q: any) => { q.options[0].description = q.options[0].description.replace('✅ Save is', '✅ Publish is'); },
    (q: any) => { q.options[0].description = '✅ Example only: ' + q.options[0].description; },
    (q: any) => { q.options[0].description = '✅ Save is not the single filled primary action.'; },
    (q: any) => { q.options[0].description += ' This issue is withdrawn.'; },
    (q: any) => { q.options[2].description = 'All buttons already comply. No current issue remains.'; },
    (q: any) => { q.options[2].description = '❌ Hypothetical: Primary-action ambiguity ships; documented DESIGN.md violation remains.'; },
    (q: any) => { q.options[2].description += ' Correction: this issue is resolved.'; },
    (q: any) => { q.options[0].description += ' ' + q.options[2].description; q.options[2].description = 'Another compliant option.'; },
  ]) { const fp = fresh(); changeMenu(fp, change); expect(isDesignCountFirstReview(fp)).toBe(false); }
});

test('conditional stakes and an unrelated quoted historical claim retain the current choice', () => {
  const fp = fresh(); changeText(fp, s => s.replace('Stakes if we pick wrong:', 'Stakes if we pick wrong: If unchanged,'));
  expect(isDesignCountFirstReview(fp)).toBe(true);
  const history = fresh(); changeText(history, s => s.replace('\nStakes if we pick wrong:', ' The old report claimed "This issue is resolved.", but that claim was wrong.\nStakes if we pick wrong:'));
  expect(isDesignCountFirstReview(history)).toBe(true);
});

import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
test('the exact public fixture and controls select only the affected Design count workflow', () => {
  for (const file of ['test/design-primary-action-aj.test.ts', 'test/fixtures/design-primary-action-aj.json'])
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['plan-design-finding-count']);
});

import deferredTodo from './fixtures/design-future-todo-aj.json';
import { isDesignArtifactGeneration } from './helpers/design-artifact-question';
test('the actual completed future-only TODO recording is administrative and retains freshness', () => {
  expect(isDesignArtifactGeneration(deferredTodo)).toBe(true);
  expect(planCountQuestionPhase(deferredTodo, true, designStep0Boundary, isDesignCountFirstReview,
    isDesignCountSetup, undefined, isDesignArtifactGeneration)).toEqual({ preReview: false, reviewStarted: true, administrative: 'artifact-generation' });
});

test('skipping a future TODO is administrative, while building it now remains a review decision', () => {
  for (const index of [0, 1, 2]) {
    const fp: any = structuredClone(deferredTodo), q = fp.nativeCall.questions[0];
    fp.nativeCall.answers = { [q.question]: q.options[index].label };
    expect(isDesignArtifactGeneration(fp)).toBe(index !== 2);
    const phase = planCountQuestionPhase(fp, true, designStep0Boundary, isDesignCountFirstReview,
      isDesignCountSetup, undefined, isDesignArtifactGeneration);
    expect(phase.preReview).toBe(false);
    expect(phase.administrative).toBe(index !== 2 ? 'artifact-generation' : undefined);
  }
  const fp: any = structuredClone(deferredTodo);
  expect(planCountQuestionPhase(fp, false, designStep0Boundary, isDesignCountFirstReview,
    isDesignCountSetup, undefined, isDesignArtifactGeneration).reviewStarted).toBe(false);
});

test('a deferred artifact requires completed native identity, the exact answer and full aligned menu', () => {
  for (const change of [
    (f: any) => { delete f.nativeCall; },
    (f: any) => { f.nativeCall.answered = false; },
    (f: any) => { f.nativeCall.failed = true; },
    (f: any) => { f.nativeCall.sessionId = 'foreign'; },
    (f: any) => { f.nativeCall.answeredAt = 'invalid'; },
    (f: any) => { f.nativeCall.unansweredQuestionIndices = [0]; },
    (f: any) => { f.nativeQuestionIndex = 1; },
    (f: any) => { f.nativeCall.answers = {}; },
    (f: any) => { f.nativeCall.answers[f.nativeCall.questions[0].question] = 'unoffered'; },
    (f: any) => { f.options.reverse(); },
    (f: any) => { f.nativeCall.questions[0].multiSelect = true; },
    (f: any) => { f.nativeCall.questions.push(structuredClone(f.nativeCall.questions[0])); },
    (f: any) => { f.nativeCall.questions[0].options.pop(); },
  ]) { const fp: any = structuredClone(deferredTodo); change(fp); expect(isDesignArtifactGeneration(fp)).toBe(false); }
});

test('a deferred TODO cannot conceal current implementation, changed scope or source-only declarations', () => {
  for (const change of [
    (s: string) => 'Example: ' + s,
    (s: string) => '```text\n' + s + '\n```',
    (s: string) => s.replace('ELI10: DESIGN.md', 'ELI10: Suppose DESIGN.md'),
    (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
    (s: string) => s.replace('so nothing changes now.', 'but replace the font now.'),
    (s: string) => s.replace('in a later design pass?', 'in this update?'),
    (s: string) => s + '\nCorrection: font replacement is now in scope; implement it now.',
  ]) { const fp: any = structuredClone(deferredTodo); changeText(fp, change); expect(isDesignArtifactGeneration(fp)).toBe(false); }
  for (const index of [0, 1, 2]) {
    const fp: any = structuredClone(deferredTodo);
    fp.nativeCall.questions[0].options[index].description += ' Also fix the current form typography in this PR.';
    expect(isDesignArtifactGeneration(fp)).toBe(false);
  }
  const current = fresh();
  expect(isDesignArtifactGeneration(current)).toBe(false);
  expect(isDesignCountFirstReview(current)).toBe(true);
});

test('deferred artifact classification follows offered identities and the current approved font', () => {
  const reordered: any = structuredClone(deferredTodo);
  changeMenu(reordered, q => q.options.reverse());
  reordered.nativeCall.answers = { [reordered.nativeCall.questions[0].question]: 'A Add to TODOS.md (recommended)' };
  expect(isDesignArtifactGeneration(reordered)).toBe(true);
  const renamed: any = structuredClone(deferredTodo);
  changeText(renamed, s => s.replaceAll('system-ui', 'ApprovedSans'));
  changeMenu(renamed, q => q.options.forEach((o: any) => { o.description = o.description.replaceAll('system-ui', 'ApprovedSans'); }));
  expect(isDesignArtifactGeneration(renamed)).toBe(true);
});

test('the deferred TODO fixture selects the same affected Design count workflow', () => {
  expect(selectTests(['test/fixtures/design-future-todo-aj.json'], E2E_TOUCHFILES, []).selected).toEqual(['plan-design-finding-count']);
});

test('deferred TODO scope survives benign explanations, estimates and a concise equivalent proposal', () => {
  for (const change of [
    (s: string) => s.replace('Why: a chosen typeface is the cheapest tell that the app was designed rather than assembled. Pros: brand voice across the whole app.', 'Why: a deliberate typeface could make the application recognizable. Pros: a consistent future brand voice.'),
    (s: string) => s.replace('(for example DM Sans, Instrument Sans, IBM Plex Sans)', '(for example Atkinson Hyperlegible)'),
    (s: string) => s.replace('Stakes if we pick wrong: either the debt is forgotten, or a note lands in TODOS.md that you consider noise.', 'Stakes if we pick wrong: the future debt may be forgotten, or the backlog may become noisy.').replace('Recommendation: A because the debt is real but explicitly out of scope, and a written TODO costs nothing.', 'Recommendation: A to retain the explicitly out-of-scope debt for later.').replace('Net: keep the typography debt visible vs. drop it.', 'Net: record the deferred typography debt or omit the note.'),
    (s: string) => s.replace('DESIGN.md and this plan keep system-ui as the app font, and you excluded visual exploration from this update, so nothing changes now.', 'DESIGN.md and this plan retain system-ui as the app font. Visual exploration remains out of scope for this update, so nothing changes now.'),
  ]) { const fp: any = structuredClone(deferredTodo); changeText(fp, change); expect(isDesignArtifactGeneration(fp)).toBe(true); }
  const estimate: any = structuredClone(deferredTodo);
  estimate.nativeCall.questions[0].options[0].description = estimate.nativeCall.questions[0].options[0].description.replace('human: ~5min / CC: ~1min to record', 'human: ~10min / CC: ~2min to record');
  expect(isDesignArtifactGeneration(estimate)).toBe(true);
  const concise: any = structuredClone(deferredTodo);
  changeText(concise, s => s.replace('record a deferred TODOS.md item to evaluate a real body typeface', 'add a deferred TODOS.md note to consider an alternate body typeface').replace('in a later design pass?', 'during a future design pass?').replace(/^ELI10: .+$/m,
    'ELI10: DESIGN.md and the current plan preserve system-ui as the app font. Visual exploration is out of scope for this update, so the current design remains unchanged. This question only records a deferred TODOS.md note for a future /design-consultation; it does not change the current design.'));
  changeMenu(concise, q => {
    q.options[0].description = '✅ Records only a TODOS.md note for a future /design-consultation. No design changes in this update; DESIGN.md and system-ui remain unchanged.';
    q.options[1].description = '✅ No TODO is recorded. No follow-up work.';
    q.options[2].description = '✅ Replace the font now in this PR.';
  });
  expect(isDesignArtifactGeneration(concise)).toBe(true);
});

test('paraphrased facts still require affirmative preservation and reject present work', () => {
  for (const change of [
    (s: string) => s.replace('so nothing changes now.', 'so it is false that nothing changes now.'),
    (s: string) => s.replace('ELI10: DESIGN.md and this plan keep system-ui as the app font', 'ELI10: DESIGN.md and this plan keep Roboto as the app font'),
    (s: string) => s.replace('Net: keep the typography debt visible vs. drop it.', 'Net: replace the font now.'),
    (s: string) => s.replace('Net: keep the typography debt visible vs. drop it.', 'Net: this scope is withdrawn.'),
  ]) { const fp: any = structuredClone(deferredTodo); changeText(fp, change); expect(isDesignArtifactGeneration(fp)).toBe(false); }
  const conditional: any = structuredClone(deferredTodo);
  conditional.nativeCall.questions[0].options[0].description = conditional.nativeCall.questions[0].options[0].description.replace('Nothing changes in this update;', 'If approved: Nothing changes in this update;');
  expect(isDesignArtifactGeneration(conditional)).toBe(false);
  const additional: any = structuredClone(deferredTodo);
  additional.nativeCall.questions[0].options[0].description += ' Add a 48px button target to this plan.';
  expect(isDesignArtifactGeneration(additional)).toBe(false);
  for (const suffix of ['Add a TODOS.md note and make the Save button 48px.', 'Add a TODOS.md note for the future font review and make the Save button 48px.']) {
    const mixed: any = structuredClone(deferredTodo);
    mixed.nativeCall.questions[0].options[0].description += ' ' + suffix;
    expect(isDesignArtifactGeneration(mixed)).toBe(false);
  }
  const recordingOnly: any = structuredClone(deferredTodo);
  recordingOnly.nativeCall.questions[0].options[0].description += ' Add a TODOS.md note for the future font review.';
  expect(isDesignArtifactGeneration(recordingOnly)).toBe(true);
  for (const suffix of ['Visual exploration is no longer out of scope.', 'This plan no longer keeps system-ui.']) {
    const fp: any = structuredClone(deferredTodo);
    changeText(fp, s => s.replace(/^ELI10: (.+)$/m, 'ELI10: $1 ' + suffix));
    expect(isDesignArtifactGeneration(fp)).toBe(false);
  }
  const archival: any = structuredClone(deferredTodo);
  changeText(archival, s => s.replace(/^ELI10: (.+)$/m, 'ELI10: $1 Historical note: "Visual exploration is no longer out of scope."'));
  expect(isDesignArtifactGeneration(archival)).toBe(true);
});

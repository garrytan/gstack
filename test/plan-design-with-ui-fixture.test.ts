import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

// Execute the real paid registration with native observation mocked. The actual
// actor picker, exact seeding, owned binding, assertions and cleanup execute.
function exercise(mode: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'design-ui-free-'));
  const script = path.join(directory, 'registration.test.ts');
  const facts = path.join(directory, 'facts.json');
  fs.writeFileSync(script, `
import { describe, expect, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
const mode = ${JSON.stringify(mode)};
const fixture = ${JSON.stringify(path.join(ROOT, 'test/fixtures/plans/ui-heavy-feature.md'))};
const template = fs.readFileSync(${JSON.stringify(path.join(ROOT, 'plan-design-review/SKILL.md.tmpl'))}, 'utf8');
const focus = template.match(/### 0D\\. Focus Areas\\nAskUserQuestion: "([^\\n]+)"/)![1]
  .replace('{N}', '4').replace('{X, Y, Z}', 'hierarchy, spacing, contrast');
const { DESIGN_BOARD_ACTOR_PROTOCOL, createDesignReviewPicker: actualCreateDesignReviewPicker } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-board-feedback.ts'))});
const outsideVoices = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/design-outside-voices-question.json'))}, 'utf8'));
let pickerScope;
let pickerQuestion;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-board-feedback.ts'))}, () => ({
  DESIGN_BOARD_ACTOR_PROTOCOL,
  createDesignReviewPicker: scope => {
    pickerScope = scope;
    const actualPicker = actualCreateDesignReviewPicker(scope);
    return question => { pickerQuestion = question; return actualPicker(question); };
  },
}));
const { createPlanCountFixture } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-count-fixture.ts'))});
const { nativePlanCallFingerprint } = await import(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))});
const fp = (id, question, preReview = true) => nativePlanCallFingerprint({
  sessionId: 'owned-ui-fixture', toolUseId: id, answered: true, failed: false,
  unansweredQuestionIndices: [],
  questions: [{ header: 'Review', question, multiSelect: false, options: [
    { label: 'Review all 7 dimensions (recommended)', description: 'Review the supplied UI plan.' },
    { label: 'Review a different branch', description: 'That branch may have no UI scope; design review is not applicable there.' },
  ] }],
}, 1000, preReview);
const target = fp('target', 'D1 — What should I design-review?\\nProject/branch/task: gstack repo, no plan file drafted yet.\\nELI10: A design review needs a target. Pick what I should rate 0-10 across the 7 design dimensions.');
target.nativeCall.questions[0].header = 'Review target';
if (mode === 'target-menu-design-system') {
  target.nativeCall.questions[0].question = 'What should I design-review? ELI10: Choose a plan, design system, or the current branch diff.';
  target.promptSnippet = target.nativeCall.questions[0].question;
}
target.nativeCall.questions[0].options = [
  { label: 'B) A plan or design doc (recommended)', description: 'You need to paste the plan or point me to a path.' },
  { label: 'A) The current branch diff', description: 'The working tree is clean, so there may be no UI scope to review.' },
];
const paraphrase = fp('focus', 'D1 — Review all 7 design dimensions, or focus on specific areas?\\nELI10: I rated this plan 4/10.');
// Public titles/options projected from the retained Sep 11 native PostToolUse
// events: focus toolu_01XJZk6qbs3Fj3VRbm6sCNv2, setup toolu_01WkR4juMdcMxCTJe8FfRMVY,
// finding toolu_012EsyqshgBk2Ap7CfuzwhwQ. No transcript paths or private content.
const nativeFocus = fp('native-focus', mode === 'native-passes'
  ? 'D1 — Review all 7 design passes, or focus?'
  : 'D1 — Review all 7 design dimensions, or focus?');
nativeFocus.nativeCall.questions[0].options = [
  { label: 'All 7 dimensions (recommended)', description: 'Full review: hierarchy, states, journey, specificity, AI slop, responsive, accessibility. Completeness 10/10.' },
  { label: 'States + hierarchy + a11y', description: 'Focus on the three weakest areas only. Completeness 7/10.' },
  { label: 'Visual + AI slop only', description: 'Focus on look and originality, skip state and interaction passes. Completeness 4/10.' },
];
const nativeSetup = fp('native-setup', 'D2 — Run outside design voices before the 7 passes?', false);
nativeSetup.nativeCall.questions[0].options = [
  { label: 'Yes, run outside voices (recommended)', description: 'Codex design critique + independent Claude subagent, run in parallel, synthesized into a litmus scorecard.' },
  { label: 'No, skip to the passes', description: 'Go straight to Pass 1 with my review only.' },
];
const nativeFinding = fp('native-finding', "D3 — Issue 1 [HARD REJECTION risk]: Which region is the dashboard's primary anchor, and how is the page composed?", false);
nativeFinding.nativeCall.questions[0].options = [
  { label: '1A Notifications-primary (recommended)', description: 'Status line + unread count anchors; notifications ~7/12, activity ~5/12; mobile order status, notifications, activity. Completeness 10/10.' },
  { label: '1B Activity-primary (Codex)', description: 'Activity dominant ~7/12, notifications right rail; primary action beside title. Completeness 10/10.' },
  { label: '1C Three peer regions, decide later', description: 'Keep the plan as written; hard rejection #1 stays open. Completeness 3/10.' },
];
const unnumberedFinding = fp('unnumbered-finding', "Which region is the dashboard's primary anchor, and how is the page composed?", false);
unnumberedFinding.nativeCall.questions[0].options = nativeFinding.nativeCall.questions[0].options;
const finding = fp('finding', 'Which loading feedback should Save show?', false);
finding.nativeCall.questions[0].options = [
  { label: 'Saving label and spinner (recommended)', description: 'Show in-flight feedback in the Save button.' },
  { label: 'Keep the current button', description: 'Keep the button label and current loading feedback.' },
];
let calls = 0;
fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ calls }));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('gate'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  runPlanSkillCounting: async opts => {
    calls++;
    expect(opts.cwd).toBeUndefined();
    const ownedFixture = createPlanCountFixture(opts.followUpPrompt, {nativeReviewOnly: true, files: opts.fixtureFiles});
    const cwd = ownedFixture.cwd;
    try {
    expect(path.dirname(cwd)).toBe(${JSON.stringify(directory)});
    expect(cwd).not.toBe(${JSON.stringify(ROOT)});
    expect(opts.skillName).toBe('plan-design-review');
    expect(opts).not.toHaveProperty('readDesignArtifacts');
    expect(opts.slashCommand).toBe('/plan-design-review');
    expect(opts.followUpPrompt).toContain(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/plans/ui-heavy-feature.md'))}, 'utf8'));
    expect(opts.followUpPrompt).toContain(DESIGN_BOARD_ACTOR_PROTOCOL);
    expect(opts.reviewCountCeiling).toBe(1);
    expect(opts.observeSetupQuestions).toBe(true);
    expect(opts.bindDesignBoardState).toBe(true);
    expect(opts).not.toHaveProperty('questionPick');
    expect(typeof opts.pickAUQ).toBe('function');
    expect(opts).not.toHaveProperty('model');
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(600_000);
    expect(fs.readFileSync(path.join(cwd, 'review-input.md'), 'utf8')).toBe(fs.readFileSync(fixture, 'utf8'));
    const instructions = fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8');
    expect(instructions).toContain(DESIGN_BOARD_ACTOR_PROTOCOL);
    expect(instructions).toContain('Decline the optional Design Outside Voices step');
    expect(instructions).toContain('all ordinary Design review decisions still apply');
    expect(execFileSync('git', ['show', 'HEAD:CLAUDE.md'], { cwd: cwd, encoding: 'utf8', timeout: 5000 })).toBe(instructions);
    expect(execFileSync('git', ['diff', 'origin/main...HEAD'], { cwd: cwd, encoding: 'utf8', timeout: 5000 })).toBe('');
    expect(execFileSync('git', ['show', 'HEAD:review-input.md'], { cwd: cwd, encoding: 'utf8', timeout: 5000 })).toBe(fs.readFileSync(fixture, 'utf8'));
    expect(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8')).toContain('Read it before\\nchoosing review scope.');
    expect(opts.isLastStep0AUQ(target)).toBe(false);
    expect(opts.isLastStep0AUQ(fp('focus', focus))).toBe(true);
    expect(opts.isLastStep0AUQ(paraphrase)).toBe(true);
    if (mode.startsWith('native-')) expect(opts.isLastStep0AUQ(nativeFocus)).toBe(true);
    for (const unrelated of ['Review all 4 design passes, or focus?',
      'Review all 7 engineering passes, or focus?', 'Review all 7 passes, or focus?',
      'Which plan should receive all 7 design passes?']) {
      expect(opts.isLastStep0AUQ(fp('unrelated', unrelated))).toBe(false);
    }
    expect(opts.isReviewAUQ(target)).toBe(false);
    expect(opts.isReviewAUQ(nativeFocus)).toBe(false);
    expect(opts.isReviewAUQ(nativeSetup)).toBe(false);
    expect(opts.isReviewAUQ(nativeFinding)).toBe(true);
    expect(opts.isReviewAUQ(unnumberedFinding)).toBe(true);
    expect(opts.isReviewAUQ(finding)).toBe(true);
    const chosenFocus = mode.startsWith('native-') ? nativeFocus : mode === 'paraphrase' ? paraphrase : fp('focus', focus);
    const pendingCall = {...chosenFocus.nativeCall, answered: false, unansweredQuestionIndices: [0]};
    const pending = nativePlanCallFingerprint(pendingCall, 1000, true);
    pending.nativeQuestionIndex = 0;
    const context = Object.freeze({cwd, deadlineAt: Date.now() + opts.timeoutMs - 5000});
    expect(opts.pickAUQ(pending, pending, context)).toBe(1);
    expect(pickerScope).toEqual(context);
    expect(pickerQuestion).toEqual(pendingCall.questions[0]);
    expect(opts.pickAUQ(chosenFocus, chosenFocus, context)).toBeNull();
    // Replay the retained public menu; this synthetic answer is not a rewrite
    // of its historical Yes. No optional outside-review answer counts as a finding.
    const voicesCall = { sessionId: 'owned-ui-fixture', toolUseId: 'outside-voices-replay',
      answered: false, failed: false, unansweredQuestionIndices: [0],
      questions: [outsideVoices.question] };
    const pendingVoices = nativePlanCallFingerprint(voicesCall, 1000, false);
    pendingVoices.nativeQuestionIndex = 0;
    expect(opts.pickAUQ(pendingVoices, pendingVoices, context)).toBe(2);
    expect(pickerQuestion).toEqual(outsideVoices.question);
    expect(opts.isReviewAUQ(pendingVoices)).toBe(false);
    const declinedVoices = nativePlanCallFingerprint({ ...voicesCall, answered: true,
      unansweredQuestionIndices: [], answers: { [outsideVoices.question.question]: 'No, proceed without' } }, 1000, false);
    expect(opts.isReviewAUQ(declinedVoices)).toBe(false);
    expect(opts.pickAUQ(declinedVoices, declinedVoices, context)).toBeNull();
    const explainedQuestion = outsideVoices.sameLineExplanation77.question;
    const explainedCall = { ...voicesCall, toolUseId: 'outside-voices-explanation-replay', questions: [explainedQuestion] };
    const explainedPending = nativePlanCallFingerprint(explainedCall, 1000, false);
    explainedPending.nativeQuestionIndex = 0;
    expect(opts.pickAUQ(explainedPending, explainedPending, context)).toBe(1);
    expect(pickerQuestion).toEqual(explainedQuestion);
    expect(opts.isReviewAUQ(explainedPending)).toBe(false);
    const explainedDeclined = nativePlanCallFingerprint({ ...explainedCall, answered: true,
      unansweredQuestionIndices: [], answers: { [explainedQuestion.question]: 'No, proceed without (recommended)' } }, 1000, false);
    expect(opts.isReviewAUQ(explainedDeclined)).toBe(false);
    expect(opts.pickAUQ(explainedDeclined, explainedDeclined, context)).toBeNull();
    const unboundBoard = {...pending, nativeCall: undefined, options: [{index: 1, label: 'Submitted'}]};
    expect(() => opts.pickAUQ(unboundBoard, unboundBoard, context)).toThrow('requires an owned native question');
    fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify({ calls, cwd: cwd, seeded: true }));
    if (mode === 'throw') throw new Error('controlled UI observation failure');
    const observed = mode.startsWith('target-menu') ? [target, fp('other', 'Which artifact should I inspect?', false)]
      : mode === 'early-exit' ? [] : mode === 'focus-only' ? [chosenFocus]
      : mode === 'native-setup-only' ? [nativeFocus, nativeSetup]
      : mode === 'native-voices-only' ? [nativeFocus, declinedVoices]
      : mode.startsWith('native-') ? [nativeFocus, nativeSetup, mode === 'native-unnumbered' ? unnumberedFinding : nativeFinding]
      : [chosenFocus, finding];
    if (mode === 'unanswered-finding') observed.at(-1).nativeCall.answered = false;
    if (mode === 'failed-finding') observed.at(-1).nativeCall.failed = true;
    if (mode === 'no-native-finding') delete observed.at(-1).nativeCall;
    return {
      outcome: mode === 'early-exit' ? 'plan_ready' : mode === 'timeout' ? 'timeout' : mode === 'exited' ? 'exited' : 'ceiling_reached',
      fingerprints: observed, step0Count: 1, reviewCount: 1, elapsedMs: 1000,
      evidence: mode === 'early-exit' ? "This plan has no UI scope. A design review isn't applicable."
        : 'Unselected alternative: The other branch may have no UI scope.',
    };
    } finally { ownedFixture.cleanup(); }
  },
}));
if (mode === 'missing-fixture') {
  const read = fs.readFileSync;
  spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    if (String(file) === fixture) throw Object.assign(new Error('UI fixture is missing'), { code: 'ENOENT' });
    return read(file, ...args);
  });
}
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-design-with-ui.test.ts'))});
`);
  try {
    const child = Bun.spawnSync([process.execPath, 'test', script], {
      cwd: ROOT, timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory, TEMP: directory, TMP: directory,
        GIT_CONFIG_NOSYSTEM: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.signalCode ?? null, output).toBeNull();
    const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(observed.calls, output).toBe(mode === 'missing-fixture' ? 0 : 1);
    if (mode !== 'missing-fixture') expect(observed.seeded, output).toBe(true);
    expect(fs.readdirSync(directory).filter(name => name.startsWith('gstack-plan-count-') || name.startsWith('gstack-native-review-state-'))).toEqual([]);
    return { code: child.exitCode, output };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test.each(['source', 'paraphrase', 'native-sequence', 'native-unnumbered', 'native-passes'])('UI gate seeds the exact target and accepts Design progress with an unselected no-UI alternative (%s)', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(0);
}, 20_000);

test.each(['target-menu', 'target-menu-design-system', 'focus-only', 'native-setup-only', 'native-voices-only', 'early-exit', 'timeout', 'exited', 'unanswered-finding', 'failed-finding', 'no-native-finding'])('UI gate rejects %s and removes its fixture', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('plan-design-review with UI scope FAILED');
}, 20_000);

test.each(['throw', 'missing-fixture'])('UI gate preserves %s failure and removes its fixture', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(mode === 'throw' ? 'controlled UI observation failure' : 'UI fixture is missing');
}, 20_000);

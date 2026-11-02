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
// Run 37091743395 slice 8 (987a937b): the five answered native calls, byte-exact,
// whose comma-less Step 0D title the focus predicate once rejected.
const captured = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/design-ui-focus-capture.json'))}, 'utf8'))
  .calls.map(({ preReview, observedAtMs, call }) => nativePlanCallFingerprint(call, observedAtMs, preReview));
// Run 39199692993 slice 4 (521fd755): the Step 0D title omitted 'design'; its body carried the rating.
const capturedRated = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/design-ui-focus-capture-39199692993.json'))}, 'utf8'))
  .calls.map(({ preReview, observedAtMs, call }) => nativePlanCallFingerprint(call, observedAtMs, preReview));
// Run 39298269902 slice 4 (072d4b9), attempts 1 and 2: Opus 5.5 titled Step 0D only
// "Review focus", with the rating in the body and an all-7 option (a2 on one line).
const captured39298269902 = [1, 2].map(attempt => JSON.parse(fs.readFileSync(${JSON.stringify(ROOT)} + '/test/fixtures/design-ui-focus-capture-39298269902-a' + attempt + '.json', 'utf8'))
  .calls.map(({ preReview, observedAtMs, call }) => nativePlanCallFingerprint(call, observedAtMs, preReview)));
// Run 39363705692 slice 4 (a592321): Opus 5.5 rated the plan "4/10 for design completeness"
// and offered "All 7 areas (recommended)" against "Only specific areas".
const captured39363705692 = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/design-ui-focus-capture-39363705692.json'))}, 'utf8'))
  .calls.map(({ preReview, observedAtMs, call }) => nativePlanCallFingerprint(call, observedAtMs, preReview));
// Run 39852003387 slice 4 (357027f): Opus 5.5's ELI10 rated the plan "4/10 on design" (no
// "completeness") and offered "All 7 passes (recommended)" against "States + layout only".
const captured39852003387 = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/design-ui-focus-capture-39852003387.json'))}, 'utf8'))
  .calls.map(({ preReview, observedAtMs, call }) => nativePlanCallFingerprint(call, observedAtMs, preReview));
// Run 40664336141 slice 6 (00e71383): Opus 5.5 asked "I rated this plan 4/10 on design completeness.
// Should I review all 7 areas or focus on a few?" with lettered options ("A) Review all 7 areas").
const captured40664336141 = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'test/fixtures/design-ui-focus-capture-40664336141.json'))}, 'utf8'))
  .calls.map(({ preReview, observedAtMs, call }) => nativePlanCallFingerprint(call, observedAtMs, preReview));
// Runs 41178131219 and 41186376825 slice 6 (a77fae28, 047dad78): Step 0D titled only "Review focus",
// rated in its ELI10 body, and lettered its options ("A) All 7 passes", "A) All 7 dimensions").
const [captured41178131219, captured41186376825] = ['design-ui-focus-capture-41178131219.json', 'design-ui-focus-capture-41186376825.json'].map(name => JSON.parse(fs.readFileSync(${JSON.stringify(ROOT)} + '/test/fixtures/' + name, 'utf8'))
  .calls.map(({ preReview, observedAtMs, call }) => nativePlanCallFingerprint(call, observedAtMs, preReview)));
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
    // Census 36633323521 gate-census-7: the same Step 0D menu titled with "specific ones".
    expect(opts.isLastStep0AUQ(fp('focus-ones', 'D1 — Review all 7 design dimensions, or focus on specific ones?'))).toBe(true);
    if (mode.startsWith('native-')) expect(opts.isLastStep0AUQ(nativeFocus)).toBe(true);
    expect(opts.isLastStep0AUQ(captured[1])).toBe(true);
    expect(opts.isLastStep0AUQ(capturedRated[1])).toBe(true);
    // Runs 39181697029 and 39195396438: the 0D sentence ended "specific areas instead?" (no "of all 7").
    const instead = "I've rated this plan 5/10 on design completeness. The biggest gaps are panel hierarchy/responsive layout, row anatomy plus state copy, and the accessibility contract. I'll generate visual mockups next, then review all 7 dimensions. Want me to focus on specific areas instead?";
    expect(opts.isLastStep0AUQ(fp('instead', 'D2 — ' + instead + '\\nProject/branch/task: main.'))).toBe(true);
    expect(opts.isLastStep0AUQ(fp('instead-split', 'D2 — ' + instead.replace(' The biggest', '\\nThe biggest')))).toBe(true);
    for (const absent of ["D2 — I've rated this plan 5/10 on design completeness.\\nI'll generate visual mockups next.",
      "D2 — I've rated this plan 5/10 on design completeness.\\nWant me to focus on the current branch diff instead?",
      "D2 — Want me to focus on specific areas instead?\\nI'll review the plan next."]) {
      expect(opts.isLastStep0AUQ(fp('instead-absent', absent))).toBe(false);
    }
    for (const unrated of ['D2 — Review focus: all 7 dimensions or specific areas?\\nELI10: I will review every dimension unless you narrow the focus.',
      'D3 — Want outside design voices before the detailed review?\\nELI10: I rated this plan 5/10 on design completeness.',
      'D1 — Which file should I review against the design system?\\nELI10: I rated this plan 5/10 on design completeness.',
      'D2 — Review focus: all 7 dimensions or specific areas?\\nELI10: I rated this plan 5/7 on design completeness.']) {
      expect(opts.isLastStep0AUQ(fp('unrated', unrated))).toBe(false);
    }
    // Run on b2f729b slice 5: the rating sentence led the title and 'design' named only the completeness.
    expect(opts.isLastStep0AUQ(fp('focus-rated', "D2 — I've rated this plan 5/10 on design completeness. Review all 7 dimensions, or focus on specific areas?\\nProject/branch/task: main."))).toBe(true);
    // Run 37166586458 slice 5 (dfaf154): the Step 0D title spelled the count as a word.
    expect(opts.isLastStep0AUQ(fp('focus-word', "D2 — Review all seven design dimensions, or focus on specific areas?\\nProject/branch/task: main branch, design review of the User Dashboard plan before implementation."))).toBe(true);
    for (const unrelated of ['Review all 4 design passes, or focus?',
      'Review all 7 engineering passes, or focus?', 'Review all 7 passes, or focus?',
      'Review all 4 design passes or focus?', 'Review all 7 engineering passes or focus?', 'Review all 7 passes or focus?',
      'Which plan should receive all 7 design passes?', 'Review all seven engineering passes, or focus?',
      'Review all six design passes, or focus?', 'Review all seven passes, or focus?',
      'Review all 7 dimensions, or focus on specific areas?', "I've rated this plan 5/10 on design completeness. Review all 7 dimensions?"]) {
      expect(opts.isLastStep0AUQ(fp('unrelated', unrelated))).toBe(false);
    }
    expect(opts.isReviewAUQ(target)).toBe(false);
    expect(opts.isReviewAUQ(nativeFocus)).toBe(false);
    expect(opts.isReviewAUQ(nativeSetup)).toBe(false);
    expect(opts.isReviewAUQ(nativeFinding)).toBe(true);
    expect(opts.isReviewAUQ(unnumberedFinding)).toBe(true);
    expect(opts.isReviewAUQ(finding)).toBe(true);
    // Titles and option-label prefixes projected from Sep 29 local captures of the
    // real skill. The first four went unrecognized, so the run timed out after
    // four answered findings; issue-numbered option sets identify each finding.
    const labeled = (id, question, labels) => {
      const call = fp(id, question, false);
      call.nativeCall.questions[0].options = labels.map(label => ({ label, description: '' }));
      return call;
    };
    for (const [question, labels] of [
      ['D7 — Issue 1: Codify the page hierarchy from approved Variant A in the plan?', ['1A) Full hierarchy with caps and overflo', '1B) Layout and read order only', '1C) Leave hierarchy out']],
      ['D8 — Issue 2: How does the dashboard fit the existing app shell and navigation?', ['2A) Reuse existing shell, Dashboard nav ', '2B) Standalone minimal header, no nav it', '2C) Leave the shell unspecified']],
      ['D9 — Issue 3: Add a user-visible interaction state table for every dashboard feature?', ['3A) Full state table with copy (recommen', '3B) Structure only, copy TBD', '3C) Leave states as listed']],
      ['D10 — Issue 4: Confirmation pattern and content for "Mark all as read"?', ['4A) Keep modal, specify copy and labels ', '4B) No modal; immediate action plus undo', '4C) Keep modal, leave copy to implemente']],
      ['Issue 1 — What does the user see first on a phone?', ['1A: Notifications first on sm, feed firs', '1B: Feed first everywhere', '1C: Bell badge + drawer on sm']],
    ]) expect(opts.isReviewAUQ(labeled('captured-issue', question, labels))).toBe(true);
    // Runs 39157502890 and 39161502626: the template's Pass 1 hierarchy question, without issue-numbered labels.
    for (const question of ['D5 — Issue 1: What does the user see first, second, third on /dashboard?', 'D5 — Issue 1: What does the user see first on the dashboard?',
      'D5 — Which information hierarchy should the dashboard use?']) {
      expect(opts.isReviewAUQ(labeled('hierarchy', question, ['Notifications panel first (recommended)', 'Activity feed first']))).toBe(true);
    }
    for (const question of ['D5 — Search learnings from your other projects too?', 'D5 — Ready to implement, or run /plan-eng-review next?',
      'D5 — Run /design-shotgun to explore visual variants?', 'D5 — Save the plan and review report?']) {
      expect(opts.isReviewAUQ(labeled('hierarchy-absent', question, ['Notifications panel first (recommended)', 'Activity feed first']))).toBe(false);
    }
    for (const [question, labels] of [
      ['D11 — Update the approved mockups with these decisions?', ['A) Regenerate mockups (recommended)', 'B) Keep the current mockups']],
      ['D12 — Which follow-up should I record?', ['1A) Record a TODO', '2B) Skip it']],
      ['D13 — Which follow-up should I record?', ['1A) Record a TODO', '1A) Record it again']],
      ['D14 — Record this follow-up?', ['1A) Record a TODO']],
      ['D15 — Want outside design voices before the detailed review?', ['1A) Yes, run outside voices', '1B) No, proceed without']],
    ]) expect(opts.isReviewAUQ(labeled('not-a-finding', question, labels))).toBe(false);
    const [focusA1, focusA2] = [captured39298269902[0][1], captured39298269902[1][0]];
    for (const focusCall of [focusA1, focusA2]) {
      expect(opts.isLastStep0AUQ(focusCall)).toBe(true);
      expect(opts.isReviewAUQ(focusCall)).toBe(false);
    }
    expect(opts.isReviewAUQ(captured39298269902[0][4])).toBe(true);
    expect(opts.isLastStep0AUQ(captured39363705692[0])).toBe(true);
    expect(opts.isReviewAUQ(captured39363705692[0])).toBe(false);
    expect(opts.isReviewAUQ(captured39363705692[3])).toBe(true);
    expect(opts.isLastStep0AUQ(captured39852003387[0])).toBe(true);
    expect(opts.isReviewAUQ(captured39852003387[0])).toBe(false);
    expect(captured39852003387.slice(1, 3).some(call => opts.isLastStep0AUQ(call) || opts.isReviewAUQ(call))).toBe(false);
    expect(opts.isReviewAUQ(captured39852003387[3])).toBe(true);
    expect(opts.isLastStep0AUQ(captured40664336141[1])).toBe(true);
    expect(opts.isReviewAUQ(captured40664336141[1])).toBe(false);
    expect([0, 2].some(index => opts.isLastStep0AUQ(captured40664336141[index]))).toBe(false);
    expect(opts.isReviewAUQ(captured40664336141[3])).toBe(true);
    for (const capture of [captured41178131219, captured41186376825]) {
      expect(opts.isLastStep0AUQ(capture[1])).toBe(true);
      expect(opts.isReviewAUQ(capture[1])).toBe(false);
      expect([0, 2].some(index => opts.isLastStep0AUQ(capture[index]) || opts.isReviewAUQ(capture[index]))).toBe(false);
      expect(opts.isReviewAUQ(capture[3])).toBe(true);
    }
    const letteredFocus = 'D2 — Review focus\\nProject/branch/task: main.\\nELI10: I rated this plan 4/10 on design completeness.';
    for (const labels of [['A) All 7 dimensions (recommended)', 'B) Focus on specific areas'], ['A. All seven passes (recommended)', 'B. Hierarchy+states only'],
      ['A: All 7 areas (recommended)', 'B: Only specific areas']]) {
      expect(opts.isLastStep0AUQ(labeled('lettered-focus', letteredFocus, labels)), labels[0]).toBe(true);
    }
    for (const [label, question, labels] of [
      ['lettered-not-leading', letteredFocus, ['A) Review all 7 dimensions (recommended)', 'B) Focus on specific areas']],
      ['lettered-bare', letteredFocus, ['A) All 7', 'B) Focus on specific areas']],
      ['lettered-word-prefix', letteredFocus, ['AB) All 7 dimensions (recommended)', 'B) Focus on specific areas']],
      ['lettered-out-of-seven', letteredFocus.replace('4/10', '4/7'), ['A) All 7 dimensions (recommended)', 'B) Focus on specific areas']],
      ['lettered-without-focus', 'D2 — Which plan should I review?\\nELI10: I rated this plan 4/10 on design completeness.', ['A) All 7 dimensions (recommended)', 'B) PLAN.md']],
    ]) expect(opts.isLastStep0AUQ(labeled(label, question, labels)), label).toBe(false);
    const lettered = ['A) Review all 7 areas (recommended)', 'B) Focus on hierarchy/states/responsive'];
    for (const [label, question, labels] of [
      ['title-offer-unrated', 'D2: Should I review all 7 areas or focus on a few?\\nELI10: I will review every area unless you narrow it.', lettered],
      ['title-offer-out-of-seven', 'D2: I rated this plan 4/7 on design completeness. Should I review all 7 areas or focus on a few?', lettered],
      ['title-offer-without-focus', 'D2: I rated this plan 4/10 on design completeness. Should I review all 7 areas?', lettered],
      ['title-offer-other-count', 'D2: I rated this plan 4/10 on design completeness. Should I review all 4 areas or focus on a few?', lettered],
      ['offer-below-title', 'D2: I rated this plan 4/10 on design completeness. Want me to focus?\\nNext I will review all 7 areas.', lettered],
      ['issue-labeled-title-offer', 'D5 (Issue 3): Keyboard focus across all 7 panels? I rated this plan 4/10 on design completeness.', ['3A Trap focus in the modal', '3B Leave focus order as is']],
      ['single-option-title-offer', 'D2: I rated this plan 4/10 on design completeness. Should I review all 7 areas or focus on a few?', lettered.slice(0, 1)],
    ]) expect(opts.isLastStep0AUQ(labeled(label, question, labels)), label).toBe(false);
    const areas = ['All 7 areas (recommended)', 'Only specific areas'];
    for (const body of ['ELI10: I rated this plan 4/10 for design completeness.', 'ELI10: This plan is a 3/10 on design completeness.',
      'ELI10: Design completeness: 6.5/10. The gaps are layout and states.', 'ELI10: I rated this plan 4/10 on design.']) {
      expect(opts.isLastStep0AUQ(labeled('worded-rating', 'D1 — Review focus\\nProject/branch/task: main.\\n' + body, areas))).toBe(true);
    }
    for (const [label, question, labels] of [
      ['rating-split-across-sentences', 'D1 — Review focus\\nELI10: I rated this plan 4/10. Design completeness matters most here.', areas],
      ['rating-out-of-seven', 'D1 — Review focus\\nELI10: I rated this plan 4/7 for design completeness.', areas],
      ['rating-not-design', 'D1 — Review focus\\nELI10: I rated this plan 4/10 for test completeness.', areas],
      ['design-split-from-rating', 'D1 — Review focus\\nELI10: I rated this plan 4/10. The design needs mockups first.', areas],
      ['rating-unscored-design', 'D1 — Review focus\\nELI10: I rated this plan on design. It needs mockups first.', areas],
      ['areas-without-focus', 'D1 — Which plan should I review?\\nELI10: I rated this plan 4/10 for design completeness.', areas],
      ['areas-not-leading', 'D1 — Review focus\\nELI10: I rated this plan 4/10 for design completeness.', ['Review all 7 areas (recommended)', 'Only specific areas']],
      ['issue-labeled-areas', 'D5 — Issue 1: Which panel leads the review focus?\\nELI10: I rated this plan 4/10 for design completeness.', ['1A All 7 areas first', '1B Activity first']],
      ['bare-all-seven', 'D1 — Review focus\\nELI10: I rated this plan 4/10 for design completeness.', ['All 7', 'Only specific areas']],
    ]) expect(opts.isLastStep0AUQ(labeled(label, question, labels)), label).toBe(false);
    const ratedBody = 'Project/branch/task: main. ELI10: I rated this plan 4/10 on design completeness.';
    const ratedFinding = labeled('rated-finding', 'D5 — Issue 1: Which panel leads the review focus? ' + ratedBody, ['1A All 7 dimensions first', '1B Activity first']);
    expect(opts.isLastStep0AUQ(ratedFinding)).toBe(false);
    expect(opts.isReviewAUQ(ratedFinding)).toBe(true);
    for (const [label, labels] of [['single-option-focus', ['All 7 dimensions (recommended)']], ['no-all-seven-option', ['Every dimension (recommended)', 'States + hierarchy only']],
      ['all-seven-not-leading', ['Review all 7 dimensions (recommended)', 'States + hierarchy only']]]) {
      expect(opts.isLastStep0AUQ(labeled(label, 'D1 — Review focus. ' + ratedBody, labels))).toBe(false);
    }
    expect(opts.isLastStep0AUQ(labeled('unrated-focus', 'D1 — Review focus. Project/branch/task: main. ELI10: I rated this plan 4/7 on design completeness.',
      ['All 7 passes (recommended)', 'States + hierarchy only']))).toBe(false);
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
    const observed = mode === 'captured' ? captured
      : mode === 'captured-rated' ? capturedRated
      : mode === 'captured-rated-no-focus' ? capturedRated.filter((_, index) => index !== 1)
      : mode === 'captured-no-focus' ? captured.filter((_, index) => index !== 1)
      : mode === 'captured-39298269902' ? captured39298269902[0]
      : mode === 'captured-39298269902-no-focus' ? captured39298269902[0].filter((_, index) => index !== 1)
      : mode === 'captured-39298269902-focus-only' ? captured39298269902[1]
      : mode === 'captured-39363705692' ? captured39363705692
      : mode === 'captured-39363705692-no-focus' ? captured39363705692.filter((_, index) => index !== 0)
      : mode === 'captured-39852003387' ? captured39852003387
      : mode === 'captured-39852003387-no-focus' ? captured39852003387.filter((_, index) => index !== 0)
      : mode === 'captured-40664336141' ? captured40664336141
      : mode === 'captured-40664336141-no-focus' ? captured40664336141.filter((_, index) => index !== 1)
      : mode === 'captured-41178131219' ? captured41178131219
      : mode === 'captured-41178131219-no-focus' ? captured41178131219.filter((_, index) => index !== 1)
      : mode === 'captured-41186376825' ? captured41186376825
      : mode === 'captured-41186376825-no-focus' ? captured41186376825.filter((_, index) => index !== 1)
      : mode === 'captured-focus-after-finding' ? [...captured.filter((_, index) => index !== 1), captured[1]]
      : mode.startsWith('target-menu') ? [target, fp('other', 'Which artifact should I inspect?', false)]
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

test.each(['source', 'paraphrase', 'native-sequence', 'native-unnumbered', 'native-passes', 'captured', 'captured-rated', 'captured-39298269902', 'captured-39363705692', 'captured-39852003387', 'captured-40664336141', 'captured-41178131219', 'captured-41186376825'])('UI gate seeds the exact target and accepts Design progress with an unselected no-UI alternative (%s)', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(0);
}, 20_000);

test.each(['target-menu', 'target-menu-design-system', 'focus-only', 'captured-no-focus', 'captured-focus-after-finding', 'captured-rated-no-focus', 'captured-39298269902-no-focus', 'captured-39298269902-focus-only', 'captured-39363705692-no-focus', 'captured-39852003387-no-focus', 'captured-40664336141-no-focus', 'captured-41178131219-no-focus', 'captured-41186376825-no-focus', 'native-setup-only', 'native-voices-only', 'early-exit', 'timeout', 'exited', 'unanswered-finding', 'failed-finding', 'no-native-finding'])('UI gate rejects %s and removes its fixture', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('plan-design-review with UI scope FAILED');
}, 20_000);

test.each(['throw', 'missing-fixture'])('UI gate preserves %s failure and removes its fixture', mode => {
  const result = exercise(mode);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(mode === 'throw' ? 'controlled UI observation failure' : 'UI fixture is missing');
}, 20_000);

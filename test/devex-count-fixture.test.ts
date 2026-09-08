import { describe, expect, test } from 'bun:test';
import type { AskUserQuestionFingerprint } from './helpers/claude-pty-runner';
import {
  DEVEX_COUNT_FILES,
  planDevexCountFixture,
  isDevexReviewIssue,
  devexReviewModePick,
} from './helpers/devex-count-fixture';

let nextCall = 0;
function call(question: string, labels = ['Add to plan', 'Defer']): AskUserQuestionFingerprint {
  const toolUseId = `tool-${++nextCall}`;
  return {
    signature: `session:${toolUseId}`, promptSnippet: question,
    options: labels.map((label, i) => ({ index: i + 1, label })),
    observedAtMs: 0, preReview: true,
    nativeCall: {
      sessionId: 'session', toolUseId, answered: true,
      answers: { [question]: labels[0]! },
      questions: [{ header: 'DX decision', question, options: labels.map(label => ({ label })) }],
    },
  };
}

const issues = [
  ['CI gate', 'Journey Stage: HELLO WORLD. The mandatory five-minute CI gate blocks the first local evaluation. Remove the gate or make it optional for local runs?'],
  ['Argument order', 'run_eval(dataset, evaluator) and run_batch(evaluator, dataset) reverse the positional order. Should we standardize these signatures or require keyword arguments?'],
  ['Authentication error', 'An invalid API key raises AuthError("request failed"), with no explanation or recovery guidance. How should we replace this opaque error?'],
  ['Packaged example', 'The quickstart tells developers to run examples/first_eval.py, but it is absent from the published package. Include the example or fix the documented command?'],
  ['Breaking rename', 'Version 2 removes Client.evaluate and replaces it with Client.run without a migration guide or deprecation warning. Add a compatibility alias or a migration path?'],
] as const;

describe('DevEx substantive finding coverage', () => {
  test('the observed mandatory confirmations alone contribute zero findings', () => {
    const confirmations = [
      'No design doc found. Run /office-hours first? <gstack-qid:plan-devex-review-office-hours-preflight>',
      'Who is your primary target developer? <gstack-qid:plan-devex-review-persona>',
      'Does the empathy narrative match reality? <gstack-qid:plan-devex-review-empathy-check>',
      // A concrete defect in a benchmark recap does not make the target
      // confirmation itself a resolution decision for that defect.
      'Remove the mandatory CI wait before first eval to reach the agreed benchmark. Which tier do you confirm? <gstack-qid:plan-devex-review-tthw-tier>',
      'What should the magical first-eval moment look like? <gstack-qid:plan-devex-review-magical-moment>',
      'How deep should this DX review go? <gstack-qid:plan-devex-review-mode>',
      'Confusion report reviewed. Which items should be addressed? <gstack-qid:plan-devex-review-confusion-report>',
      'Which onboarding setup should run next? <gstack-qid:future-setup-choice>',
    ];
    expect(confirmations.map(question => call(question)).filter(isDevexReviewIssue)).toEqual([]);
  });

  test.each(issues)('%s is a finding in investigation or scoring', (_name, question) => {
    const fp = call(question);
    expect(isDevexReviewIssue(fp)).toBe(true);
    fp.preReview = false;
    expect(isDevexReviewIssue(fp)).toBe(true);
  });

  test('full native question evidence survives a short diagnostic snippet', () => {
    const fp = call('Context from the SDK audit. '.repeat(20) + issues[3][1]);
    fp.promptSnippet = fp.promptSnippet.slice(0, 240);
    expect(fp.promptSnippet).not.toContain('examples/first_eval.py');
    expect(isDevexReviewIssue(fp)).toBe(true);
  });

  test('a real argument-order decision does not need a particular resolution verb', () => {
    const fp = call('Which argument order should run_eval and run_batch use?', [
      'Dataset first in both functions', 'Evaluator first in both functions',
    ]);
    expect(isDevexReviewIssue(fp)).toBe(true);
  });

  test.each([
    'Design doc', 'Target persona', 'Narrative check', 'TTHW target',
    'Magic delivery', 'Review mode', 'Fix scope',
  ])('observed administrative header %s cannot borrow a defect from its recap', header => {
    const fp = call(`${issues[0][1]} This is the context for our confirmation.`);
    fp.nativeCall!.questions[0]!.header = header;
    expect(isDevexReviewIssue(fp)).toBe(false);
  });

  test('a CI issue stays substantive when it references persona and TTHW evidence', () => {
    const fp = call('The target persona confirmed our TTHW target. The mandatory CI gate blocks the first eval. Which local bypass should the SDK support?');
    fp.nativeCall!.questions[0]!.header = 'CI gate fix';
    expect(isDevexReviewIssue(fp)).toBe(true);
  });

  test('one call batching the defects does not become five finding decisions', () => {
    const distinct = issues.map(([, question]) => call(question));
    expect(distinct.filter(isDevexReviewIssue)).toHaveLength(5);
    const batched = call('Review these issues together.');
    batched.nativeCall!.questions = distinct.flatMap(fp => fp.nativeCall!.questions);
    batched.nativeCall!.answers = Object.assign({}, ...distinct.map(fp => fp.nativeCall!.answers));
    expect([batched].filter(isDevexReviewIssue)).toHaveLength(1);
  });

  test('an unanswered issue tab cannot turn an administrative answer into coverage', () => {
    const admin = call('How deep should this DX review go? <gstack-qid:plan-devex-review-mode>');
    const issue = call(issues[0][1]);
    admin.nativeCall!.questions.push(issue.nativeCall!.questions[0]!);
    admin.nativeCall!.unansweredQuestionIndices = [1];
    expect(isDevexReviewIssue(admin)).toBe(false);
    Object.assign(admin.nativeCall!.answers!, issue.nativeCall!.answers);
    admin.nativeCall!.unansweredQuestionIndices = [];
    expect(isDevexReviewIssue(admin)).toBe(true);
  });

  test.each([
    'Which files should I review? <gstack-qid:unknown-administrative-choice>',
    'I noted the mandatory CI gate before first eval. Can we continue the setup?',
    'Should I add a developer community Slack channel?',
    'Should the plan reference run_eval and run_batch?',
    'The package includes examples/first_eval.py. Shall I read it?',
    'Authentication errors already include a cause and a fix. Ready to continue?',
  ])('unknown or unsupported prompts do not count: %s', question => {
    expect(isDevexReviewIssue(call(question))).toBe(false);
  });

  test('a generic question cannot borrow issue evidence from its option labels', () => {
    expect(isDevexReviewIssue(call('What should I inspect next?', [issues[0][1], issues[1][1]]))).toBe(false);
  });
});

describe('DevEx count review-mode selection', () => {
  const modeQuestion = 'D6 — How deep should this DX review go? <gstack-qid:plan-devex-review-mode>';

  test('selects POLISH from the actual menu that previously chose EXPANSION', () => {
    expect(devexReviewModePick(call(modeQuestion, [
      'DX EXPANSION (Recommended)', 'DX POLISH', 'DX TRIAGE',
    ]))).toBe(2);
  });

  test('retains the observed POLISH index after menu reordering', () => {
    expect(devexReviewModePick(call(modeQuestion, [
      'DX TRIAGE', 'DX EXPANSION', 'DX POLISH (Recommended)',
    ]))).toBe(3);
  });

  test('recognizes the same mode question without a question ID', () => {
    expect(devexReviewModePick(call('HowdeepshouldthisDXreviewgo?', [
      'DXEXPANSION(Recommended)', 'DXPOLISH', 'DXTRIAGE',
    ]))).toBe(2);
  });

  test('unrelated questions cannot select a mode from quoted labels', () => {
    expect(devexReviewModePick(call('Which documentation example should be included?', [
      'DX EXPANSION', 'DX POLISH', 'DX TRIAGE',
    ]))).toBeNull();
    expect(devexReviewModePick(call(issues[0][1]))).toBeNull();
  });

  test('missing or ambiguous mode menus keep the existing choice policy', () => {
    expect(devexReviewModePick(call(modeQuestion, ['DX EXPANSION', 'DX TRIAGE']))).toBeNull();
    expect(devexReviewModePick(call(modeQuestion, [
      'DX EXPANSION', 'DX POLISH', 'DX POLISH', 'DX TRIAGE',
    ]))).toBeNull();
    expect(devexReviewModePick(call(modeQuestion, [
      'DX EXPANSION │ DX POLISH', 'Example │ DX POLISH', 'DX TRIAGE',
    ]))).toBeNull();
  });

  test('a multi-question call is not treated as a single mode menu', () => {
    const fp = call(modeQuestion, ['DX EXPANSION', 'DX POLISH', 'DX TRIAGE']);
    fp.nativeCall!.questions.push(call(issues[0][1]).nativeCall!.questions[0]!);
    expect(devexReviewModePick(fp)).toBeNull();
  });
});

describe('DevEx calibrated fixture instructions', () => {
  test('keeps the reviewed artifact path without telling the model an expected count', () => {
    const plan = planDevexCountFixture('/tmp/owned-plan.md');
    expect(plan).toContain('write your plan-mode plan to /tmp/owned-plan.md');
    const suppliedContext = [plan, ...Object.values(DEVEX_COUNT_FILES)].join('\n');
    expect(suppliedContext).not.toMatch(/(?:exactly|at least|at most)\s+(?:five|5)|(?:five|5)[- ]findings?|4[-–]7|reviewCount|CEILING|FLOOR/i);
  });
});


describe('native first-local-run CI decisions', () => {
  const question =
    'D3 \u2014 Journey Stage: FIRST RESULT \u2014 5-minute CI gate makes the <2min TTHW target mathematically unreachable\n\nELI10: On every first local run, the SDK blocks for 5 minutes waiting for a remote CI check (docs/current-contracts.md). There is no skip flag. The TTHW study measured EvalKit at 6 minutes total (docs/benchmarks.md). The agreed target is under 2 minutes. With a mandatory 5-minute wait baked in, you cannot reach that target \u2014 the CI gate alone exceeds it. Competitors: A=2min, B=4min, C=3min. EvalKit currently loses on TTHW.\n\nStakes if we pick wrong: If the target stays <2min but the gate stays too, the benchmark is aspirational theatre. If the gate stays and the target is adjusted, the competitive position is weaker.\n\nRecommendation: A \u2014 add a local skip path. The CI gate adds real value in production CI, but blocking local first-runs is the wrong tradeoff for an SDK that wants sub-2min TTHW.\nNote: options differ in kind, not coverage \u2014 no completeness score.\n\n<gstack-qid:plan-devex-review-ci-gate>';
  test('the answered first-local-run CI gate is substantive, including its plural variant', () => {
    for (const text of [
      question,
      question.replace('first local run', 'first local runs'),
    ]) {
      const fp = call(text);
      fp.nativeCall!.questions[0]!.header = 'CI gate TTHW';
      expect(isDevexReviewIssue(fp)).toBe(true);
    }
  });
  test('an unanswered CI tab and an administrative recap never create coverage', () => {
    const fp = call('Does the empathy narrative match reality?');
    fp.nativeCall!.questions[0]!.header = 'Empathy check';
    fp.nativeCall!.questions.push({
      header: 'CI gate TTHW',
      question,
      options: [{ label: 'Skip CI' }, { label: 'Keep CI' }],
    });
    fp.nativeCall!.unansweredQuestionIndices = [1];
    expect(isDevexReviewIssue(fp)).toBe(false);
    fp.nativeCall!.answers![question] = 'Skip CI';
    fp.nativeCall!.unansweredQuestionIndices = [];
    expect(isDevexReviewIssue(fp)).toBe(true);
    const recap = call(question);
    recap.nativeCall!.questions[0]!.header = 'Empathy check';
    expect(isDevexReviewIssue(recap)).toBe(false);
    expect(
      isDevexReviewIssue(
        call(
          'The production CI gate waits five minutes. Change the release check?',
        ),
      ),
    ).toBe(false);
  });
});

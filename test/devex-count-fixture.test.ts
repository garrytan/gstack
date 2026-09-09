import capturedURetry from './fixtures/devex-count-u-retry-calls.json';
import capturedU from './fixtures/devex-count-u-calls.json';


import { describe, expect, test } from 'bun:test';
import type { AskUserQuestionFingerprint } from './helpers/claude-pty-runner';
import capturedL from './fixtures/devex-review-l-calls.json';
import capturedN from './fixtures/devex-review-n-calls.json';
import capturedT from './fixtures/devex-review-t-calls.json';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall } from './helpers/plan-count-transcript';
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
  test('the actual untagged empathy confirmation does not borrow a finding from its recap', () => {
    const actual = structuredClone(capturedL.calls[0]!);
    const fp = call(actual.questions[0]!.question);
    fp.nativeCall = actual;
    expect(isDevexReviewIssue(fp)).toBe(false);
    // An empathy-derived remedy decision is still substantive. The exclusion
    // requires the confirmation question, not merely a familiar header.
    const question = issues[0][1];
    actual.questions[0]!.question = question;
    actual.answers = { [question]: actual.questions[0]!.options[0]!.label };
    expect(isDevexReviewIssue(fp)).toBe(true);
  });
  test('an empathy-shaped question with remedy choices stays substantive', () => {
    for (const mixed of [false, true]) {
      const actual = structuredClone(capturedL.calls[0]!);
      const fp = call(actual.questions[0]!.question);
      fp.nativeCall = actual;
      if (mixed) actual.questions[0]!.options.push({label:'Package the missing example',description:'Fix the quickstart now'});
      else actual.questions[0]!.options = [{label:'Package the missing example',description:'Fix the quickstart now'}, {label:'Leave the example absent',description:'Defer the fix'}];
      actual.answers = { [actual.questions[0]!.question]: actual.questions[0]!.options[0]!.label };
      expect(isDevexReviewIssue(fp)).toBe(true);
    }
  });
  test('a correction label cannot hide an instruction to fix the package', () => {
    const actual = structuredClone(capturedL.calls[0]!);
    actual.questions[0]!.options[1]!.label = 'Partially — the example is absent; package it now';
    const fp = call(actual.questions[0]!.question);
    fp.nativeCall = actual;
    expect(isDevexReviewIssue(fp)).toBe(true);
  });
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


describe('native developer-trace accuracy confirmation', () => {
  const actualCalls = () => structuredClone(capturedN.calls) as NativePlanQuestionCall[];
  const actual = () => actualCalls()[0]!;
  const fp = (native: NativePlanQuestionCall) => nativePlanCallFingerprint(native, 0, true);

  test('the captured developer narrative confirms evidence and retains all five actual issue decisions', () => {
    const input = actualCalls();
    const before = structuredClone(input);
    expect(isDevexReviewIssue(fp(input[0]!))).toBe(false);
    expect(input.filter(native => isDevexReviewIssue(fp(native)))).toHaveLength(5);
    expect(input.slice(1).every(native => isDevexReviewIssue(fp(native)))).toBe(true);
    expect(input).toEqual(before);
  });

  test('accuracy labels cannot hide remedy choices or a substantive repair question', () => {
    for (const mutate of [
      (native: NativePlanQuestionCall) => { native.questions[0]!.question = issues[3][1]; },
      (native: NativePlanQuestionCall) => { native.questions[0]!.options[0]!.label = 'Package the missing example now'; },
      (native: NativePlanQuestionCall) => { native.questions[0]!.options[1]!.description = 'Package the missing example now.'; },
      (native: NativePlanQuestionCall) => { native.questions[0]!.question += ' Should I package the missing examples/first_eval.py to fix this quickstart?'; },
      (native: NativePlanQuestionCall) => { native.questions[0]!.question = native.questions[0]!.question.replace('Does this match the actual experience?', 'Should I package the missing examples/first_eval.py to fix this quickstart? Does this match the actual experience?'); },
      (native: NativePlanQuestionCall) => { native.questions[0]!.question = native.questions[0]!.question.replace('Does this match the actual experience?', 'Do you want me to package the missing examples/first_eval.py to fix this quickstart? Does this match the actual experience?'); },
      (native: NativePlanQuestionCall) => { native.questions[0]!.question = native.questions[0]!.question.replace('Does this match the actual experience?', 'Would you like the missing examples/first_eval.py packaged? Does this match the actual experience?'); },
      (native: NativePlanQuestionCall) => { native.questions[0]!.question = native.questions[0]!.question.replace('Does this match the actual experience?', 'Approve packaging the missing examples/first_eval.py? Does this match the actual experience?'); },
      (native: NativePlanQuestionCall) => { native.questions[0]!.question = native.questions[0]!.question.replace('Does this match the actual experience?', 'Please package the missing examples/first_eval.py. Does this match the actual experience?'); },
      (native: NativePlanQuestionCall) => { native.questions[0]!.options[0]!.description = 'Proceed to package the missing examples/first_eval.py so the quickstart works.'; },
      (native: NativePlanQuestionCall) => { native.questions[0]!.options.push({ label: 'Fix the API argument order' }); },
      (native: NativePlanQuestionCall) => { native.questions[0]!.question += ' <gstack-qid:plan-devex-example-fix>'; },
    ]) {
      const native = actual();
      mutate(native);
      native.answers = { [native.questions[0]!.question]: native.questions[0]!.options[0]!.label };
      expect(isDevexReviewIssue(fp(native))).toBe(true);
    }
  });

  test('an answered issue beside the narrative still counts the native call once', () => {
    const native = actual();
    const issue = actualCalls()[1]!;
    native.questions.push(issue.questions[0]!);
    native.unansweredQuestionIndices = [1];
    expect(isDevexReviewIssue(fp(native))).toBe(false);
    Object.assign(native.answers!, issue.answers);
    native.unansweredQuestionIndices = [];
    expect([native].filter(value => isDevexReviewIssue(fp(value)))).toHaveLength(1);
    native.answered = false;
    expect(isDevexReviewIssue(fp(native))).toBe(false);
  });
});

describe('T native documentation follow-up decisions', () => {
  const calls = () => structuredClone(capturedT.calls) as NativePlanQuestionCall[];
  const fp = (native: NativePlanQuestionCall) => nativePlanCallFingerprint(native, 0, true);
  const changeQuestion = (native: NativePlanQuestionCall, transform: (s: string) => string) => {
    const q = native.questions[0]!;
    const answer = native.answers![q.question]!;
    q.question = transform(q.question);
    native.answers = { [q.question]: answer };
    return native;
  };

  test('the complete captured census keeps empathy setup and seven distinct issue calls', () => {
    const actual = calls(); const before = structuredClone(actual);
    expect(actual.map(c => isDevexReviewIssue(fp(c)))).toEqual([false, true, true, true, true, true, true, true]);
    expect(actual).toEqual(before);
  });

  for (const index of [6, 7]) {
    test(`follow-up ${index} requires complete native offered-answer identity`, () => {
      for (const mutate of [
        (c: NativePlanQuestionCall) => { c.failed = true; },
        (c: NativePlanQuestionCall) => { delete c.failed; },
        (c: NativePlanQuestionCall) => { c.answered = false; },
        (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
        (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
        (c: NativePlanQuestionCall) => { c.answers = {}; },
        (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Foreign answer' }; },
        (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
        (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
        (c: NativePlanQuestionCall) => { c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[0]!)); },
      ]) { const c = calls()[index]!; mutate(c); expect(isDevexReviewIssue(fp(c))).toBe(false); }
      const foreign = fp(calls()[index]!); foreign.signature = 'foreign:call'; expect(isDevexReviewIssue(foreign)).toBe(false);
      const screen = fp(calls()[index]!); delete screen.nativeCall; expect(isDevexReviewIssue(screen)).toBe(false);
    });

    test(`follow-up ${index} cannot borrow an unselected remedy or a setup identity`, () => {
      const skipped = calls()[index]!; const q = skipped.questions[0]!;
      skipped.answers = { [q.question]: q.options.at(-1)!.label };
      expect(isDevexReviewIssue(fp(skipped))).toBe(false);
      for (const header of ['Empathy check', 'Review mode', 'Next steps']) {
        const c = calls()[index]!; c.questions[0]!.header = header; expect(isDevexReviewIssue(fp(c))).toBe(false);
      }
      for (const replacement of ['<gstack-qid:devex-mode>', '<gstack-qid:devex-next-steps>', '<gstack-qid:foreign>']) {
        const c = changeQuestion(calls()[index]!, s => s.replace(/<gstack-qid:[^>]+>/, replacement));
        expect(isDevexReviewIssue(fp(c))).toBe(false);
      }
      const duplicate = changeQuestion(calls()[index]!, s => s + ' <gstack-qid:devex-extra>');
      expect(isDevexReviewIssue(fp(duplicate))).toBe(false);
    });
  }

  test('a resolved documentation gap, quoted example or removed follow-up obligation earns no new credit', () => {
    for (const transform of [
      (s: string) => s.replace('but never says where to get one', 'and already says where to get one'),
      (s: string) => s.replace('Documentation — README', 'Documentation — It is false that README'),
      (s: string) => '> ' + s,
      (s: string) => '```text\n' + s + '\n```',
    ]) expect(isDevexReviewIssue(fp(changeQuestion(calls()[6]!, transform)))).toBe(false);
    for (const transform of [
      (s: string) => s.replace('**What:** Add', '**What:** Do not add'),
      (s: string) => s.replace('additional examples/ files', 'the already-approved quickstart file'),
      (s: string) => '> ' + s,
      (s: string) => '```text\n' + s + '\n```',
    ]) expect(isDevexReviewIssue(fp(changeQuestion(calls()[7]!, transform)))).toBe(false);
  });

  test('option reordering preserves the exact selected remedy and each native call counts once', () => {
    for (const c of calls().slice(6)) {
      c.questions[0]!.options.reverse();
      expect([c].filter(c => isDevexReviewIssue(fp(c)))).toHaveLength(1);
    }
  });
});

describe('U completed first-pass contract decisions', () => {
  const calls = () => structuredClone(capturedU.calls) as NativePlanQuestionCall[];
  const fp = (call: NativePlanQuestionCall) => nativePlanCallFingerprint(call, 0, true);
  const change = (call: NativePlanQuestionCall, transform: (s: string) => string) => {
    const q = call.questions[0]!; const answer = call.answers![q.question]!;
    q.question = transform(q.question); call.answers = {[q.question]: answer}; return call;
  };
  test('all five actual seed decisions count once, without mutating evidence', () => {
    const actual = calls(); const before = structuredClone(actual);
    expect(actual.map(call => isDevexReviewIssue(fp(call)))).toEqual([true, true, true, true, true]);
    expect(actual).toEqual(before);
  });
  for (const index of [0, 1]) {
    test(`decision ${index + 1} requires complete native identity and an offered answer`, () => {
      expect(isDevexReviewIssue(fp(calls()[index]!))).toBe(true);
      for (const mutate of [
        (c: NativePlanQuestionCall) => { c.answered = false; },
        (c: NativePlanQuestionCall) => { c.failed = true; },
        (c: NativePlanQuestionCall) => { delete c.failed; },
        (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
        (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
        (c: NativePlanQuestionCall) => { c.answers = {}; },
        (c: NativePlanQuestionCall) => { c.answers = {[c.questions[0]!.question]: 'Foreign answer'}; },
        (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
        (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
        (c: NativePlanQuestionCall) => { c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[0]!)); },
      ]) { const c = calls()[index]!; mutate(c); expect(isDevexReviewIssue(fp(c))).toBe(false); }
      const foreign = fp(calls()[index]!); foreign.signature = 'foreign:tool'; expect(isDevexReviewIssue(foreign)).toBe(false);
      const ui = fp(calls()[index]!); delete ui.nativeCall; expect(isDevexReviewIssue(ui)).toBe(false);
    });
    test(`decision ${index + 1} cannot borrow issue words for setup or quoted examples`, () => {
      for (const transform of [
        (s: string) => '> ' + s,
        (s: string) => '```text\n' + s + '\n```',
        (s: string) => s.replace(/Pass 1 \(Getting Started\):/, 'Pass 1 (Getting Started): It is false that'),
        (s: string) => s.replace(/<gstack-qid:[^>]+>/, '<gstack-qid:plan-devex-review-mode>'),
        (s: string) => s + ' <gstack-qid:another>',
      ]) expect(isDevexReviewIssue(fp(change(calls()[index]!, transform)))).toBe(false);
      const c = calls()[index]!; c.questions[0]!.header = 'Review mode'; expect(isDevexReviewIssue(fp(c))).toBe(false);
    });
    test(`decision ${index + 1} keeps a distinct accepted or deferred decision independent of option order`, () => {
      const c = calls()[index]!; const q = c.questions[0]!;
      q.options.reverse(); expect(isDevexReviewIssue(fp(c))).toBe(true);
      c.answers = {[q.question]: q.options[0]!.label}; expect(isDevexReviewIssue(fp(c))).toBe(true);
    });
  }
  test('resolved or negated first-run contracts and pure navigation do not count', () => {
    for (const transform of [
      (s: string) => s.replace("doesn't ship", 'already ships'),
      (s: string) => s.replace('quickstart points to', 'quickstart no longer points to'),
      (s: string) => s.replace('Should we fix the quickstart path in the plan?', 'Should we begin the review?'),
      (s: string) => s.replace('Should we fix', 'Should we not fix'),
    ]) expect(isDevexReviewIssue(fp(change(calls()[0]!, transform)))).toBe(false);
    for (const transform of [
      (s: string) => s.replace('makes that unreachable', 'makes that reachable'),
      (s: string) => s.replace('makes that unreachable', 'does not make that unreachable'),
      (s: string) => s.replace('The plan retains the gate.', 'The plan already skips the gate.'),
      (s: string) => s.replace('How should this plan handle the contradiction?', 'Should we begin the review?'),
    ]) expect(isDevexReviewIssue(fp(change(calls()[1]!, transform)))).toBe(false);
  });
});


describe('U demo timing decision after completed measurements', () => {
  const captured = () => structuredClone(capturedURetry[0]!) as NativePlanQuestionCall;
  const fp = (c: NativePlanQuestionCall) => nativePlanCallFingerprint(c, 0, true);
  function replace(c: NativePlanQuestionCall, from: string, to: string) {
    const q = c.questions[0]!; const old = q.question; q.question = old.replace(from, to);
    if (c.answers) c.answers = { [q.question]: c.answers[old]! };
    return c;
  }
  test('all five actual completed calls are independent issue decisions', () => {
    const calls = structuredClone(capturedURetry) as NativePlanQuestionCall[];
    expect(calls.map(c => isDevexReviewIssue(fp(c)))).toEqual([true, true, true, true, true]);
    expect(calls).toEqual(capturedURetry);
    const c = captured(); c.questions[0]!.options.reverse();
    expect(isDevexReviewIssue(fp(c))).toBe(true);
    c.answers = { [c.questions[0]!.question]: c.questions[0]!.options[0]!.label };
    expect(isDevexReviewIssue(fp(c))).toBe(true); // Deferring the repair is still this decision.
  });
  test('timings are compared instead of pinning the observed minutes', () => {
    let c = captured();
    for (const [from,to] of [['<2 min','<3 min'],['under 2 minutes','under 3 minutes'],['blocks for 5 minutes','blocks for 4 minutes'],['measured TTHW of 6 minutes','measured TTHW of 5 minutes']]) c=replace(c,from!,to!);
    expect(isDevexReviewIssue(fp(c))).toBe(true);
    for (const [from,to] of [['blocks for 5 minutes','blocks for 1 minutes'],['measured TTHW of 6 minutes','measured TTHW of 4 minutes'],['under 2 minutes','under 9 minutes']])
      expect(isDevexReviewIssue(fp(replace(captured(),from!,to!)))).toBe(false);
  });
  test('setup, negated, quoted and merely hypothetical timing claims remain outside the new arm', () => {
    for (const [from,to] of [
      ['should it bypass the mandatory CI check to reach the <2 min TTHW target?', 'which TTHW target should we confirm?'],
      ['ELI10: The agreed onboarding target is under 2 minutes', 'Example: ELI10: The agreed onboarding target is under 2 minutes'],
      ['ELI10: The agreed onboarding target is under 2 minutes', '> ELI10: The agreed onboarding target is under 2 minutes'],
      ['ELI10: The agreed onboarding target is under 2 minutes', '```text\nELI10: The agreed onboarding target is under 2 minutes'],
      ['Today `python -m evalkit.demo` blocks', 'Today `python -m evalkit.demo` no longer blocks'],
      ['Today `python -m evalkit.demo` blocks', 'It is false that `python -m evalkit.demo` blocks'],
      ['Today `python -m evalkit.demo` blocks', 'If `python -m evalkit.demo` blocks'],
      ['giving a measured TTHW of 6 minutes', 'giving a measured TTHW of 6 minutes only if the optional slow simulation is enabled'],
      ['giving a measured TTHW of 6 minutes', 'giving a measured TTHW of 6 minutes only in a hypothetical example'],
      ['devex-demo-ci-bypass', 'plan-devex-review-tthw-tier'],
    ]) expect(isDevexReviewIssue(fp(replace(captured(),from!,to!)))).toBe(false);
    const c = captured(); c.questions[0]!.header = 'TTHW target'; expect(isDevexReviewIssue(fp(c))).toBe(false);
  });
  test('the new measured branch requires one complete matched native decision', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { delete c.unansweredQuestionIndices; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(c.questions[0]!)); },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options.push(structuredClone(c.questions[0]!.options[0]!)); },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'unoffered answer' }; },
    ]) { const c=captured(); mutate(c); expect(isDevexReviewIssue(fp(c))).toBe(false); }
    expect(isDevexReviewIssue({...fp(captured()), signature:'foreign:call'})).toBe(false);
    expect(isDevexReviewIssue({...fp(captured()), nativeCall:undefined})).toBe(false);
  });
});

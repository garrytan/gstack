import cddRegression from './fixtures/eng-cdd-regression-task.json';
import ledgerSeedFixture from './fixtures/eng-current-ledger-seeds.json';
import neutralSeedFixture from './fixtures/eng-neutral-seed-749df.json';
import pairedSuiteFixture from './fixtures/eng-paired-suite-749df.json';
import a689Retry from './fixtures/eng-a689-retry-public.json';
import fb10Public from './fixtures/eng-fb10-count-public.json';
import { describe, expect, test } from 'bun:test';
import captured from './fixtures/eng-count-ad-v2.json';
import af from './fixtures/eng-first-category-af.json';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { ENG_DECISION_SEEDS, buildEngSeedDecisionInput, evaluateEngSeedCoverage, isEngBatchingIssueAUQ, isEngSeedDecisionAUQ } from './helpers/eng-seeded-coverage';
import { buildPlanReviewDecisionPrompt, validatePlanReviewDecisionResponse } from './helpers/plan-review-decisions';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, matchGlob } from './helpers/touchfiles';

// Exact public decisions reused from the existing fixture. The report below is
// a synthetic assembly of its retained task catalog, not a claim that the old run passed.
const calls = captured.cases.first.calls as NativePlanQuestionCall[];
const indices = [2, 4, 6, 8];
const start = Date.parse('2026-09-09T19:00:00Z'), end = Date.parse('2026-09-09T19:30:00Z');
const report = '# Reviewed plan\n\n' + captured.reviewedTasks.lines.join('\n') + '\n\n## GSTACK REVIEW REPORT\nEng review complete.\n';
const transcript = (): PlanCountTranscript => ({ status: 'ready', calls: structuredClone(calls), assistantMessages: [] });
const evaluate = (t = transcript(), p = report) => evaluateEngSeedCoverage(t, p, start, end);

describe('Eng semantic native evidence boundary', () => {
  const start = Date.parse(fb10Public.windowStart), end = Date.parse(fb10Public.windowEnd);
  const native = (): PlanCountTranscript => ({ status: 'ready', calls: structuredClone(fb10Public.calls) as NativePlanQuestionCall[], assistantMessages: [] });
  const input = (t = native()) => buildEngSeedDecisionInput({ plan: fb10Public.plan, transcript: t,
    startedAt: start, finishedAt: end, deadlineAt: Date.now() + 60_000 });
  // This deliberately supplied response proves only local protocol checks.
  // No model has classified this capture, and no paid result is inferred.
  const response = (data = input()) => ({ questions: data.fingerprints.flatMap((fp, i) => fp.questions!.map((q, index) => ({
    toolUseId: fp.toolUseId!, questionIndex: index + 1, kind: 'finding',
    targetIds: ({ 0: ['sequential-idp'], 2: ['complexity'], 3: ['shared-cache'], 5: ['swallowed-errors'] } as Record<number, string[]>)[i] ?? [],
    independentDecisions: 1, evidence: [{ field: 'question', optionIndex: null, quote: q.question.split('\n')[0]! }],
    reason: 'Synthetic response for structural validation, not a semantic verdict.', optionActions: [],
  }))) });

  test('retains the original rejected class and error decisions as captured evidence', () => {
    const t = native();
    for (const index of [2, 5]) expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(t.calls[index]!, end, false), t.calls.slice(0, index), start, end)).toBe(false);
  });

  test('uses complete native fields and actual answers with all four independent targets', () => {
    const t = native(), data = input(t);
    expect(data.targets.map(target => target.id)).toEqual([...ENG_DECISION_SEEDS]);
    expect(data.floor).toBe(4);
    expect(data.ceiling).toBeUndefined();
    expect(data.fingerprints).toHaveLength(t.calls.length);
    data.fingerprints.forEach((fp, index) => {
      const call = t.calls[index]!;
      expect(fp.questions).toEqual(call.questions);
      expect(fp.nativeCall).toEqual(call);
      expect(fp.toolUseId).toBe(`${call.sessionId}:${call.toolUseId}`);
      expect(fp.selectedOptions).toEqual(call.questions.map(q => q.options.findIndex(o => o.label === call.answers![q.question]) + 1));
    });
    expect(data.fingerprints[2]!.selectedOptions).toEqual([1]); // The actor kept all five classes, not recommended B.
    expect(validatePlanReviewDecisionResponse(data, response(data)).coveredTargetIds).toEqual([...ENG_DECISION_SEEDS]);
    const prompt = buildPlanReviewDecisionPrompt(data);
    for (const fp of data.fingerprints) for (const q of fp.questions!) {
      expect(prompt).toContain(JSON.stringify(q.question));
      for (const o of q.options) expect(prompt).toContain(JSON.stringify(o.description));
    }
  });

  test('takes an immutable snapshot before asynchronous classification', () => {
    const t = native(), data = input(t), before = structuredClone(data);
    t.calls[2]!.questions[0]!.question += '\nAltered after binding';
    t.calls[2]!.answers = {};
    expect(data).toEqual(before);
  });

  for (const [name, change] of [
    ['foreign session', (t: PlanCountTranscript) => { t.calls[2]!.sessionId = 'foreign'; }],
    ['duplicate native identity', (t: PlanCountTranscript) => { t.calls.push(structuredClone(t.calls[2]!)); }],
    ['unanswered call', (t: PlanCountTranscript) => { t.calls[2]!.answered = false; }],
    ['failed call', (t: PlanCountTranscript) => { t.calls[2]!.failed = true; }],
    ['unanswered tab', (t: PlanCountTranscript) => { t.calls[2]!.unansweredQuestionIndices = [0]; }],
    ['unoffered actual answer', (t: PlanCountTranscript) => { const c = t.calls[2]!; c.answers![c.questions[0]!.question] = 'Use a different option'; }],
    ['duplicate offered labels', (t: PlanCountTranscript) => { const q = t.calls[2]!.questions[0]!; q.options[1]!.label = q.options[0]!.label; }],
    ['out-of-window answer', (t: PlanCountTranscript) => { t.calls[2]!.answeredAt = new Date(start - 1).toISOString(); }],
    ['foreign extra answer', (t: PlanCountTranscript) => { t.calls[2]!.answers!['Foreign question'] = 'A'; }],
  ] as const) test(`rejects ${name} before a judge can run`, () => {
    const t = native(); change(t); expect(() => input(t)).toThrow('complete owned');
  });

  for (const [name, change, error] of [
    ['missing row', (r: ReturnType<typeof response>) => { r.questions.pop(); }, 'missing native question rows'],
    ['duplicate row', (r: ReturnType<typeof response>) => { r.questions.push(structuredClone(r.questions[0]!)); }, 'duplicate native question'],
    ['foreign identity', (r: ReturnType<typeof response>) => { r.questions[2]!.toolUseId = 'foreign'; }, 'phantom'],
    ['wrong native quote', (r: ReturnType<typeof response>) => { r.questions[2]!.evidence[0]!.quote = r.questions[5]!.evidence[0]!.quote; }, 'exact native field'],
    ['missing seed', (r: ReturnType<typeof response>) => { r.questions[2]!.targetIds = []; }, 'missing target decisions'],
    ['bundled remedies', (r: ReturnType<typeof response>) => { r.questions[2]!.independentDecisions = 2; }, 'bundled independent decisions'],
    ['two seeds in one choice', (r: ReturnType<typeof response>) => { r.questions[2]!.targetIds.push('swallowed-errors'); r.questions[5]!.targetIds = []; }, 'bundled independent decisions'],
    ['uncertainty', (r: ReturnType<typeof response>) => { Object.assign(r.questions[2]!, { kind: 'uncertain', targetIds: [], independentDecisions: 0 }); }, 'uncertain classification'],
  ] as const) test(`rejects judge ${name}`, () => {
    const data = input(), raw = response(data); change(raw);
    expect(() => validatePlanReviewDecisionResponse(data, raw)).toThrow(error);
  });

  test('keeps the absolute deadline and does not grant a new judge window', () => {
    const deadlineAt = Date.now() - 1;
    const data = buildEngSeedDecisionInput({ plan: fb10Public.plan, transcript: native(), startedAt: start, finishedAt: end, deadlineAt });
    expect(data.deadlineAt).toBe(deadlineAt);
    expect(() => buildPlanReviewDecisionPrompt(data)).toThrow('absolute case deadline exhausted');
    expect(() => buildEngSeedDecisionInput({ plan: fb10Public.plan, transcript: native(), startedAt: start, finishedAt: end, deadlineAt: end - 1 })).toThrow('original deadline');
  });
});

describe('retry capture and replay remain one owned regression contract', () => {
  const original = a689Retry.calls as NativePlanQuestionCall[];
  const check = (plan = a689Retry.report, native = structuredClone(original)) => evaluateEngSeedCoverage(
    { status: 'ready', calls: native, assistantMessages: [] }, plan,
    Date.parse(a689Retry.windowStart), Date.parse(a689Retry.windowEnd));
  const edit = (prefix: string, change: (s: string) => string, plan = a689Retry.report) => {
    const parts = plan.split(/(?=^#{1,6} )/m), matches = parts.filter(s => s.startsWith(prefix));
    expect(matches).toHaveLength(1);
    const before = matches[0]!, after = change(before);
    expect(after).not.toBe(before);
    return parts.map(s => s === before ? after : s).join('');
  };
  const record = (change: (s: string) => string) => edit('### R6:', change);

  test('exact public retry has four seed decisions and a mandatory legacy-first parity contract', () => {
    const result = check();
    expect(result.missing).toEqual([]);
    expect(Object.keys(result.decisions)).toHaveLength(4);
    expect(result.regression).toBe('plan');
    expect(result.ok).toBe(true);
    // A free metric replay cannot turn the historical timeout into a paid pass.
    expect(a689Retry.originalOutcome).toBe('timeout');
  });

  test('equivalent answer notation, option order and assertion inventory order retain ownership', () => {
    expect(check(a689Retry.report.replaceAll(' answer)', ' answer, this session)')).regression).toBe('plan');
    const native = structuredClone(original);
    native.forEach(call => call.questions[0]!.options.reverse());
    expect(check(a689Retry.report, native).regression).toBe('plan');
    expect(check(record(s => s.replace('status/decision, dispatched claims, adapter state after, IDP call count and order',
      'IDP call count and order, adapter state after, dispatched claims, status/decision'))).regression).toBe('plan');
    expect(check(a689Retry.report.replaceAll('auth-flow.characterization.test.*', 'auth/legacy-parity.test.ts')).regression).toBe('plan');
  });

  for (const index of [3, 4, 5]) test(`native D${index + 1} selection and complete saved fields bind its evidence`, () => {
    for (const mutate of [
      (call: NativePlanQuestionCall) => { call.answers![call.questions[0]!.question] = call.questions[0]!.options[1]!.label; },
      (call: NativePlanQuestionCall) => { call.answered = false; },
      (call: NativePlanQuestionCall) => { call.failed = true; },
      (call: NativePlanQuestionCall) => { call.answeredAt = '2026-09-16T14:31:00Z'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.header += ' changed'; },
      (call: NativePlanQuestionCall) => { call.questions[0]!.options[0]!.description += ' Extra permission required.'; },
    ]) {
      const native = structuredClone(original); mutate(native[index]!);
      expect(check(a689Retry.report, native).regression).toBeUndefined();
    }
    for (const change of [
      (s: string) => s.replace('State: approved', 'State: pending'),
      (s: string) => s.replace('State: approved', 'State: approved\nState: approved'),
      (s: string) => s.replace('State: approved\n', ''),
      (s: string) => s.replace(/^Actual answer: .+\n/m, ''),
      (s: string) => s.replaceAll('PLAN.md:', 'OTHER.md:'),
      (s: string) => s.replaceAll('PLAN.md:', 'archive/PLAN.md:'),
      (s: string) => s.split('\n').map(line => '> ' + line).join('\n'),
      (s: string) => '## Historical review\n' + s,
      (s: string) => s + '\n' + s,
    ]) expect(check(edit(`### R${index + 1}:`, change)).regression).toBeUndefined();
  });

  const scopeControls: [string, (s: string) => string][] = [
    ['missing baseline', s => s.replace(/Step 1: [^]*?(?=Step 2:)/, '')],
    ['missing replay', s => s.replace(/Step 2: [^]*?(?=Intended differences:)/, '')],
    ['capture new path', s => s.replace('against `legacyAuthFlow()` and record each outcome', 'against `AuthBroker()` and record each outcome')],
    ['different replay table', s => s.replace('run the identical table', 'run a different table')],
    ['partial field equality', s => s.replace('assert every field identical', 'assert some fields identical')],
    ['missing claims assertion', s => s.replace('status/decision, dispatched claims, adapter state after', 'status/decision, adapter state after')],
    ['missing IDP order assertion', s => s.replace('IDP call count and order). Step 2', 'IDP call count). Step 2')],
    ['wrong scenario count', s => s.replace('run the 10-scenario table', 'run the 9-scenario table')],
    ['unapproved product difference', s => s.replace('Intended differences: none in product behavior;', 'Intended differences: new denial behavior;')],
    ['foreign logging approval', s => s.replace('structured deny log lines (D5)', 'structured deny log lines (D19)')],
    ['scope noncritical', s => s.replace('This suite is CRITICAL', 'This suite is non-CRITICAL')],
    ['scope not critical', s => s.replace('This suite is CRITICAL', 'This suite is not CRITICAL')],
    ['scope withdrawn', s => s.replace('in any environment.', 'in any environment. This suite is withdrawn.')],
    ['scope optional', s => s.replace('in any environment.', 'in any environment. This suite is optional.')],
    ['no rollout gate', s => s.replace('must be green before the D4 flag moves past 0%', 'can be green after the D4 flag moves past 0%')],
  ];
  for (const [name, change] of scopeControls) test(name, () => expect(check(record(change)).regression).toBeUndefined());

  const taskControls: [string, (s: string) => string][] = [
    ['missing capture task', s => s.replace(/- \[ \] \*\*T1 [^]*?(?=- \[ \] \*\*T2)/, '')],
    ['unmapped task file', s => s.replace('`auth-flow.characterization.test.*`', '`different.test.*`')],
    ['task foreign source', s => s.replace('`PLAN.md:23-25, 36-37`', '`OTHER.md:23-25, 36-37`')],
    ['task different selection', s => s.replace('D6=A', 'D6=B')],
    ['task different decision', s => s.replace('D6=A', 'D19=A')],
    ['task missing baseline run', s => s.replace('suite green against legacy alone, then against both paths', 'suite green against AuthBroker')],
    ['task missing replay run', s => s.replace('suite green against legacy alone, then against both paths', 'suite green against legacy alone')],
    ['task reversed run order', s => s.replace('record legacy outcomes first, then assert AuthBroker parity', 'assert AuthBroker parity first, then record legacy outcomes')],
    ['task wrong scenario count', s => s.replace('Write the 10-scenario', 'Write the 4-scenario')],
    ['task optional rollout gate', s => s.replace('must pass before flag > 0%', 'may pass after flag > 0%')],
    ['task duplicate verification', s => s.replace('  - Verify: suite green', '  - Verify: other suite green\n  - Verify: suite green')],
    ['task not run', s => s.replace('Write the 10-scenario', 'Do not write the 10-scenario')],
  ];
  for (const [name, change] of taskControls) test(name, () => expect(check(edit('## Implementation Tasks', change)).regression).toBeUndefined());

  test('unchanged legacy ownership and logging approval must precede the parity choice', () => {
    expect(check(edit('### R4:', s => s.replace('is retained byte-identical', 'is rewritten'))).regression).toBeUndefined();
    expect(check(edit('### R5:', s => s.replace('deny + structured log with error class', 'allow + structured log with error class'))).regression).toBeUndefined();
    for (const index of [3, 4]) {
      const native = structuredClone(original); native[index]!.answeredAt = native[5]!.answeredAt;
      expect(check(a689Retry.report, native).regression).toBeUndefined();
    }
  });

  for (const status of ['R6 is withdrawn.', 'D6 is "withdrawn".', 'T1 is cancelled.', 'R5 is superseded.', 'D4 is not required.',
    'legacyAuthFlow() is modified before T1.', 'legacyAuthFlow() will be rewritten before T1.',
    'legacyAuthFlow() is modified before step 1.']) test(status, () => {
    expect(check(edit('## Implementation Tasks', s => s + '\nCorrection: ' + status + '\n')).regression).toBeUndefined();
    expect(check(edit('## Implementation Tasks', s => s + '\nEarlier note: "' + status + '"\n')).regression).toBe('plan');
  });
});
function question(call: NativePlanQuestionCall, text: string) {
  const answer = call.answers![call.questions[0]!.question]!;
  call.questions[0]!.question = text; call.answers = { [text]: answer };
}

describe('neutral native questions own their cited defect and one complete policy option', () => {
  const retained = neutralSeedFixture.calls as NativePlanQuestionCall[];
  const seeds = ['shared-cache', 'swallowed-errors'] as const;
  const identity = (c: NativePlanQuestionCall) => `${c.sessionId}:${c.toolUseId}`;
  const check = (c: NativePlanQuestionCall) => evaluateEngSeedCoverage(
    { status: 'ready', calls: [c], assistantMessages: [] }, '',
    Date.parse(neutralSeedFixture.windowStart), Date.parse(neutralSeedFixture.windowEnd));
  const editText = (c: NativePlanQuestionCall, edit: (s: string) => string) => question(c, edit(c.questions[0]!.question));
  const editOption = (c: NativePlanQuestionCall, edit: (o: NativePlanQuestionCall['questions'][number]['options'][number]) => void) => {
    const q = c.questions[0]!, previous = structuredClone(q.options[0]!);
    edit(q.options[0]!);
    // A mutated fixture remains a complete native payload: update the in-question
    // display and the exact offered answer, without changing the source fixture.
    editText(c, text => text.replace(previous.label, q.options[0]!.label)
      .replace(previous.description!.replaceAll('\n', '\n  '), q.options[0]!.description!.replaceAll('\n', '\n  ')));
    c.answers = { [q.question]: q.options[0]!.label };
  };

  test('exact D7 and D8 establish separate seed decisions without injection or function-shape decisions', () => {
    retained.forEach((c, i) => {
      expect(check(c).decisions).toEqual({ [seeds[i]!]: identity(c) });
      expect(check(c).ok).toBe(false);
      expect(check(c).regression).toBeUndefined();
      expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(c, 1, false), [],
        Date.parse(neutralSeedFixture.windowStart), Date.parse(neutralSeedFixture.windowEnd))).toBe(true);
    });
    const result = evaluateEngSeedCoverage({ status: 'ready', calls: structuredClone(retained), assistantMessages: [] }, '',
      Date.parse(neutralSeedFixture.windowStart), Date.parse(neutralSeedFixture.windowEnd));
    expect(Object.keys(result.decisions)).toEqual([...seeds]);
    expect(new Set(Object.values(result.decisions)).size).toBe(2);
    expect(result.missing).toEqual(['complexity', 'sequential-idp']);
    expect(result.ok).toBe(false);
    expect(neutralSeedFixture.originalOutcome).toBe('timeout');
  });

  test('the relation survives neutral titles, formatting, sentence order and any offered answer', () => {
    const titles = [
      ['Which cache adapter write policy should we choose?', 'How should the cache adapter accept writes?'],
      ['How should validateAndDispatch() respond to failure?', 'Which error policy should validateAndDispatch() use?'],
    ];
    retained.forEach((original, i) => {
      for (const title of titles[i]!) for (const option of original.questions[0]!.options) {
        const c = structuredClone(original);
        editText(c, text => text.replace(/^D\d+ — [^\n]+/, 'D42 — '+title)
          .replace('Project/branch/task:', '**Project/branch/task:**').replace('ELI10:', '**ELI10:**')
          .replaceAll('PLAN.md', '`PLAN.md`').replaceAll('validateAndDispatch()', '`validateAndDispatch()`'));
        c.answers = { [c.questions[0]!.question]: option.label };
        expect(check(c).decisions[seeds[i]!], title).toBe(identity(c));
      }
      const reordered = structuredClone(original);
      editText(reordered, text => text.replace(/^ELI10: .+$/m, i === 0
        ? 'ELI10: Adapter mutations remain not serialized (PLAN.md:19). Both services mutate the shared adapter (PLAN.md:29).'
        : 'ELI10: Every block discards its error (PLAN.md:32-33). The function has 3 nested catch blocks.'));
      expect(check(reordered).decisions[seeds[i]!]).toBe(identity(reordered));
    });
  });

  test('current cited ownership cannot come from a foreign source, quotation or inactive explanation', () => {
    const transforms = [
      (s: string) => s.replaceAll('PLAN.md', 'OTHER.md'),
      (s: string) => s.replaceAll('PLAN.md', 'archive/PLAN.md'),
      (s: string) => s.replace(/(ELI10: .+)$/m, '$1 Other evidence is in OTHER.md:19.'),
      (s: string) => s.replace(/^ELI10: .+\n/m, ''),
      (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: "$1"'),
      (s: string) => s.replace(/^ELI10: (.+)$/m, 'ELI10: `$1`'),
      (s: string) => s.replace(/^ELI10: /m, '> ELI10: '),
      (s: string) => s.replace(/^ELI10: /m, 'ELI10: Historical example: '),
      (s: string) => s.replace(/^ELI10: /m, 'ELI10: If approved, '),
      (s: string) => s.replace(/^ELI10: (.+)$/m, (_line, body) => 'ELI10: '+body.replace(/PLAN\.md:\d+(?:-\d+)?/g, 'the plan')),
      (s: string) => s+'\nThis finding is withdrawn.',
      (s: string) => s+'\nThis decision is "not current".',
      (s: string) => s+'\nThis remedy applies only if approved.',
      (s: string) => s.replace(/^D\d+ — [^\n]+/, 'D42 — Which report format should we use?'),
    ];
    retained.forEach((original, i) => transforms.forEach((edit, index) => {
      const c = structuredClone(original); editText(c, edit);
      expect(check(c).missing, `${seeds[i]} ownership control ${index}`).toContain(seeds[i]!);
    }));
  });

  test('each current defect must remain factual and unresolved', () => {
    const changes = [
      ['Two services both write', 'Two services never write'],
      ['writes are not serialized', 'writes are serialized'],
      ['the same cache', 'another cache'],
    ];
    for (const [from, to] of changes) {
      const c = structuredClone(retained[0]!); editText(c, s => s.replace(from!, to!));
      expect(check(c).missing, `${from} → ${to}`).toContain('shared-cache');
    }
    for (const [i, correction] of [[0, 'The writes are now serialized.'], [1, 'validateAndDispatch() now rethrows every error.']] as const) {
      const c = structuredClone(retained[i]!); editText(c, s => s+'\nCorrection: '+correction);
      expect(check(c).missing).toContain(seeds[i]!);
      const quoted = structuredClone(retained[i]!); editText(quoted, s => s+'\nPrior wording: "'+correction+'"');
      expect(check(quoted).decisions[seeds[i]!]).toBe(identity(quoted));
    }
    for (const [from, to] of [['three nested try/catch blocks', 'one catch block'], ['each one catches an error and moves on', 'each one catches and rethrows an error'], ['each one catches an error and moves on', 'each one never swallows an error']]) {
      const c = structuredClone(retained[1]!); editText(c, s => s.replace(from!, to!));
      expect(check(c).missing, `${from} → ${to}`).toContain('swallowed-errors');
    }
  });

  test('one active offered option must own the entire remedy, including authoritative contradictions', () => {
    const edits = [
      (o: { label: string; description?: string }) => { o.label = 'Unrelated choice'; },
      (o: { label: string; description?: string }) => { o.description = '✅ One benefit\n❌ One cost'; },
      (o: { label: string; description?: string }) => { o.description += '\nThis option is withdrawn.'; },
      (o: { label: string; description?: string }) => { o.description += '\nThis option proceeds only if approved.'; },
      (o: { label: string; description?: string }) => { o.description = 'Historical example: '+o.description; },
      (o: { label: string; description?: string }) => { o.description = '"'+o.description+'"'; },
    ];
    retained.forEach((original, i) => edits.forEach((edit, index) => {
      const c = structuredClone(original); editOption(c, edit);
      expect(check(c).missing, `${seeds[i]} remedy control ${index}`).toContain(seeds[i]!);
    }));
    const contradictions = [
      ['SessionMint still writes to the cache.', 'Both services still write directly.', 'Do not use a single writer.', 'The remedy belongs to another cache.'],
      ['Dispatch errors remain swallowed.', 'Do not log denials.', 'Only some errors are surfaced.', 'This remedy is not fail-closed.', 'The remedy belongs to another function.'],
    ];
    retained.forEach((original, i) => contradictions[i]!.forEach(correction => {
      const c = structuredClone(original); editOption(c, o => { o.description += '\nCorrection: '+correction; });
      expect(check(c).missing, correction).toContain(seeds[i]!);
      const quoted = structuredClone(original); editOption(quoted, o => { o.description += '\n❌ If '+correction[0]!.toLowerCase()+correction.slice(1)+' this contract has not been implemented.'; });
      expect(check(quoted).decisions[seeds[i]!], 'conditional risk: '+correction).toBe(identity(quoted));
    }));
    for (const [index, text] of [[0, 'SessionMint becomes side-effect free and trivially testable'], [1, 'Every denial is logged with tenant and request id, so a 3am incident has a trail']] as const) {
      const c = structuredClone(retained[index]!);
      editOption(c, o => { o.description = o.description!.replace(text, 'There is a local benefit'); });
      c.questions[0]!.options[1]!.description += '\n✅ '+text;
      expect(check(c).missing, 'cross-option borrowing').toContain(seeds[index]!);
    }
  });

  test('seed recognition still requires a single completed native answer with identity and timing', () => {
    const edits = [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'Not offered' }; },
      (c: NativePlanQuestionCall) => { c.answers!.foreign = 'Yes'; },
      (c: NativePlanQuestionCall) => { c.answeredAt = neutralSeedFixture.windowStart.replace('12:11', '12:10'); },
      (c: NativePlanQuestionCall) => { c.sessionId = ''; },
      (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions.push(structuredClone(retained[1]!.questions[0]!)); },
    ];
    retained.forEach((original, i) => edits.forEach((edit, index) => {
      const c = structuredClone(original); edit(c); expect(check(c).missing, `completion control ${index}`).toContain(seeds[i]!);
    }));
    const foreign = structuredClone(retained); foreign[1]!.sessionId = 'foreign';
    const duplicate = [...structuredClone(retained), structuredClone(retained[0]!)];
    for (const calls of [foreign, duplicate]) {
      const result = evaluateEngSeedCoverage({ status: 'ready', calls, assistantMessages: [] }, '',
        Date.parse(neutralSeedFixture.windowStart), Date.parse(neutralSeedFixture.windowEnd));
      expect(result.decisions).toEqual({});
    }
  });
});

describe('approved paired legacy suite from the complete 749df public capture', () => {
  const retained=[...pairedSuiteFixture.calls, neutralSeedFixture.calls.find(c=>c.questions[0]!.question.startsWith('D8 '))!] as NativePlanQuestionCall[];
  const check=(parts=pairedSuiteFixture.parts, calls=structuredClone(retained)) => evaluateEngSeedCoverage(
    {status:'ready',calls,assistantMessages:[]},parts.join('\n\n'),Date.parse(pairedSuiteFixture.windowStart),Date.parse(pairedSuiteFixture.windowEnd));
  const mutate=(index:number, edit:(s:string)=>string) => { const parts=[...pairedSuiteFixture.parts]; parts[index]=edit(parts[index]!); expect(parts[index]).not.toBe(pairedSuiteFixture.parts[index]); return parts; };
  test('exact relevant native records and linked tasks establish the regression requirement only',()=>{
    expect(check().regression).toBe('plan');
    expect(check().ok).toBe(false);
    expect(pairedSuiteFixture.originalOutcome).toBe('timeout');
    expect(check(pairedSuiteFixture.parts,[]).regression).toBeUndefined();
  });
  test('record captions, task verbs, filenames and native option order are presentation',()=>{
    expect(check(mutate(4,s=>s.replace('R9: Regression contract for legacyAuthFlow() (IRON RULE)','R9: Approved regression contract — legacyAuthFlow()'))).regression).toBe('plan');
    expect(check(mutate(6,s=>s.replace('Build the parity suite:', 'Write the parity suite:'))).regression).toBe('plan');
    const parts=pairedSuiteFixture.parts.map(s=>s.replaceAll('parity.legacy-vs-broker.test.ts','auth-regression.test.ts'));
    expect(check(parts).regression).toBe('plan');
    const calls=structuredClone(retained); calls.forEach(c=>c.questions[0]!.options.reverse());
    expect(check(pairedSuiteFixture.parts,calls).regression).toBe('plan');
  });
  test('equivalent matrix separators and affirmative inventory order preserve meaning',()=>{
    for(const separator of ['×','x','X','times']) {
      expect(check(mutate(6,s=>s.replaceAll(' × ', ' '+separator+' ').replace('Build the parity suite:', 'Add the parity suite:'))).regression).toBe('plan');
    }
    expect(check(mutate(6,s=>s.replace('decision, error class, cache write y/n, dispatch y/n, IDP call count + order',
      'IDP call count and order, error class is asserted, decision, dispatch invoked yes/no, cache write yes/no'))).regression).toBe('plan');
  });
  test('active and passive native promises own the same fixtures, targets and equal assertions',()=>{
    const original='Every token state, cache state and IDP failure position is asserted identically on legacy and broker from shared fixtures';
    const active='Shared fixtures assert identical results on both legacy and broker for every token state, cache state and IDP failure position';
    const changed=(promise:string)=>{
      const calls=structuredClone(retained),q=calls[1]!.questions[0]!,answer=calls[1]!.answers![q.question]!;
      q.question=q.question.replace(original,promise);q.options[0]!.description=q.options[0]!.description!.replace(original,promise);
      calls[1]!.answers={[q.question]:answer};
      return check(mutate(4,s=>s.replaceAll(original,promise)),calls);
    };
    for(const promise of [active,active+' On denial, dispatch is not invoked.',active.replace('Shared fixtures','Same fixtures').replace('identical results','equal outcomes'),
      active.replace('legacy and broker','AuthBroker and legacyAuthFlow()'),
      'Every token state, cache state and IDP failure position is asserted identically from the same fixtures on broker and legacy']) {
      expect(changed(promise).regression,promise).toBe('plan');
    }
    for(const promise of [active.replace('Shared fixtures','Separate fixtures'),active.replace('assert identical results','collect results'),
      active.replace('both legacy and broker','the broker'),active.replace('assert identical','do not assert identical'),
      active.replace('identical results','nonidentical results'),active.replace('IDP failure position','IDP success position'),
      active.replace('every token state','some token states'),active+' except IDP error outcomes',
      active.replace('Shared fixtures assert','Shared fixtures run the tests.\n✅ A different suite asserts'),
      active.replace('Shared fixtures assert','Shared fixtures run the tests. A different suite asserts'),
      active.replace('Shared fixtures assert','Shared fixtures run the tests; a different suite asserts'),
      active.replace('Shared fixtures assert','Shared fixtures run the tests, while a different suite asserts'),
      active.replace('Shared fixtures','No shared fixtures'),active.replace('Shared fixtures','Without shared fixtures'),
      active.replace('every token state','not every token state'),active.replace('every token state','not all token states'),
      active.replace('every token state','only some token states'),active.replace('cache state','not every cache state'),
      active.replace('IDP failure position','not every IDP failure position')]) {
      expect(changed(promise).regression,promise).toBeUndefined();
    }
  });
  test('prior selected answers own the intended difference and untouched oracle',()=>{
    expect(check(pairedSuiteFixture.parts,structuredClone(retained.slice(0,2))).regression).toBeUndefined();
    expect(check(mutate(2,_s=>'')).regression).toBeUndefined();
    for(const [callIndex,partIndex] of [[2,2],[0,3]] as const) for(const selectedIndex of [1,2]) {
      const calls=structuredClone(retained),call=calls[callIndex]!,q=call.questions[0]!,selected=q.options[selectedIndex]!.label;
      call.answers={[q.question]:selected};
      expect(check(pairedSuiteFixture.parts,calls).regression).toBeUndefined();
      const decision=callIndex===2?'D8':'D9';
      const parts=mutate(partIndex,s=>s.replace(/^Actual answer: .+$/m,
        'Actual answer: '+String.fromCharCode(65+selectedIndex)+') '+selected+' — '+decision+' answer "'+selected+'"'));
      expect(check(parts,calls).regression).toBeUndefined();
    }
    const late=structuredClone(retained);late[2]!.answeredAt='2026-09-16T12:15:50.000Z';
    expect(check(pairedSuiteFixture.parts,late).regression).toBeUndefined();
    for(const status of ['D8 is withdrawn.','R6 is superseded.']) expect(check(mutate(7,s=>s+'\nCorrection: '+status)).regression).toBeUndefined();
  });
  test('current omission and suppression cannot retain affirmative coverage credit',()=>{
    for(const outcome of ['On denial, dispatch is not invoked.','On denial, no dispatch is expected.'])
      expect(check(mutate(6,s=>s+'\n'+outcome)).regression).toBe('plan');
    for(const fact of ['decision','error class','cache write','dispatch','IDP call count','order']) {
      for(const assessment of ['is never asserted','is not verified','is optional','may be omitted']) {
        expect(check(mutate(6,s=>s+'\nCorrection: '+fact+' '+assessment+'.')).regression).toBeUndefined();
      }
    }
    expect(check(mutate(6,s=>s.replace('asserts decision, error class,','asserts decision, error class is never asserted,'))).regression).toBeUndefined();
    expect(check(mutate(6,s=>s+'\nCorrection: omit error class assertions.')).regression).toBeUndefined();
    const changed=[...pairedSuiteFixture.parts];
    changed[4]=changed[4]!.replace('only D8 fail-closed outcomes on error paths','only D8 suppression of all error outcomes');
    changed[6]=changed[6]!.replace('limited to D8 fail-closed cases','limited to D8 suppression of all error outcomes');
    expect(changed[4]).not.toBe(pairedSuiteFixture.parts[4]);expect(changed[6]).not.toBe(pairedSuiteFixture.parts[6]);
    expect(check(changed).regression).toBeUndefined();
    for(const index of [4,6]) expect(check(mutate(index,s=>s.replace('D8 fail-closed','D8 fail-open'))).regression).toBeUndefined();
  });
  const controls:[string,number,(s:string)=>string][]=[
    ['foreign finding',4,s=>s.replaceAll('PLAN.md:', 'OTHER.md:')],
    ['quoted record',4,s=>s.split('\n').map(line=>'> '+line).join('\n')],
    ['historical record',4,s=>'## History\n'+s],
    ['unapproved record',4,s=>s.replace('State: approved','State: pending')],
    ['missing actual answer',4,s=>s.replace(/^Actual answer: .+\n/m,'')],
    ['duplicate record',4,s=>s+'\n\n'+s],
    ['wrong native question',4,s=>s.replace('D11 — How do we prove','D11 — How might we prove')],
    ['scope has only new execution',4,s=>s.replace('shared fixtures drive both `legacyAuthFlow()` and `AuthBroker`','shared fixtures drive only `AuthBroker`')],
    ['scope omits IDP order',4,s=>s.replace('IDP call count and order; shared fixtures','IDP call count; shared fixtures')],
    ['scope omits error assertions',4,s=>s.replace('Acceptance assertions per case: decision, error class,','Acceptance assertions per case: decision,')],
    ['scope omits per-case obligation',4,s=>s.replace('Acceptance assertions per case:', 'Acceptance assertions:')],
    ['scope omits intentional differences',4,s=>s.replace('Intended differences: only D8','Possible differences: D8')],
    ['task loses source decision',6,s=>s.replace('→ D11','→ D19')],
    ['task borrows multiple decisions',6,s=>s.replace('→ D11','→ D11 and D19')],
    ['task has foreign source',6,s=>s.replace('PLAN.md:', 'other/PLAN.md:')],
    ['task file differs',6,s=>s.replace('parity.legacy-vs-broker.test.ts','new-only.test.ts')],
    ['task omitted',6,_s=>''],
    ['task duplicated',6,s=>s+'\n'+s],
    ['task only runs new path',6,s=>s.replace('shared fixtures drive `legacyAuthFlow()` and `AuthBroker`','shared fixtures drive `AuthBroker`')],
    ['task lacks IDP dimension',6,s=>s.replace('token × cache × IDP matrix','token × cache matrix')],
    ['task omits per-cell verification',6,s=>s.replace('every matrix cell asserts','some matrix cells assert')],
    ['task omits error class verification',6,s=>s.replace('asserts decision, error class,','asserts decision,')],
    ['task negates error assertions',6,s=>s.replace('asserts decision, error class,','asserts decision, no error class,')],
    ['task omits IDP count',6,s=>s.replace('IDP call count + order','IDP order')],
    ['task omits IDP order',6,s=>s.replace('IDP call count + order','IDP call count')],
    ['task negates IDP order',6,s=>s.replace('IDP call count + order','IDP call count but no order')],
    ['legacy execution later refused',6,s=>s+'\nCorrection: legacyAuthFlow() is never executed.'],
    ['task changes accepted differences',6,s=>s.replace('limited to D8','limited to D19')],
    ['oracle loses approval',3,s=>s.replace('State: approved','State: pending')],
    ['oracle loses untouched contract',3,s=>s.replace('legacyAuthFlow()` stays untouched','legacyAuthFlow()` gets rewritten')],
    ['oracle native choice differs',3,s=>s.replace('D9 answer "Flag-routed strangler:', 'D9 answer "Different choice:')],
    ['preservation task omitted',7,_s=>''],
    ['preservation files omitted',7,s=>s.replace(/^  - Files: .+\n/m,'')],
    ['preservation has foreign source',7,s=>s.replace('PLAN.md:', 'other/PLAN.md:')],
    ['preservation verification omitted',7,s=>s.replace('`git diff` shows no change to `legacyAuthFlow()`','broker tests pass')],
    ['preservation bound to another choice',7,s=>s.replace('→ D9','→ D19')],
  ];
  for(const [name,index,edit] of controls) test('rejects '+name,()=>expect(check(mutate(index,edit)).regression).toBeUndefined());
  test('current withdrawal or changed legacy cannot hide behind the earlier contract',()=>{
    for(const correction of ['R9 is superseded.','R9 is "superseded".','D11 is withdrawn.','T5 is optional.','T5 verification is optional.','R7 is rejected.','T6 is not current.','legacyAuthFlow() is changed before T5.']) {
      expect(check(mutate(7,s=>s+'\n\nCorrection: '+correction)).regression,correction).toBeUndefined();
      expect(check(mutate(7,s=>s+'\n\nPrior wording: "'+correction+'"')).regression,correction).toBe('plan');
    }
  });
  test('native approval is required and selecting a weaker option cannot borrow the full matrix',()=>{
    for(const index of [0,1,2]) for(const mutate of [
      (c:NativePlanQuestionCall)=>{c.answered=false;},
      (c:NativePlanQuestionCall)=>{c.failed=true;},
      (c:NativePlanQuestionCall)=>{c.answeredAt='invalid';},
      (c:NativePlanQuestionCall)=>{c.answers={[c.questions[0]!.question]:'not offered'};},
    ]) { const calls=structuredClone(retained);mutate(calls[index]!);expect(check(pairedSuiteFixture.parts,calls).regression).toBeUndefined(); }
    const calls=structuredClone(retained), c=calls[1]!, q=c.questions[0]!, selected=q.options[1]!.label;
    c.answers={[q.question]:selected};
    const parts=mutate(4,s=>s.replace(/^Actual answer: .+$/m,'Actual answer: B) '+selected+' — D11 answer "'+selected+'"'));
    expect(check(parts,calls).regression).toBeUndefined();
  });
});

describe('Eng seeded coverage from completed native decisions', () => {
  test('four separate decisions plus the auto-added regression cover all five seeds regardless of total count', () => {
    const result = evaluate();
    expect(result.ok).toBe(true);
    expect(Object.keys(result.decisions)).toEqual([...ENG_DECISION_SEEDS]);
    expect(new Set(Object.values(result.decisions)).size).toBe(4);
    expect(result.regression).toBe('plan');
    // Historical evidence remains a failure, never a retroactive live pass.
    expect(captured.cases.first.actual.outcome).toBe('ceiling_reached');
    expect(captured.cases.first.actual.reviewCount).toBeGreaterThan(7);
    const t = transcript();
    for (let i = 0; i < 12; i++) {
      const extra = structuredClone(calls[7]!); extra.toolUseId += `-extra-${i}`; t.calls.push(extra);
    }
    expect(evaluate(t).ok).toBe(true);
  });

  test('every offered choice is coverage, including rejecting or deferring the recommended change', () => {
    for (const index of indices) for (const option of calls[index]!.questions[0]!.options) {
      const t = transcript(), call = t.calls[index]!;
      call.questions[0]!.options.reverse();
      call.answers = { [call.questions[0]!.question]: option.label };
      expect(evaluate(t).ok).toBe(true);
    }
    const t = transcript(), c = t.calls[4]!;
    c.questions[0]!.options.push({ label: 'Defer the cache change', description: 'Accept the stated risk for this release.' });
    c.answers = { [c.questions[0]!.question]: 'Defer the cache change' };
    expect(evaluate(t).ok).toBe(true);
  });

  test('presentation numbers and headings do not establish or remove seed identity', () => {
    const t = transcript();
    for (const index of indices) {
      const c = t.calls[index]!; c.questions[0]!.header = 'Decision';
      question(c, c.questions[0]!.question.replace(/^D\d+ — Issue \d+(?: \([^)]+\))?[: ]*/, 'Decision: '));
    }
    expect(evaluate(t).ok).toBe(true);
  });

  test('a direct seeded action question can use terse Yes/No choices', () => {
    const titles = [
      'Should we reduce the four new classes spread across twelve files?',
      'Should we inject the shared global AuthCache?',
      'Should we split validateAndDispatch to remove its nested swallowing catches?',
      'Should we parallelize the five sequential IDP calls?',
    ];
    for (const answer of ['Yes', 'No']) {
      const t = transcript();
      indices.forEach((index, n) => {
        const c = t.calls[index]!; question(c, titles[n]!);
        c.questions[0]!.options = [{ label: 'Yes' }, { label: 'No' }];
        c.answers = { [c.questions[0]!.question]: answer };
      });
      expect(evaluate(t).ok).toBe(true);
      indices.forEach((index, n) => {
        const administrative = structuredClone(t);
        const c = administrative.calls[index]!;
        question(c, titles[n]!.replace('Should we ', 'Should we document how to '));
        expect(evaluate(administrative).missing).toContain(ENG_DECISION_SEEDS[n]!);
      });
    }
  });

  test('omitting each seed remains missing even when unrelated completed decisions are plentiful', () => {
    for (let n = 0; n < indices.length; n++) {
      const t = transcript(); t.calls.splice(indices[n]!, 1);
      expect(evaluate(t).missing).toContain(ENG_DECISION_SEEDS[n]!);
      expect(evaluate(t).ok).toBe(false);
    }
  });

  test('batched questions or one combined approval cannot supply four distinct decisions', () => {
    const t = transcript(), combined = structuredClone(calls[2]!);
    combined.questions = indices.map(i => structuredClone(calls[i]!.questions[0]!));
    combined.answers = Object.fromEntries(indices.map(i => Object.entries(calls[i]!.answers!)[0]!));
    t.calls = [combined]; expect(evaluate(t).missing).toHaveLength(4);
    combined.questions = [structuredClone(calls[2]!.questions[0]!)];
    question(combined, indices.map(i => calls[i]!.questions[0]!.question.split('\n')[0]).join(' '));
    combined.questions[0]!.options = [
      { label: 'Reduce classes, inject cache, split errors and parallelize IDP', description: 'Approve all four changes.' },
      { label: 'Keep all four unchanged', description: 'Reject every change.' },
    ];
    combined.answers = { [combined.questions[0]!.question]: combined.questions[0]!.options[0]!.label };
    expect(evaluate(t).missing).toHaveLength(4);
  });

  test('pending, failed, stale, foreign, malformed or unoffered replies provide no decision credit', () => {
    for (const mutate of [
      (c: NativePlanQuestionCall) => { c.answered = false; },
      (c: NativePlanQuestionCall) => { c.failed = true; },
      (c: NativePlanQuestionCall) => { delete c.failed; },
      (c: NativePlanQuestionCall) => { c.answers = {}; },
      (c: NativePlanQuestionCall) => { c.answers = { [c.questions[0]!.question]: 'not offered' }; },
      (c: NativePlanQuestionCall) => { c.answers!.foreign = 'Yes'; },
      (c: NativePlanQuestionCall) => { c.answeredAt = 'invalid'; },
      (c: NativePlanQuestionCall) => { c.answeredAt = new Date(start - 1).toISOString(); },
      (c: NativePlanQuestionCall) => { c.answeredAt = new Date(end + 1).toISOString(); },
      (c: NativePlanQuestionCall) => { c.sessionId = 'foreign'; },
      (c: NativePlanQuestionCall) => { c.toolUseId = ''; },
      (c: NativePlanQuestionCall) => { c.unansweredQuestionIndices = [0]; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.multiSelect = true; },
      (c: NativePlanQuestionCall) => { c.questions[0]!.options[1]!.label = c.questions[0]!.options[0]!.label; },
    ]) {
      const t = transcript(); mutate(t.calls[4]!); expect(evaluate(t).ok).toBe(false);
    }
    const duplicate = transcript(); duplicate.calls.push(structuredClone(duplicate.calls[4]!));
    expect(evaluate(duplicate).ok).toBe(false);
    const missing = transcript(); missing.status = 'missing'; expect(evaluate(missing).ok).toBe(false);
  });

  test('quoted examples, resolved defects and option-only references cannot impersonate a seeded issue', () => {
    for (const prefix of ['> ', 'Example: ', '```text\n', 'Hypothetical: ', 'No defect remains: ']) {
      const t = transcript(); question(t.calls[4]!, prefix + t.calls[4]!.questions[0]!.question);
      expect(evaluate(t).missing).toContain('shared-cache');
    }
    const t = transcript(); question(t.calls[4]!, 'Which format should the final report use?');
    expect(evaluate(t).missing).toContain('shared-cache');
  });

  test('mandatory regression evidence requires an affirmative legacy task or scoped public narration', () => {
    const base = '## GSTACK REVIEW REPORT\nEng complete.\n';
    for (const text of [
      'legacyAuthFlow will be rewritten; no regression test for prior behavior is planned.',
      'Do not add legacyAuthFlow regression characterization fixtures.',
      'Defer adding legacyAuthFlow regression characterization fixtures.',
      'Maybe add legacyAuthFlow regression characterization fixtures.',
      '"Add legacyAuthFlow regression characterization fixtures before changes."',
      'Example: Add legacyAuthFlow regression characterization fixtures before changes.',
      'It is unclear whether to add legacyAuthFlow regression characterization fixtures before changes.',
      'We would add legacyAuthFlow regression characterization fixtures before changes.',
      'Add a report paragraph describing legacyAuthFlow regression characterization fixtures before changes.',
      'Record a note about legacyAuthFlow regression characterization fixtures before changes.',
      'Add regression characterization tests for newAuthFlow before changes; legacyAuthFlow is only mentioned in release notes.',
      'Record regression characterization fixtures for newAuthFlow before changes. The legacyAuthFlow documentation was updated.',
      'Add tests for legacyAuthFlow before changes; newAuthFlow gets regression characterization fixtures.',
      'legacyAuthFlow — Add regression characterization tests for newAuthFlow before changes.',
      '> Add legacyAuthFlow regression characterization fixtures before changes.',
      '```\nAdd legacyAuthFlow regression characterization fixtures before changes.\n```',
    ]) expect(evaluate(transcript(), text + '\n\n' + base).ok).toBe(false);
    expect(evaluate(transcript(), 'Add regression characterization tests for legacyAuthFlow before changes.\n\n' + base).regression).toBe('plan');
    const t = transcript(); t.assistantMessages.push({ sessionId: calls[0]!.sessionId, timestamp: new Date(end - 1).toISOString(),
      text: 'Added legacyAuthFlow regression characterization fixtures before the rewrite.' });
    expect(evaluate(t, base).regression).toBe('public-narration');
    t.assistantMessages[0]!.sessionId = 'foreign'; expect(evaluate(t, base).ok).toBe(false);
    t.assistantMessages[0]!.sessionId = calls[0]!.sessionId;
    t.assistantMessages[0]!.timestamp = new Date(start - 1).toISOString(); expect(evaluate(t, base).ok).toBe(false);
    expect(evaluate(transcript(), captured.reviewedTasks.lines.join('\n')).ok).toBe(false);
    expect(evaluate(transcript(), report.replace('Eng review complete.', '')).ok).toBe(false);
  });

  test('local evidence dependencies select both Eng consumers', () => {
    for (const file of ['test/helpers/eng-seeded-coverage.ts', 'test/eng-seeded-coverage.test.ts']) {
      expect(Object.entries(E2E_TOUCHFILES).filter(([, patterns]) => patterns.some(p => matchGlob(file, p))).map(([key]) => key))
        .toEqual(['plan-eng-finding-count', 'plan-eng-multi-finding-batching']);
    }
  });

  test('AF numbered regression task accepts its component-path metadata', () => {
    const context = af.regressionTask.lines.join('\n');
    const result = evaluate(transcript(), context + '\n\n## GSTACK REVIEW REPORT\nEng complete.\n');
    expect(result.regression).toBe('plan');
    expect(result.ok).toBe(true);
    expect(af.regressionTask.provenance.retrospectivePass).toBe(false);
  });

  test('component metadata cannot remove prose, uncertainty or a different test target', () => {
    const task = af.regressionTask.lines[0]!;
    const evaluateTask = (text: string) => evaluate(transcript(), text + '\n\n## GSTACK REVIEW REPORT\nEng complete.\n');
    for (const path of ['src/auth/legacy', 'auth_core/legacy-v2']) {
      expect(evaluateTask(task.replace('auth/legacy', path)).regression).toBe('plan');
    }
    for (const text of [
      task.replace('auth/legacy', 'skip the tests'),
      task.replace('auth/legacy', 'maybe'),
      task.replace('auth/legacy', '../auth/legacy'),
      task.replace('auth/legacy', 'auth/legacy — unrelated prose'),
      task.replace(/^.*? — auth\/legacy/, 'auth/legacy'),
      task.replace('Write characterization', 'Do not write characterization'),
      task.replace('Write characterization', 'Maybe write characterization'),
      task.replace('Write characterization', 'If approved, write characterization'),
      task.replace('Write characterization', 'Write a report describing characterization'),
      task.replace('`legacyAuthFlow()`', '`newAuthFlow()`') + '; legacyAuthFlow is documented elsewhere.',
      task.replace('before any rewrite', 'only if the rewrite requires it'),
      'Example: ' + task, '> ' + task, '"' + task + '"',
      '```text\n' + task + '\n```',
    ]) expect(evaluateTask(text).regression, text).toBeUndefined();
  });
});

describe('batching caller counts completed issue decisions across setup boundaries', () => {
  const issue = (number: number, header = 'Architecture'): NativePlanQuestionCall => {
    const question = `D${number + 2} — Issue ${number}: Choose the component contract\nELI10: The current contract leaves behavior unspecified.`;
    return { sessionId: 'owned-session', toolUseId: `toolu_issue_${number}`, answered: true, failed: false,
      answeredAt: '2026-01-01T00:00:00.000Z', unansweredQuestionIndices: [],
      questions: [{ header, question, multiSelect: false, options: [
        { label: `${number}A: Define the contract`, description: 'Specify the behavior.' },
        { label: `${number}B: Retain the current contract`, description: 'Keep the documented risk.' },
      ] }], answers: { [question]: `${number}A: Define the contract` } };
  };
  const check = (call: NativePlanQuestionCall, prior: readonly NativePlanQuestionCall[] = []) =>
    isEngBatchingIssueAUQ(nativePlanCallFingerprint(call, 0, true), prior);

  test('six completed calls count six; unrelated wording and either offered choice do not change identity', () => {
    const history: NativePlanQuestionCall[] = [];
    for (const [i, header] of ['Architecture', 'Architecture', 'Architecture', 'Code quality', 'Tests', 'Performance'].entries()) {
      const call = issue(i + 1, header);
      if (i % 2) call.answers![call.questions[0]!.question] = call.questions[0]!.options[1]!.label;
      expect(check(call, history)).toBe(true); history.push(call);
    }
    expect(history).toHaveLength(6);
    expect(check(history[0]!, history)).toBe(false);
    const repeated = structuredClone(history[0]!); repeated.toolUseId = 'toolu_repeated';
    expect(check(repeated, history)).toBe(false);
    const scope = issue(1, 'Scope');
    expect(check(repeated, [scope])).toBe(true);
    const batch = issue(1), second = issue(2);
    batch.questions.push(...second.questions); Object.assign(batch.answers!, second.answers);
    expect(check(repeated, [batch])).toBe(true);
  });

  test('one batched native call cannot satisfy a three-call floor', () => {
    const batch = issue(1);
    for (const number of [2, 3, 4]) {
      const next = issue(number); batch.questions.push(...next.questions); Object.assign(batch.answers!, next.answers);
    }
    const count = [batch].filter(call => check(call)).length;
    expect(count).toBeLessThanOrEqual(1); expect(count).toBeLessThan(3);
  });

  test('incomplete, foreign, inconsistent or non-issue packets cannot inflate the counter', () => {
    const variants: Array<(call: NativePlanQuestionCall) => void> = [
      c => { c.answered = false; }, c => { c.failed = true; }, c => { c.unansweredQuestionIndices = [0]; },
      c => { delete c.answeredAt; }, c => { c.answers = {}; }, c => { c.questions[0]!.multiSelect = true; },
      c => { c.answers![c.questions[0]!.question] = 'Not offered'; },
      c => { c.questions[0]!.options[1]!.label = '2B: Foreign issue'; },
      c => { c.questions[0]!.options[1]!.label = '1A: Duplicate option ID'; },
      c => { c.questions[0]!.header = 'Scope'; }, c => { c.questions[0]!.header = 'Next steps'; },
      c => { c.questions[0]!.header = 'TODO'; }, c => { c.questions[0]!.header = 'Design'; },
      c => { question(c, c.questions[0]!.question.replace('Issue 1:', 'TODO 1:')); },
      c => { question(c, '> ' + c.questions[0]!.question); },
      c => { question(c, 'Historical note:\n' + c.questions[0]!.question); },
      c => { question(c, c.questions[0]!.question + '\nThis decision is "withdrawn".'); },
      c => { question(c, c.questions[0]!.question + '\nIssue 1 is no longer current.'); },
      c => { question(c, c.questions[0]!.question + '\nThis decision is `no longer current`.'); },
    ];
    for (const change of variants) { const call = issue(1); change(call); expect(check(call)).toBe(false); }
    const fp = nativePlanCallFingerprint(issue(1), 0, true); fp.signature = 'foreign:identity';
    expect(isEngBatchingIssueAUQ(fp)).toBe(false);
    expect(check(issue(2), [{ ...issue(1), sessionId: 'foreign-session' }])).toBe(false);
    const call = issue(1); question(call, call.questions[0]!.question + '\n> This decision is withdrawn.');
    expect(check(call)).toBe(true);
    const quoted = issue(1); question(quoted, quoted.questions[0]!.question + '\n`This decision is withdrawn.`');
    expect(check(quoted)).toBe(true);
  });
});

describe('current facade decision and accepted legacy baseline ledger', () => {
const fixture = ledgerSeedFixture;
const check = evaluateEngSeedCoverage;
const clone=<T>(value:T):T=>structuredClone(value);
const call=()=>clone(fixture.complexityCall);
const answerAt=Date.parse(fixture.complexityCall.answeredAt);
const complexity=(value=call())=>check({status:'ready',calls:[value],assistantMessages:[]},'',0,answerAt+1).decisions.complexity;
const alter=(change:(question:any)=>void)=>{const c=call(),q=c.questions[0]!,old=q.question,index=q.options.findIndex(o=>o.label===c.answers[old]);change(q);c.answers={[q.question]:q.options[index]!.label};return c;};
const regression=(plan:string)=>check({status:'ready',calls:[],assistantMessages:[]},plan,0,1).regression;
const plan=fixture.legacyPlan;
const task=(id:string)=>new RegExp(`^- \\[ \\] \\*\\*${id} [^\\n]+\\n(?:  [^\\n]*(?:\\n|$))*`,'m').exec(plan)![0];
const t1=task('T1'), t9=task('T9');

test('the complete current D8 and R7/T1/T9 evidence works in isolation',()=>{expect(complexity()).toBeDefined();expect(regression(plan)).toBe('plan');});

for(const [name,change] of Object.entries({
 'title layout synonym':(q:any)=>{q.question=q.question.replace('Class arrangement:','Class layout:');},
 'numeric inventory':(q:any)=>{q.question=q.question.replace('four new classes:','4 new classes:');},
 'larger consistently bound inventory':(q:any)=>{q.question=q.question.replace('four new classes: AuthBroker, SessionMint, RequestPolicy and AuthCache','five new classes: AuthBroker, SessionMint, RequestPolicy, SessionAudit and AuthCache');q.options[0].label=q.options[0].label.replace('3 classes','4 classes');q.options[1].label=q.options[1].label.replace('4 classes','5 classes');},
 'removal action synonym':(q:any)=>{q.options[0].label=q.options[0].label.replace('Drop the facade','Remove AuthCache facade');},
 'option letters reordered':(q:any)=>{q.options[0].label=q.options[0].label.replace('B)','A)');q.options[1].label=q.options[1].label.replace('A)','B)');},
 'question ordinal changes':(q:any)=>{q.question=q.question.replace(/^D8 /,'D38 ');},
}))test(`complexity presentation preserves ownership: ${name}`,()=>expect(complexity(alter(change))).toBeDefined());

for(const [name,change] of Object.entries({
 'missing inventory':(q:any)=>{q.question=q.question.replace(/After D6\/D7 the plan has four new classes:[^.]+\./,'');},
 'inventory count mismatch':(q:any)=>{q.question=q.question.replace('four new classes:','five new classes:');},
 'duplicate inventory component':(q:any)=>{q.question=q.question.replace('RequestPolicy and AuthCache','AuthBroker and AuthCache');},
 'no current unchanged-rule assertion':(q:any)=>{q.question=q.question.replace('keeps every rule unchanged','changes the validity rules');},
 'no redundant-facade finding':(q:any)=>{q.question=q.question.replace('a pass-through','an independent policy engine');},
 'different component title':(q:any)=>{q.question=q.question.replace(/^D8 — Class arrangement: keep the AuthCache/,'D8 — Class arrangement: keep the BillingCache');},
 'foreign baseline component':(q:any)=>{q.question=q.question.replace('AuthBroker, SessionMint, RequestPolicy','AuthWorker, SessionWorker, RequestPolicy');},
 'wrong reduced count':(q:any)=>{q.options[0].label=q.options[0].label.replace('3 classes','4 classes');},
 'wrong retained count':(q:any)=>{q.options[1].label=q.options[1].label.replace('4 classes','5 classes');},
 'no direct existing adapter':(q:any)=>{q.options[0].description=q.options[0].description.replace('existing, tested adapter interface directly','new independent token store');},
 'quoted title':(q:any)=>{q.question='>'+q.question;},
 'quoted explanation':(q:any)=>{q.question=q.question.replace('ELI10: ','ELI10: Source: ');},
 'withdrawn decision':(q:any)=>{q.question+='\nD8 is withdrawn.';},
 'withdrawn option':(q:any)=>{q.options[0].description+='\nThis option is withdrawn.';},
 'conditional option':(q:any)=>{q.options[0].description+='\nIf approved, drop it.';},
 'later independent purpose':(q:any)=>{q.question+='\nCorrection: AuthCache now has independent behavior.';},
}))test(`complexity rejects unsupported evidence: ${name}`,()=>expect(complexity(alter(change))).toBeUndefined());
for(const [name,change] of Object.entries({
 'unanswered':(c:any)=>{c.answered=false;},'failed':(c:any)=>{c.failed=true;},'pending tab':(c:any)=>{c.unansweredQuestionIndices=[0];},'no answer':(c:any)=>{c.answers={};},'unoffered answer':(c:any)=>{c.answers[c.questions[0].question]='Delete all code';},'late answer':(c:any)=>{c.answeredAt=new Date(answerAt+2).toISOString();},
}))test(`complexity requires actual native completion: ${name}`,()=>{const c=call();change(c);expect(complexity(c)).toBeUndefined();});

for(const [name,change] of Object.entries({
 'all ownership IDs renamed':(s:string)=>s.replace(/\bR7\b/g,'Ledger7').replace(/\bD12\b/g,'D32').replace(/\bT1\b/g,'T21').replace(/\bT9\b/g,'T29'),
 'punctuated ledger identity':(s:string)=>s.replace(/\bR7\b/g,'Risk.7'),
 'verification action synonym':(s:string)=>s.replace('Assert accept/reject outcome','Verify accept/reject outcome'),
 'ordinary filename':(s:string)=>s.replace('legacyAuthFlow.characterization.test.*','tests/auth/prior.test.ts'),
 'record action':(s:string)=>s.replace('capture golden tests','record golden tests').replace('Capture the 10-case','Record the 10-case'),
 'wrapped accepted scope':(s:string)=>s.replace('Accepted scope: before any rewrite, capture','Accepted scope: before any rewrite,\n capture').replace('Assert accept/reject','\nAssert accept/reject'),
 'HTTP status label':(s:string)=>s.replace('error class/status per case','error class/HTTP status per case'),
 'unformatted source':(s:string)=>s.replace(/[`*]/g,''),
}))test(`legacy baseline presentation remains bound: ${name}`,()=>expect(regression(change(plan))).toBe('plan'));

for(const [name,change] of Object.entries({
 'no mandatory rule':(s:string)=>s.replace('(REGRESSION RULE)','(optional idea)'),
 'no critical requirement':(s:string)=>s.replace('CRITICAL/P1','P2'),
 'no current accepted scope':(s:string)=>s.replace(/^Accepted scope:.*$/m,''),
 'no actual answer':(s:string)=>s.replace(/^Actual answer:.*$/m,''),
 'wrong answered question':(s:string)=>s.replace('** (D12)','** (D99)'),
 'unselected baseline option':(s:string)=>s.replace('Actual answer: **A,','Actual answer: **B,'),
 'duplicate accepted scope':(s:string)=>s.replace(/^Accepted scope:.*$/m,x=>x+'\n'+x),
 'capture after rewrite':(s:string)=>s.replace('Accepted scope: before any rewrite','Accepted scope: after the rewrite'),
 'wrong legacy target':(s:string)=>s.replace(/legacyAuthFlow/g,'otherAuthFlow'),
 'case count mismatch':(s:string)=>s.replace('Accepted scope: before any rewrite, capture golden tests from the running `legacyAuthFlow()` for: valid token; expired;','Accepted scope: before any rewrite, capture golden tests from the running `legacyAuthFlow()` for: valid token;'),
 'no outcome assertion':(s:string)=>s.replace('Assert accept/reject outcome and error class/status per case.','Assert error class/status per case.'),
 'no error class assertion':(s:string)=>s.replace('error class/status per case','status per case'),
 'no status assertion':(s:string)=>s.replace('error class/status per case','error class per case'),
 'no same suite replay':(s:string)=>s.replace('Replay the suite against the new path.','Write unrelated new tests.'),
 'no caller coverage':(s:string)=>s.replace('add one integration test per caller path','add one smoke test'),
 'missing baseline task':(s:string)=>s.replace(t1,''),
 'duplicate baseline task':(s:string)=>s.replace(t1,t1+t1),
 'punctuation cannot match another ledger identity':(s:string)=>s.replace('### R7:', '### Risk.7:').replace('R7/D12','RiskX7/D12'),
 'wrong ledger linkage':(s:string)=>s.replace('R7/D12','R8/D12'),
 'wrong question linkage':(s:string)=>s.replace('R7/D12','R7/D13'),
 'missing task files':(s:string)=>s.replace(/^  - Files: new.*$/m,''),
 'missing baseline verification':(s:string)=>s.replace(/^  - Verify: matrix.*$/m,''),
 'new-path-only verification':(s:string)=>s.replace('matrix green against legacy','matrix green against new path'),
 'no green baseline':(s:string)=>s.replace('matrix green against legacy','matrix fails against legacy'),
 'no green parity':(s:string)=>s.replace('replayed green against new path before swap','replayed failing against new path before swap'),
 'missing removal gate':(s:string)=>s.replace(t9,''),
 'wrong replayed suite':(s:string)=>s.replace('only after T1 replays green','only after T8 replays green'),
 'deletion before replay':(s:string)=>s.replace('only after T1 replays green','before T1 replays green'),
 'missing caller replay':(s:string)=>s.replace('T1 suite + per-caller integration tests green on the new path','T1 suite green on the new path'),
 'historical ledger':(s:string)=>s.replace('## Decision ledger','## Historical decision ledger'),
 'quoted accepted scope':(s:string)=>s.replace(/^Accepted scope:.*$/m,x=>'> '+x),
 'literal accepted scope':(s:string)=>s.replace(/^Accepted scope:.*$/m,x=>'`'+x.replaceAll('`','')+'`'),
 'source verification':(s:string)=>s.replace('  - Verify: matrix','  Source:\n  - Verify: matrix'),
 'conditional verification':(s:string)=>s.replace('  - Verify: matrix','  If approved:\n  - Verify: matrix'),
 'withdrawn ledger state':(s:string)=>s.replace('State: pending','State: withdrawn'),
 'changed baseline assertions':(s:string)=>s+'\n## Current assessment\nT1 assertions are changed.\n',
 'legacy changed before baseline':(s:string)=>s+'\n## Current assessment\nlegacyAuthFlow() is rewritten before T1.\n',
}))test(`legacy baseline rejects missing or revoked obligations: ${name}`,()=>{const changed=change(plan);expect(changed).not.toBe(plan);expect(regression(changed)).toBeUndefined();});
for(const id of ['R7','D12','T1','T9'])for(const status of ['withdrawn','optional','not current'])test(`current ${id} ${status} revokes this baseline`,()=>expect(regression(plan+`\n## Current assessment\n${id} is "${status}".\n`)).toBeUndefined());
for(const text of ['\n## Historical assessment\nR7 is withdrawn.','\n## Current assessment\n"T1 is withdrawn."','\n## Payment regression suite\nThe regression suite is withdrawn.','\n## Current assessment\nT88 is withdrawn.'])test(`unowned or unrelated cancellation cannot revoke current baseline: ${text}`,()=>expect(regression(plan+text)).toBe('plan'));

});

import c6fc from './fixtures/eng-count-c6fc-public.json';
import { isEngSeedDecisionAUQ } from './helpers/eng-seeded-coverage';
describe('complete source-owned native fields identify current seeded subjects', () => {
  const capturedCalls = c6fc.transcript.calls as NativePlanQuestionCall[];
  const classify = (call: NativePlanQuestionCall) => isEngSeedDecisionAUQ(nativePlanCallFingerprint(call, 1, false), [], c6fc.startedAt, c6fc.finishedAt);
  test('actual component and error decisions cover the two missing subjects without relabeling the cancellation', () => {
    expect(classify(capturedCalls[4]!)).toBe(true);
    expect(classify(capturedCalls[6]!)).toBe(true);
    const result = evaluateEngSeedCoverage(c6fc.transcript as PlanCountTranscript, c6fc.report, c6fc.startedAt, c6fc.finishedAt);
    expect(result.ok).toBe(true);
    expect(new Set(Object.values(result.decisions)).size).toBe(4);
    expect(result.regression).toBe('plan');
    expect(c6fc.actualOutcome).toBe('CANCELLED');
  });
  test('subject assessment and complete offered remedies cannot be borrowed or withdrawn', () => {
    for (const index of [4, 6]) {
      const original = capturedCalls[index]!;
      const edits: ((c: NativePlanQuestionCall) => void)[] = [
        c => { c.answered = false; }, c => { c.failed = true; },
        c => { c.answers = {}; }, c => { c.answeredAt = new Date(c6fc.startedAt - 1).toISOString(); },
        c => question(c, c.questions[0]!.question.replace('PLAN.md', 'FOREIGN.md')),
        c => question(c, c.questions[0]!.question.replace('Project/branch/task:', 'Historical source:')),
        c => question(c, c.questions[0]!.question.replace('ELI10: ', 'ELI10: Historical example: ')),
        c => question(c, c.questions[0]!.question.replace(/ELI10: (.+)/, 'ELI10: "$1"')),
        c => question(c, c.questions[0]!.question + '\nThis finding is withdrawn.'),
        c => question(c, c.questions[0]!.question + '\nThis finding is "not current".'),
        c => question(c, c.questions[0]!.question + '\nThis remedy is rejected.'),
        c => question(c, c.questions[0]!.question + `\nD${index + 1} is withdrawn.`),
        c => question(c, c.questions[0]!.question + '\nThis finding applies only if approved.'),
        c => { c.questions[0]!.options[0]!.label = 'Do not ' + c.questions[0]!.options[0]!.label; },
        c => { c.questions[0]!.options[0]!.description = 'A complete unrelated option.'; },
        c => { c.questions[0]!.options[0]!.label = 'An unrelated alternative'; },
        c => { c.questions[0]!.options[0]!.description = 'Historical example: ' + c.questions[0]!.options[0]!.description; },
      ];
      for (const edit of edits) { const c = structuredClone(original); edit(c); expect(classify(c), c.questions[0]!.question).toBe(false); }
    }
  });
});


test('complete native subject claims preserve their own counts and current remedy facts', () => {
  const check = (c: NativePlanQuestionCall) => isEngSeedDecisionAUQ(nativePlanCallFingerprint(c, 1, false), [], c6fc.startedAt, c6fc.finishedAt);
  const bad: [number, (c: NativePlanQuestionCall) => void][] = [
    [4, c => question(c, c.questions[0]!.question.replace('remaining four components', 'remaining three components'))],
    [4, c => { const q = c.questions[0]!; q.options[0]!.label = q.options[0]!.label.replace('3 units:', '1 unit:'); c.answers![q.question] = q.options[0]!.label; }],
    [4, c => { c.questions[0]!.options[0]!.description += '\nCorrection: RequestPolicy remains a class with independent state.'; }],
    [6, c => { c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('fail-closed by construction', 'not fail-closed by construction'); }],
    [6, c => { c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('a structured log line', 'no structured log line'); }],
    [6, c => { c.questions[0]!.options[0]!.description = c.questions[0]!.options[0]!.description!.replace('Every error class maps', 'Not every error class maps'); }],
    [6, c => { c.questions[0]!.options[0]!.description += '\nCorrection: this remedy stays fail-open on unknown errors; those errors remain silent.'; }],
  ];
  for (const [index, edit] of bad) { const c = structuredClone(c6fc.transcript.calls[index]!) as NativePlanQuestionCall; edit(c); expect(check(c)).toBe(false); }
  for (const index of [4, 6]) {
    const c = structuredClone(c6fc.transcript.calls[index]!) as NativePlanQuestionCall;
    c.questions[0]!.options[0]!.description += '\n❌ If the implementation ignores this contract, bugs could remain; the accepted requirements still apply.';
    expect(check(c)).toBe(true);
    const conditional = index === 4
      ? "❌ If RequestPolicy remains a class, this option's purity contract has not been implemented."
      : "❌ If errors remain silent, this option's explicit-outcome contract has not been implemented.";
    c.questions[0]!.options[0]!.description += '\n' + conditional;
    expect(check(c)).toBe(true);
    c.questions[0]!.options[0]!.description += index === 4
      ? '\nCorrection: RequestPolicy remains a class with independent state.'
      : '\nCorrection: this remedy stays fail-open on unknown errors; those errors remain silent.';
    expect(check(c)).toBe(false);
    for (const source of ['other/PLAN.md', '/another-project/PLAN.md']) {
      const foreign = structuredClone(c6fc.transcript.calls[index]!) as NativePlanQuestionCall;
      question(foreign, foreign.questions[0]!.question.replaceAll('PLAN.md', source));
      expect(check(foreign)).toBe(false);
    }
  }
});


describe('captured required legacy characterization task representation', () => {
  const task = cddRegression.parts[1]!;
  const wrap = (body: string) => '# Current reviewed plan\n\n'+cddRegression.parts[0]+'\n## Implementation Tasks\n'+body+'\n\n## GSTACK REVIEW REPORT\nComplete.\n';
  test('required noun-form task retains the existing affirmative regression semantics', () => {
    expect(evaluate(transcript(), wrap(task)).regression).toBe('plan');
    expect(evaluate(transcript(), '# Current reviewed plan\n'+cddRegression.parts[0]+'\n## Implementation Tasks\n'+task+'\n## GSTACK REVIEW REPORT\nComplete').regression).toBe('plan');
    expect(evaluate(transcript(), wrap(task).replace('(user answer to D8)', '(D8)')).regression).toBe('plan');
    expect(evaluate(transcript(), wrap(task).replace('A — Characterization suite + shadow-mode comparison (user answer to D8)', 'B — Characterization suite only (user answer to D8)').replace(/ \(2\) Flag gains[^\n]*?Behavior preserved:/, ' Behavior preserved:').replace('; SHADOW compare + `auth.parity.mismatch` metric + D7 allowlist', '').replace(', auth/routing/shadowCompare', '').replace('; deliberately broken fixture emits mismatch; allowlisted case does not', '')).regression).toBe('plan');
    expect(evaluate(transcript(), wrap(task).replace('Behavior preserved:', 'Error cases must not dispatch after Deny. Behavior preserved:')).regression).toBe('plan');
    expect(cddRegression.originalOutcome).toContain('FAIL');
  });
  test('required target, file and verification cannot be missing, foreign or contradictory', () => {
    for (const bad of [
      task.replace('P1 CRITICAL', 'P1'),
      task.replace('suite from legacyAuthFlow()', 'suite from anotherAuthFlow()'),
      task.replace('legacyAuthFlow.characterization.test', 'anotherAuthFlow.characterization.test'),
      task.replace('suite green on both paths', 'suite green on the new path only'),
      task.replace('suite green on both paths', 'suite not green on both paths'),
      task.replace('  - Verify:', '  - Optional verification:'),
      task+'\n  - Verify: suite green on both paths',
      task+'\n'+task,
      task.replace('Characterization suite', 'Optional characterization suite'),
      task.replace('Characterization suite', 'Do not add characterization suite'),
    ]) expect(evaluate(transcript(), wrap(bad)).regression).toBeUndefined();
  });
  test('source framing and current withdrawal cannot lend completed coverage', () => {
    for (const plan of [
      wrap(task).replace('## Implementation Tasks', '## Historical implementation tasks'),
      wrap(task).replace('## Implementation Tasks', '## Example'),
      wrap('```\n'+task+'\n```'),
      wrap(task+'\n\nT6 is withdrawn.'),
      wrap(task).replace('State: approved', 'State: pending'),
      wrap(task).replace('### R8:', '## History\n### R8:'),
      wrap(task).replaceAll('PLAN.md:', 'other/PLAN.md:'),
      wrap(task).replace('Question D8:', 'Question D8:\nQuestion D9:'),
      ...['not run', 'do not run', 'never run', 'no longer run', 'if approved, run'].map(action => wrap(task).replace('run against both legacyAuthFlow()', action+' against both legacyAuthFlow()')),
      ...['not recorded', 'never recorded', 'no longer recorded', 'if approved, recorded'].map(action => wrap(task).replace('recorded from legacyAuthFlow()', action+' from legacyAuthFlow()')),
      ...['Do not run against both paths.', 'Never run against both paths.', 'Only if approved, run against both paths.'].map(conflict => wrap(task).replace('Behavior preserved:', conflict+' Behavior preserved:')),
      wrap(task).replace('Actual answer: A —', 'Actual answer: B —'),
      wrap(task).replace('Actual answer: A — Characterization suite + shadow-mode comparison', 'Actual answer: C — Shadow-mode comparison only'),
      ...['Do not add characterization suite', 'Characterization suite deferred', 'Characterization suite optional'].map(caption => wrap(task).replaceAll('Characterization suite + shadow-mode comparison', caption)),
      wrap(task+'\n\nR8 is withdrawn.'),
      wrap(task+'\n\nD8 is withdrawn.'),
      wrap(task+'\n\nCorrection: skip T6.'),
      wrap(task+'\n\nT6 assertions are changed.'),
    ]) expect(evaluate(transcript(), plan).regression).toBeUndefined();
  });
});

// This original attempt timed out and had a separate D3 approval mismatch.
// These assertions cover its three metric representations, not release success.
import a689Count from './fixtures/eng-a689-count-public.json';
import { isEngCompletionHandoff } from './helpers/eng-completion-handoff';
describe('current native explanations and scheduled legacy baseline from a689', () => {
  const originals=a689Count.calls as NativePlanQuestionCall[];
  const begin=Date.parse(a689Count.windowStart), finish=Date.parse(a689Count.windowEnd);
  const check=(calls=structuredClone(originals),parts=a689Count.parts) => evaluateEngSeedCoverage(
    {status:'ready',calls,assistantMessages:[]},parts.join('\n\n'),begin,finish);
  test('neutral D1 and D2 own distinct complexity and shared-state decisions',()=>{
    const result=check();
    expect(result.decisions.complexity).toBe(`${originals[0]!.sessionId}:${originals[0]!.toolUseId}`);
    expect(result.decisions['shared-cache']).toBe(`${originals[1]!.sessionId}:${originals[1]!.toolUseId}`);
    expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(originals[2]!,1,false),[],begin,finish)).toBe(false);
  });
  test('the approved baseline and replay tasks establish required legacy coverage',()=>{
    expect(check().regression).toBe('plan');
    expect(a689Count.originalOutcome).toBe('timeout');
  });
  test('the original inconsistent investigation and D9 remain outside navigation credit',()=>{
    const call=originals.at(-1)!;
    expect(isEngCompletionHandoff(nativePlanCallFingerprint(call,1,false),a689Count.parts.join('\n\n'),originals.slice(0,-1))).toBe(false);
  });
  const editCall=(index:number, change:(q:NativePlanQuestionCall['questions'][number])=>void)=>{
    const calls=structuredClone(originals),call=calls[index]!,q=call.questions[0]!,old=q.question,answer=call.answers![old]!;
    change(q); call.answers={[q.question]:answer};return calls;
  };
  test('current seed ownership and the whole offered remedy survive presentation changes',()=>{
    for(const [index,before,after] of [
      [0,'five new classes','5 new classes'],
      [0,'How many moving parts should this refactor introduce?','Which component structure should this refactor introduce?'],
      [1,'How should the two services get hold of the one cache adapter?','How should these services receive the cache adapter?'],
    ] as const){
      const calls=editCall(index,q=>q.question=q.question.replace(before,after));
      expect(check(calls).decisions[index===0?'complexity':'shared-cache']).toBeDefined();
    }
    const rearranged=editCall(1,q=>{
      const lines=q.options[0]!.description!.split('. ');q.options[0]!.description=[lines[1],lines[0],...lines.slice(2)].join('. ');
    });
    expect(check(rearranged).decisions['shared-cache']).toBeDefined();
    const phrased=editCall(1,q=>q.options[0]!.description=q.options[0]!.description!.replace('AuthBroker and SessionMint','SessionMint and AuthBroker').replace('constructor parameter','constructor argument').replace('constructs a single','creates one'));
    expect(check(phrased).decisions['shared-cache']).toBeDefined();
    const risk=editCall(0,q=>q.options[0]!.description+=' If RequestPolicy later becomes stateful, this pure function would need another review.');
    expect(check(risk).decisions.complexity).toBeDefined();
  });
  test('borrowed sources, inactive facts and partial or contradictory remedies cannot supply seeds',()=>{
    const controls:Array<[number,(q:NativePlanQuestionCall['questions'][number])=>void]>=[
      [0,q=>q.question=q.question.replace('PLAN.md','other/PLAN.md')],
      [0,q=>q.question=q.question.replace('five new classes','four new classes')],
      [0,q=>q.question=q.question.replace('ELI10:','ELI10: Historical example:')],
      [0,q=>q.question+='\nThis finding is withdrawn.'],
      [0,q=>q.options[0]!.description+=' RequestPolicy holds mutable state.'],
      [0,q=>q.options[0]!.description+=' TokenStore remains a separate class.'],
      [0,q=>q.options[0]!.description=q.options[0]!.description!.replace('pure function','function')],
      [0,q=>q.options[0]!.description=q.options[0]!.description!.replace('TokenStore is dropped','TokenStore is retained')],
      [0,q=>q.options[1]!.description=q.options[1]!.description!.replace('TokenStore','AuthBroker')],
      [1,q=>q.question=q.question.replace('Project/branch/task:','Project/branch/task: other/PLAN.md —')],
      [1,q=>q.question=q.question.replace('ELI10:','ELI10: Quoted example:')],
      [1,q=>q.question+='\nThis issue is resolved.'],
      [1,q=>q.options[0]!.description=q.options[0]!.description!.replace('fresh fake adapter','production adapter')],
      [1,q=>q.options[0]!.description+=' Both services still import the module-level adapter.'],
      [1,q=>q.options[0]!.description+=' Tests share the same production adapter.'],
      [1,q=>q.options[0]!.description=q.options[0]!.description!.replace('passes it to both','passes it only to AuthBroker')],
    ];
    for(const [n,[index,change]] of controls.entries()) expect({n,result:check(editCall(index,change)).decisions[index===0?'complexity':'shared-cache']}).toEqual({n,result:undefined});
    for(const index of [0,1]){
      const calls=structuredClone(originals);calls[index]!.answered=false;
      expect(check(calls).decisions[index===0?'complexity':'shared-cache']).toBeUndefined();
    }
  });
  test('native selection, exact saved fields, current scope and both task proofs stay mandatory',()=>{
    const changes:Array<(parts:string[])=>void>=[
      parts=>parts[1]=parts[1]!.replaceAll('PLAN.md:','other/PLAN.md:'),
      parts=>parts[1]=parts[1]!.replace('(CRITICAL)','(non-CRITICAL)'),
      parts=>parts[1]=parts[1]!.replace('(CRITICAL)','(not CRITICAL)'),
      parts=>parts[1]=parts[1]!.replace('State: approved','State: pending'),
      parts=>parts[1]=parts[1]!.replaceAll('State: approved','State: approved\nState: approved'),
      parts=>parts[1]=parts[1]!.replace('Header: Regression','Header: Stale'),
      parts=>parts[1]=parts[1]!.replace('Actual answer: A — "Full characterization matrix"','Actual answer: B — "Happy path + three error classes"'),
      parts=>parts[1]=parts[1]!.replace('same IDP call set.','same IDP call set. Cache writes are not asserted.'),
      parts=>parts[1]=parts[1]!.replace('Fixtures are built before the rewrite starts.','Fixtures are built after the rewrite starts.'),
      parts=>parts[1]=parts[1]!.replace('(2) Intentional differences: typed outcomes (ValidationFailed / Denied / DispatchFailed) instead of swallowed errors (D4 → A);','(2) Intentional differences: typed outcomes (ValidationFailed / Denied / DispatchFailed) instead of swallowed errors (D4 → B);'),
      parts=>parts[2]=parts[2]!.replace('run against `legacyAuthFlow()` to capture golden values','run against `validateAndDispatch()` to capture golden values'),
      parts=>parts[2]=parts[2]!.replace('Verify: parity suite green against legacy alone','Verify: suite runs later'),
      parts=>parts[2]=parts[2]!.replace('run against `legacyAuthFlow()`','not run against `legacyAuthFlow()`'),
      parts=>parts[2]=parts[2]!.replace('Verify: parity + E2E green','Verify: new-only tests green'),
      parts=>parts[2]=parts[2]!.replace('Files: test/ (new), fixtures','Files: foreign/'),
      parts=>parts[2]=parts[2]!.replace('Test review — T1 (D5 → A)','Test review — T1 (D5 → B)'),
      parts=>parts[2]=parts[2]!.replace('delete `legacyAuthFlow()` only when green','delete `legacyAuthFlow()` immediately'),
      parts=>parts[2]=parts[2]!.replace('## Implementation Tasks','## Historical Implementation Tasks'),
      parts=>parts[2]+='\nT3 is optional.',
      parts=>parts[1]+='\n## Current correction\nR5 is withdrawn.',
    ];
    for(const [n,change] of changes.entries()){const parts=[...a689Count.parts];change(parts);expect({n,result:check(structuredClone(originals),parts).regression}).toEqual({n,result:undefined});}
    for(const index of [3,4]){
      const calls=structuredClone(originals),call=calls[index]!,q=call.questions[0]!;call.answers![q.question]=q.options[1]!.label;
      expect(check(calls).regression).toBeUndefined();
    }
    const duplicate=[...originals,structuredClone(originals[4]!)];
    expect(check(duplicate).regression).toBeUndefined();
  });
  test('record selector notation and role order do not change native field ownership',()=>{
    const parts=[...a689Count.parts];
    parts[1]=parts[1]!.replace(/^(A|B|C)\) ([^\n]+)\n(?!(?:  |Header:))/gm,(line,letter)=>`${letter}) ${line}`);
    expect(check(structuredClone(originals),parts).regression).toBe('plan');
    const reordered=[...a689Count.parts];
    reordered[1]=reordered[1]!.replace(/(\(1\) Behavior to preserve: .+?)(\(2\) Intentional differences: .+?)(\(3\) Acceptance: .+)/, '$3 $1$2');
    expect(check(structuredClone(originals),reordered).regression).toBe('plan');
    const taskPhrasing=[...a689Count.parts];taskPhrasing[2]=taskPhrasing[2]!.replace('Build the parity fixture matrix','Write the parity fixture matrix').replace('run against `legacyAuthFlow()` to capture golden values','execute against `legacyAuthFlow()` to record golden outcomes');
    expect(check(structuredClone(originals),taskPhrasing).regression).toBe('plan');
    const incomplete=editCall(4,q=>q.options[0]!.description=q.options[0]!.description!.replace('cache writes and IDP call set','cache writes'));
    expect(check(incomplete).regression).toBeUndefined();
  });

});

// Complete public fields from the cancelled 6aef attempt, without paid verdict credit.
import current6aef from './fixtures/eng-6aef-count-public.json';
const current6aefClass = () => structuredClone(current6aef.calls[2]) as NativePlanQuestionCall;
for (const [name, expected, edit] of [
  ['actual focused class-to-function choice', true, undefined],
  ['foreign plan', false, (c:any)=>{c.questions[0].question=c.questions[0].question.replace('PLAN.md','OTHER.md');}],
  ['missing cited plan', false, (c:any)=>{c.questions[0].question=c.questions[0].question.replace('PLAN.md','the plan');}],
  ['missing count reduction', false, (c:any)=>{c.questions[0].options[0].description=c.questions[0].options[0].description.replace('New class count drops 5 to 4.','');}],
  ['inconsistent count reduction', false, (c:any)=>{c.questions[0].options[0].description=c.questions[0].options[0].description.replace('drops 5 to 4','drops 5 to 3');}],
  ['stateful current component', false, (c:any)=>{c.questions[0].question+='\nCorrection: RequestPolicy now holds mutable state.';}],
  ['withdrawn current choice', false, (c:any)=>{c.questions[0].question+='\nCorrection: D3 is withdrawn.';}],
  ['unanswered current choice', false, (c:any)=>{c.answered=false;}],
] as const) test('6aef complexity: '+name,()=>{
 const c=current6aefClass(); edit?.(c);
 expect(isEngSeedDecisionAUQ(nativePlanCallFingerprint(c,0,false),current6aef.calls.slice(0,2) as NativePlanQuestionCall[],Date.parse(current6aef.windowStart))).toBe(expected);
});

const current6aefRegression=()=>({report:current6aef.report,calls:structuredClone(current6aef.calls) as NativePlanQuestionCall[]});
function current6aefRecord(x:ReturnType<typeof current6aefRegression>,id:number,change:(s:string)=>string){
 const re=new RegExp(`^### R${id}:[^]*?(?=^### R[1-9]\\d*:|^## |$(?![^]))`,'m');
 const before=x.report.match(re)?.[0]; expect(before).toBeDefined(); const after=change(before!); expect(after).not.toBe(before); x.report=x.report.replace(re,after);
}
for(const [name,expected,edit] of [
 ['complete original report and all native decisions',true,undefined],
 ['missing baseline capture',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('Characterization tests written against the current','Tests written against the new'))],
 ['legacy changed before capture',false,(x:any)=>{x.report+='\nlegacyAuthFlow() is changed before T1.\n';}],
 ['baseline after adapter',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('BEFORE the adapter lands','AFTER the adapter lands'))],
 ['replay different fixtures',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('old and new on identical fixtures','old and new on different fixtures'))],
 ['unapproved difference',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('Intentional differences: zero.','Intentional differences: one.'))],
 ['additional error change',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('Intentional differences: zero.','Intentional differences: zero. Also allow unknown errors to be denied.'))],
 ['missing return assertion',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('Assertions: return shape,','Assertions:'))],
 ['missing error assertion',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('Assertions: return shape, thrown/returned error per class,','Assertions: return shape,'))],
 ['missing cache assertion',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('and which cache keys are read/written.',''))],
 ['missing matrix case',false,(x:any)=>current6aefRecord(x,7,s=>s.replaceAll('wrong issuer; ',''))],
 ['wrong answer reference',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('E2E (D7 answer)','E2E (D8 answer)'))],
 ['wrong answer caption',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('Actual answer: A) Full characterization + E2E','Actual answer: A) Different suite'))],
 ['changed saved question',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('D7 — How should','D7 — Why should'))],
 ['changed saved option',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('Effort: human ~3 days / CC ~30 min.','Effort: human ~1 day / CC ~30 min.'))],
 ['no CRITICAL requirement',false,(x:any)=>{x.report=x.report.replace(/CRITICAL/g,'RECOMMENDED');}],
 ['explicit non-CRITICAL requirement',false,(x:any)=>current6aefRecord(x,7,s=>s.replace('P1 CRITICAL','P1 non-CRITICAL'))],
 ['current withdrawal',false,(x:any)=>{x.report+='\nR7 is withdrawn.\n';}],
 ['historical withdrawal is inert',true,(x:any)=>current6aefRecord(x,7,s=>s.replace('History: none','History: R7 is withdrawn'))],
 ['missing original error approval',false,(x:any)=>{x.calls.splice(5,1);}],
 ['changed current error contract',false,(x:any)=>current6aefRecord(x,6,s=>s.replace('No observable behavior change for callers.','Unknown errors now produce a different outcome.'))],
 ['wrong task dependency',false,(x:any)=>{x.report=x.report.replace('Must be green before T5.','Must be green before T4.');}],
 ['changed replay result',false,(x:any)=>{x.report=x.report.replace('Run T1 suite + differential + E2E: zero diffs.','Run T1 suite + differential + E2E: one diff.');}],
 ['foreign task source',false,(x:any)=>{x.report=x.report.replace('Test review — T1 / R7 (D7 → A)','Test review — OTHER.md:3 T1 / R7 (D7 → A)');}],
 ['foreign native session',false,(x:any)=>{x.calls[6].sessionId='foreign';}],
 ['missing native answer',false,(x:any)=>{x.calls[6].answered=false;}],
] as const) test('6aef regression: '+name,()=>{
 const x=current6aefRegression();edit?.(x);
 const result=evaluateEngSeedCoverage({status:'ready',calls:x.calls,assistantMessages:[],planReadyRequests:[]},x.report,Date.parse(current6aef.windowStart),Date.parse(current6aef.windowEnd));
 expect(result.ok).toBe(expected);
});

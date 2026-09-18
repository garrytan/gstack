import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import type { NativePlanQuestionCall, PlanCountTranscript } from './helpers/plan-count-transcript';
import { ceoSplitCandidate, ceoSplitDecisionFingerprints, isCeoSplitCollectionComplete } from './helpers/ceo-split-question-policy';
import captured from './fixtures/ceo-split-collection-0bcd.json';

const ROOT = path.resolve(import.meta.dir, '..');
function original() {
  const calls = structuredClone(captured.calls) as NativePlanQuestionCall[];
  const transcript: PlanCountTranscript = { status: 'ready', calls, assistantMessages: [] };
  const fingerprints = captured.fingerprints.map((fp, index) => ({ ...structuredClone(fp), nativeCall: calls[index]! }));
  return { transcript, fingerprints };
}
function fromCalls(calls: NativePlanQuestionCall[]) {
  return { transcript: { status: 'ready' as const, calls, assistantMessages: [] },
    fingerprints: calls.map(call => nativePlanCallFingerprint(call, 1, true)) };
}
function accepts(state: ReturnType<typeof original>) {
  return isCeoSplitCollectionComplete(state.transcript, state.fingerprints);
}
function grouped(candidateCalls: 3 | 4) {
  const calls = original().transcript.calls;
  const group = calls[candidateCalls]!;
  for (const other of calls.splice(candidateCalls + 1)) {
    group.questions.push(...other.questions);
    Object.assign(group.answers!, other.answers);
  }
  // Controlled grouping only: captured question/option/answer bytes are intact,
  // but this is not the original native call arrangement or a recovered result.
  return fromCalls(calls);
}

test('the original timeout had all five offered ACKs below the unchanged count ceiling', () => {
  const state = original(), before = structuredClone(state);
  expect(captured.provenance.originalOutcome).toBe('timeout');
  expect(captured.provenance.originalReviewCount).toBe(5);
  expect(captured.provenance.originalReviewCountCeiling).toBe(8);
  expect(state.transcript.calls.at(-1)!.answeredAt).toBe(captured.provenance.completeAt);
  expect(accepts(state)).toBe(true);
  expect(state).toEqual(before);
  expect(ceoSplitDecisionFingerprints(state.transcript, state.fingerprints)).toHaveLength(6);
});

test.each([0, 1, 2, 3, 4, 5, 6])('the exact original %i-call prefix waits for the last candidate ACK', length => {
  const state = original();
  state.transcript.calls.length = length; state.fingerprints.length = length;
  expect(accepts(state)).toBe(length === 6);
});

test('four candidate calls with five independent tabs meet the original floor', () => {
  const state = grouped(4);
  expect(state.transcript.calls).toHaveLength(5); // Four candidate calls plus mode.
  expect(state.transcript.calls.at(-1)!.questions).toHaveLength(2);
  expect(accepts(state)).toBe(true);
});

test('workflow calls cannot raise three candidate calls to the floor', () => {
  const state = grouped(3);
  expect(state.transcript.calls).toHaveLength(4);
  expect(state.transcript.calls.flatMap(call => call.questions).filter(question => ceoSplitCandidate(question))).toHaveLength(5);
  expect(accepts(state)).toBe(false);
});

test('candidate order, pre-mode choices and reordered options keep their actual selected meaning', () => {
  const calls = original().transcript.calls.reverse();
  for (const call of calls) for (const question of call.questions) question.options.reverse();
  expect(accepts(fromCalls(calls))).toBe(true);
});

test.each(['missing', 'error'] as const)('unavailable %s transcript cannot finish collection', status => {
  const state = original(); state.transcript.status = status;
  expect(accepts(state)).toBe(false);
});

test.each(['pending', 'failed', 'missing_answer', 'custom_answer', 'hold', 'quoted', 'wrong_platform',
  'bundled', 'missing_cut', 'duplicate_action', 'multi_select', 'foreign_session', 'duplicate_target',
  'duplicate_call', 'missing_fingerprint', 'extra_fingerprint', 'foreign_fingerprint', 'altered_native_binding'])(
  'collection rejects %s evidence', kind => {
    const state = original(), call = state.transcript.calls.at(-1)!, question = call.questions[0]!;
    const selected = call.answers![question.question]!;
    if (kind === 'pending') call.answered = false;
    if (kind === 'failed') call.failed = true;
    if (kind === 'missing_answer') call.answers = {};
    if (kind === 'custom_answer') call.answers = { [question.question]: 'Custom approval' };
    if (kind === 'hold') call.answers = { [question.question]: question.options[3]!.label };
    if (kind === 'quoted') question.question = 'Example: ' + question.question;
    if (kind === 'wrong_platform') question.header = 'E5 Slack';
    if (kind === 'bundled') question.question = question.question.replace('?', ' and E4: Telegram?');
    if (kind === 'missing_cut') question.options.splice(2, 1);
    if (kind === 'duplicate_action') question.options[3]!.label = 'Include';
    if (kind === 'multi_select') question.multiSelect = true;
    if (kind === 'foreign_session') call.sessionId = 'foreign-session';
    if (kind === 'quoted' || kind === 'bundled') call.answers = { [question.question]: selected };
    if (kind === 'duplicate_target') {
      const duplicate = structuredClone(call); duplicate.toolUseId += '-duplicate';
      state.transcript.calls.push(duplicate);
    }
    if (kind === 'duplicate_call') state.transcript.calls.push(structuredClone(call));
    // Coherent mutations exercise the candidate policy, not an accidental stale
    // fingerprint. The final four cases deliberately break the binding itself.
    state.fingerprints = fromCalls(state.transcript.calls).fingerprints;
    if (kind === 'missing_fingerprint') state.fingerprints.pop();
    if (kind === 'extra_fingerprint') state.fingerprints.push(structuredClone(state.fingerprints[0]!));
    if (kind === 'foreign_fingerprint') state.fingerprints.at(-1)!.signature = 'foreign:call';
    if (kind === 'altered_native_binding') {
      state.fingerprints.at(-1)!.nativeCall = structuredClone(call);
      state.fingerprints.at(-1)!.nativeCall!.questions[0]!.options[0]!.description += ' altered';
    }
    expect(accepts(state)).toBe(false);
  },
);

// Import the actual registration in an isolated Bun child. Only its native
// runner and provider boundary are controlled; the original semantic evaluator
// still validates complete questions, exact quotes, coverage and independence.
test.each(['captured', 'four_calls', 'semantic_missing', 'semantic_bundled', 'semantic_hold', 'timeout'])(
  'actual registration keeps its semantic gate after collection: %s', async scenario => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-collection-registration-')));
    const state = scenario === 'four_calls' ? grouped(4) : original();
    const inputPath = path.join(temp, 'native.json'), factsPath = path.join(temp, 'facts.json');
    fs.writeFileSync(inputPath, JSON.stringify(state));
    const script = path.join(temp, 'registration.test.ts');
    fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CEO_SCOPE_CANDIDATES } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-cases.ts'))};
import { FORCING_SPLIT_OVERFLOW_CEO } from ${JSON.stringify(path.join(ROOT, 'test/fixtures/forcing-finding-seeds.ts'))};
import { ceoSplitCandidate, ceoSplitOptionAction, isCeoSplitCollectionComplete } from ${JSON.stringify(path.join(ROOT, 'test/helpers/ceo-split-question-policy.ts'))};
import { evaluatePlanReviewDecisions } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))};
const evaluate = evaluatePlanReviewDecisions;
const state = JSON.parse(fs.readFileSync(${JSON.stringify(inputPath)}, 'utf8'));
const facts = { runs: 0, evaluators: 0, judges: 0, directory: '', candidateCalls: 0, suppliedCalls: 0 };
const save = () => fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify(facts));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))}, () => ({
  evaluatePlanReviewDecisions: async input => {
    facts.evaluators++; save();
    expect(input.kind).toBe('scope'); expect(input.floor).toBe(4);
    expect(input.ceiling).toBeUndefined(); expect(input.targets).toEqual(CEO_SCOPE_CANDIDATES);
    expect(input.deadlineAt - Date.now()).toBeGreaterThan(1_490_000);
    expect(input.deadlineAt - Date.now()).toBeLessThanOrEqual(1_500_000);
    expect(input.fingerprints.map(fp => fp.questions)).toEqual(state.transcript.calls.map(call => call.questions));
    return evaluate(input, async (prompt, model, options) => {
      facts.judges++; save();
      expect(model).toBeUndefined(); expect(options.signal).toBeInstanceOf(AbortSignal);
      const boundary = /BEGIN_UNTRUSTED_([a-f0-9]{32})\\n/.exec(prompt);
      const data = JSON.parse(prompt.slice(boundary.index + boundary[0].length,
        prompt.lastIndexOf('\\nEND_UNTRUSTED_' + boundary[1])));
      expect(data.plan).toBe(input.plan); expect(data.targets).toEqual(CEO_SCOPE_CANDIDATES);
      expect(data.calls.map(call => call.questions)).toEqual(state.transcript.calls.map(call => call.questions));
      facts.suppliedCalls = data.calls.length;
      const rows = data.calls.flatMap(call => call.questions.map((question, index) => {
        const target = ceoSplitCandidate(question);
        return { toolUseId: call.toolUseId, questionIndex: index + 1,
          kind: target ? 'scope' : 'workflow', targetIds: target ? [target] : [],
          independentDecisions: target ? 1 : 0,
          evidence: [{field: 'question', optionIndex: null, quote: question.question.split('\\n')[0]}],
          reason: 'Controlled semantic response for the exact native fields; no paid assessment credit.',
          optionActions: target ? question.options.map((option, i) => ({optionIndex: i + 1,
            action: ceoSplitOptionAction(option.label)})) : [] };
      }));
      const last = rows.find(row => row.targetIds.includes('E5'));
      if (${JSON.stringify(scenario)} === 'semantic_missing') last.targetIds = [];
      if (${JSON.stringify(scenario)} === 'semantic_bundled') last.independentDecisions = 2;
      if (${JSON.stringify(scenario)} === 'semantic_hold') {
        const call = data.calls.find(call => call.toolUseId === last.toolUseId);
        last.optionActions.find(action => action.optionIndex === call.selectedOptions[last.questionIndex - 1]).action = 'hold';
      }
      facts.candidateCalls = new Set(rows.filter(row => row.kind === 'scope').map(row => row.toolUseId)).size;
      save(); return {questions: rows};
    });
  },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  ceoStep0Boundary: () => false,
  runPlanSkillCounting: async opts => {
    facts.runs++; save();
    expect(opts.isCollectionComplete).toBe(isCeoSplitCollectionComplete);
    expect(opts.isCollectionComplete(state.transcript, state.fingerprints)).toBe(true);
    expect(opts.reviewCountCeiling).toBe(8); expect(opts.expectedPlanPath).toBeUndefined();
    expect(opts.skillName).toBe('plan-ceo-review'); expect(opts.slashCommand).toBe('/plan-ceo-review');
    expect(opts.preconfiguredReviewActor).toBe(true); expect(opts.observeSetupQuestions).toBe(true);
    expect(opts.env).toEqual({QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default'});
    expect(opts.timeoutMs).toBeGreaterThan(1_490_000); expect(opts.timeoutMs).toBeLessThanOrEqual(1_500_000);
    facts.directory = path.dirname(opts.permissionPlanPath); save();
    expect(opts.followUpPrompt).toBe(FORCING_SPLIT_OVERFLOW_CEO.replaceAll('/tmp/gstack-test-plan-ceo-split-overflow.md', opts.permissionPlanPath));
    return {...state, outcome: ${JSON.stringify(scenario === 'timeout' ? 'timeout' : 'collection_complete')},
      reviewCount: ${scenario === 'four_calls' ? 4 : 5}, step0Count: 1, elapsedMs: 1, evidence: 'controlled collection endpoint'};
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-ceo-split-overflow.test.ts'))});
`);
    try {
      const child = Bun.spawn([process.execPath, 'test', script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
        env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp, TEMP: temp, TMP: temp,
          GIT_CONFIG_NOSYSTEM: '1', EVALS_HERMETIC: '1',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
      const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
      const passes = scenario === 'captured' || scenario === 'four_calls';
      expect(exit, out + err).toBe(passes ? 0 : 1);
      expect(facts.runs, out + err).toBe(1);
      expect(facts.evaluators, out + err).toBe(scenario === 'timeout' ? 0 : 1);
      expect(facts.judges, out + err).toBe(scenario === 'timeout' ? 0 : 1);
      if (scenario !== 'timeout') {
        expect(facts.suppliedCalls).toBe(state.transcript.calls.length);
        expect(facts.candidateCalls).toBe(scenario === 'four_calls' ? 4 : 5);
      }
      if (scenario === 'semantic_missing') {
        expect(out + err).toContain('missing target decisions');
        expect(out + err).toContain('"missingTargetIds":["E5"]');
      }
      if (scenario === 'semantic_bundled') expect(out + err).toContain('bundled independent decisions');
      if (scenario === 'semantic_hold') expect(out + err).toContain('selected scope option is not a final disposition');
      if (scenario === 'timeout') expect(out + err).toContain('outcome=timeout');
      expect(fs.existsSync(facts.directory)).toBe(false);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }, 20_000,
);

import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ceoSplitCandidate, ceoSplitDecisionFingerprints, isCeoSplitCandidateCall, pickCeoSplitCountQuestion, pickCeoSplitQuestion } from './helpers/ceo-split-question-policy';
import { pickPlanReviewQuestion } from './helpers/plan-review-cases';
import type { NativeQuestion } from './helpers/plan-skill-questions';
import { capturePlanCountQuestion, nativePlanCallFingerprint } from './helpers/claude-pty-runner';
import retained from './fixtures/ceo-split-actor-6aef.json';
import padding from './fixtures/ceo-split-padding-361c-public.json';
import splitEdit from './fixtures/ceo-split-edit-permission-361c-public.json';
import {createFilePermissionRecorder, recordFilePermission, currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';

const ROOT = path.resolve(import.meta.dir, '..');
const capturedCalls = retained.calls as Parameters<typeof nativePlanCallFingerprint>[0][];

test('the captured actor followed option 1 instead of its recommendation and cap policy', () => {
  const calls = capturedCalls.slice(0, 7);
  expect(calls.map(call => call.questions[0]!.options.findIndex(option =>
    option.label === call.answers?.[call.questions[0]!.question]) + 1)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  expect(calls.map(call => pickCeoSplitQuestion(call.questions[0]!))).toEqual([1, 2, 1, 2, 2, 2, 3]);
  // The original timeout and actual answers remain untouched by the replay.
  expect(retained.outcome).toBe('timeout');
});

test('all five actual candidate menus count before mode selection, without credit for later expansions', () => {
  const fingerprints = capturedCalls.map(call => nativePlanCallFingerprint(call, 1, true));
  expect(fingerprints.map(isCeoSplitCandidateCall)).toEqual([true, true, true, true, true, false, false, false, false, false, false, false, false]);
  expect(capturedCalls.slice(0, 5).map(call => ceoSplitCandidate(call.questions[0]!))).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
});

test('the native picker uses the complete matched active tab and never mutates it', () => {
  for (const call of capturedCalls.slice(0, 7)) {
    const pending = { ...structuredClone(call), answered: false, answers: undefined };
    const fp = nativePlanCallFingerprint(pending, 1, true);
    const before = structuredClone(fp);
    expect(pickCeoSplitCountQuestion(fp, fp)).toBe(pickCeoSplitQuestion(pending.questions[0]!));
    expect(fp).toEqual(before);
  }
});

test('each complete native tab keeps its own signature and policy', () => {
  const call = { ...structuredClone(capturedCalls[0]!), answered: false, answers: undefined,
    questions: [structuredClone(capturedCalls[0]!.questions[0]!), structuredClone(capturedCalls[1]!.questions[0]!)] };
  // Exercise the actual native viewport adapter with compact controlled
  // questions, retaining the captured options and their recommendation order.
  for (const question of call.questions) question.question = question.question.split('\n')[0]!;
  for (let index = 0; index < call.questions.length; index++) {
    const question = call.questions[index]!;
    const screen = `← ☐ ${call.questions.map(q => q.header).join(' ☐ ')} ✔ Submit →\n│ ${question.question}\n` +
      question.options.map((option, i) => `${i === 0 ? '❯' : ''}${i + 1}.${option.label}`).join('\n') +
      '\n5.Type something.\n6.Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';
    const active = capturePlanCountQuestion(screen, new Set(), 1, true, call)!;
    expect(active.nativeQuestionIndex).toBe(index);
    expect(active.signature).toBe(`${call.sessionId}:${call.toolUseId}:question:${index}`);
    expect(pickCeoSplitCountQuestion(active, active)).toBe(index + 1);
    expect(() => pickCeoSplitCountQuestion(active, {...active, signature: `${call.sessionId}:${call.toolUseId}:question:${1 - index}`}))
      .toThrow('complete matched native question');
  }
});

test('scope validation receives every exact native question, including pre-review choices and expansions', () => {
  const transcript = { status: 'ready' as const, calls: capturedCalls, assistantMessages: [] };
  const fingerprints = capturedCalls.map(call => nativePlanCallFingerprint(call, 1, true));
  const result = ceoSplitDecisionFingerprints(transcript, fingerprints);
  expect(result).toHaveLength(capturedCalls.length);
  expect(result.map(fp => fp.questions)).toEqual(capturedCalls.map(call => call.questions));
  expect(result.every(fp => fp.selectedOptions.every(index => index === 1))).toBe(true);
  expect(result.map(fp => fp.toolUseId)).toEqual(fingerprints.map(fp => fp.signature));
});

test.each(['custom_answer', 'missing_tab_answer', 'duplicate_label', 'unanswered', 'failed', 'foreign', 'omitted_call', 'extra_fingerprint', 'duplicate_call'])(
  'semantic input rejects %s instead of silently dropping or remapping it', kind => {
    const calls = structuredClone(capturedCalls.slice(0, 2));
    if (kind === 'custom_answer') calls[1]!.answers = { [calls[1]!.questions[0]!.question]: 'Include something else' };
    if (kind === 'missing_tab_answer') calls[1]!.questions.push(structuredClone(calls[0]!.questions[0]!));
    if (kind === 'duplicate_label') calls[1]!.questions[0]!.options[1]!.label = calls[1]!.questions[0]!.options[0]!.label;
    if (kind === 'unanswered') calls[1]!.answered = false;
    if (kind === 'failed') calls[1]!.failed = true;
    if (kind === 'duplicate_call') calls[1] = structuredClone(calls[0]!);
    const fingerprints = calls.map(call => nativePlanCallFingerprint(call, 1, true));
    if (kind === 'foreign') fingerprints[1]!.signature = 'another:call';
    if (kind === 'omitted_call') fingerprints.pop();
    if (kind === 'extra_fingerprint') fingerprints.push(structuredClone(fingerprints[0]!));
    expect(() => ceoSplitDecisionFingerprints({status: 'ready', calls, assistantMessages: []}, fingerprints)).toThrow('Split decisions require');
  },
);

test.each(['Hold', 'D) Hold', 'D. Hold (recommended)'])('selected %s grants no candidate disposition', label => {
  const call = structuredClone(capturedCalls[0]!);
  call.questions[0]!.options[3]!.label = label;
  call.answers = { [call.questions[0]!.question]: label };
  expect(ceoSplitCandidate(call.questions[0]!)).toBe('E1');
  expect(isCeoSplitCandidateCall(nativePlanCallFingerprint(call, 1, true))).toBe(false);
});

test.each(['missing', 'foreign', 'answered', 'failed', 'unmatched_options', 'ambiguous_tab'])(
  'the split actor rejects %s native routing evidence', kind => {
    const call = { ...structuredClone(capturedCalls[1]!), answered: false, answers: undefined };
    const fp = nativePlanCallFingerprint(call, 1, true);
    if (kind === 'missing') fp.nativeCall = undefined;
    if (kind === 'foreign') fp.signature = 'another-session:another-call';
    if (kind === 'answered') call.answered = true;
    if (kind === 'failed') call.failed = true;
    if (kind === 'unmatched_options') fp.options[0]!.label = 'Unrelated option';
    if (kind === 'ambiguous_tab') call.questions.push(structuredClone(call.questions[0]!));
    expect(() => pickCeoSplitCountQuestion(fp, fp)).toThrow('complete matched native question');
  },
);

test.each(['quoted', 'summary', 'wrong_platform', 'bundled', 'missing_cut', 'duplicate_action', 'multi_select', 'no_ack', 'failed'])(
  'candidate credit rejects %s evidence', kind => {
    const call = structuredClone(capturedCalls[0]!);
    const question = call.questions[0]!;
    if (kind === 'quoted') question.question = 'Example: ' + question.question;
    if (kind === 'summary') question.question = 'D9 — Confirm E1 Slack was included?';
    if (kind === 'wrong_platform') question.header = 'E1 Discord';
    if (kind === 'bundled') question.question = question.question.replace('quarter?', 'quarter, and E2: Discord?');
    if (kind === 'missing_cut') question.options = question.options.filter(option => option.label !== 'Cut');
    if (kind === 'duplicate_action') question.options[3]!.label = 'Include';
    if (kind === 'multi_select') question.multiSelect = true;
    if (kind === 'no_ack') call.answered = false;
    if (kind === 'failed') call.failed = true;
    expect(isCeoSplitCandidateCall(nativePlanCallFingerprint(call, 1, true))).toBe(false);
  },
);
const question = (labels = ['A) Keep all six, lift the cap', 'B) Trim to cap: Slack + Teams (recommended)',
  'C) Revise one option', 'D) Hold — discuss first']): NativeQuestion => ({
  header: 'Final set', multiSelect: false,
  question: 'D4.final — The assembled set is six items at ~13 weeks, but the plan caps this quarter at 2-3 integrations. How do we resolve that?',
  options: labels.map(label => ({ label, description: 'Current assembled-scope choice.' })),
});

test('the observed cap conflict selects the offered trim rather than lifting the fixture cap', () => {
  expect(pickPlanReviewQuestion(question())).toBe(2);
  expect(pickCeoSplitQuestion(question())).toBe(2);
  const recommendsLiftingCap = question(['Keep all six, lift the cap (recommended)', 'Trim to cap: Slack + Teams']);
  expect(pickPlanReviewQuestion(recommendsLiftingCap)).toBe(1);
  expect(pickCeoSplitQuestion(recommendsLiftingCap)).toBe(2);
});

test.each([
  ['Trim to cap: Mattermost + Slack + Microsoft Teams', 'Keep all six, lift the cap'],
  ['Keep all six, lift the cap', 'Hold — discuss first', 'Trim to cap: Telegram + Discord'],
  ['Revise one option', 'Hold — discuss first', 'Keep all six, lift the cap', 'Trim to cap: Teams + Slack'],
].map(labels => [labels]))('an offered two-or-three-platform set can move within the menu: %j', labels => {
  expect(pickCeoSplitQuestion(question(labels))).toBe(labels.findIndex(label => label.startsWith('Trim to cap:')) + 1);
});

test.each([
  ['Keep all six, lift the cap', 'Revise one option'],
  ['Trim to cap: Slack + Teams', 'Trim to cap: Discord + Telegram'],
  ['Keep all six, lift the cap', '"Trim to cap: Slack + Teams"'],
  ['Keep all six, lift the cap', 'If budget expands, Trim to cap: Slack + Teams'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Teams if budget expands'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Teams + Discord + Telegram'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Webhook'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Slack'],
  ['Keep all six, lift the cap', 'Trim to cap: Teams + Microsoft Teams'],
  ['Keep all six, lift the cap', 'Trim to cap: Slack + Teams', 'Skip the review'],
].map(labels => [labels]))('ambiguous, conditional or unsupported cap choices fail without inventing an answer: %j', labels => {
  expect(() => pickCeoSplitQuestion(question(labels))).toThrow('no unique offered');
});

test('multi-select cap reconciliation is not silently treated as a single choice', () => {
  expect(() => pickCeoSplitQuestion({ ...question(), multiSelect: true })).toThrow('no unique offered');
});

test('individual candidate decisions and unrelated, quoted or conditional questions keep the ordinary policy', () => {
  for (const [id, name] of ['Slack', 'Discord', 'Teams', 'Telegram', 'Mattermost'].entries()) {
    const candidate = { ...question(['Include', 'Defer to next quarter', 'Cut entirely']),
      header: `E${id + 1} ${name}`, question: `D4.${id + 1} — E${id + 1}) ${name}: include, defer, or cut?` };
    expect(pickCeoSplitQuestion(candidate)).toBe(pickPlanReviewQuestion(candidate));
    expect(pickCeoSplitQuestion(candidate)).toBe(1);
  }
  for (const other of [
    { ...question(), header: 'Documentation' },
    { ...question(), question: 'Quoted example: "' + question().question + '"' },
    { ...question(), question: 'If we ever exceed capacity, ' + question().question },
    { ...question(), question: 'Should the README quote this menu?\n' + question().question },
  ]) expect(pickCeoSplitQuestion(other)).toBe(pickPlanReviewQuestion(other));
});

test('the existing manual review handoff remains available unchanged', () => {
  const handoff = { ...question(['Run /plan-eng-review', 'Skip — handle manually']),
    header: 'Next review', question: 'D20 — What is next?' };
  expect(pickCeoSplitQuestion(handoff)).toBe(2);
});

// Exact ordinary native D5.1 input from the retained V4 split timeout.
const extraChannel = (): NativeQuestion => ({
  "header": "Webhook",
  "multiSelect": false,
  "options": [
    {
      "description": "Ship the Slack-compatible webhook channel this quarter after E1.",
      "label": "A) Add to scope (recommended)"
    },
    {
      "description": "Record it for next quarter.",
      "label": "B) Defer to TODOS.md"
    },
    {
      "description": "Do not pursue.",
      "label": "C) Skip"
    }
  ],
  "question": "D5.1 — Expansion: add a generic Slack-compatible incoming-webhook channel?\nProject/branch/task: main branch; cherry-pick 1 of 4 on top of the confirmed E1 + E3 + E4 scope.\nELI10: Picture the Mattermost admin at a high-ARR account opening your integration settings and finding a 'Slack-compatible webhook URL' field. They paste the URL their Mattermost server gave them, hit save, and the next incident lands in their channel formatted exactly like the Slack version. Same for a Discord community lead using their webhook's /slack endpoint. No bot install, no app review, no new auth flow. It reuses E1's Slack message builder and the adapter's post-and-retry loop, so the work is a settings field, a URL validator, and a test. Effort: S (human ~2-3 days / CC ~1 hour). Risk: low; the main gotcha is that Slack-format compatibility covers text and attachments but not interactive buttons.\nStakes if we pick wrong: skipping it leaves the two deferred segments with nothing this quarter; adding it costs a few days at the end of a full quarter.\nRecommendation: Add — this is a taste call, no strong preference either way, but it is the cheapest way to give the deferred segments something real this quarter.\nNote: options differ in kind, not coverage — no completeness score.\nPros / cons:\nA) Add to this quarter's scope (recommended) (human: ~2-3 days / CC: ~1 hour)\n  ✅ Alert delivery reaches Mattermost and Discord this quarter for a fraction of a bot's cost\n  ✅ Doubles as a generic channel for any tool that speaks Slack payloads (Rocket.Chat, Zulip, custom)\n  ❌ Text-only delivery: no interactive buttons or slash commands on those platforms\n  ❌ Adds a fourth delivery surface to monitor at launch\nB) Defer to TODOS.md\n  ✅ Keeps the quarter at exactly three named integrations with a little more buffer\n  ✅ Still cheap next quarter since it depends only on E1's formatter\n  ❌ Deferred segments wait a full quarter for something that costs days\nC) Skip\n  ✅ Keeps the integrations page to first-class, branded platforms only\n  ✅ Avoids supporting arbitrary webhook endpoints you do not control\n  ❌ Gives up the eureka that made deferring E2 and E5 comfortable\nNet: a cheap generic channel for the deferred segments versus a tighter, branded-only launch."
});

test('the actual fourth-channel proposal defers while preserving the complete native input', () => {
  const native = extraChannel();
  const original = structuredClone(native);
  expect(pickPlanReviewQuestion(native)).toBe(1);
  expect(pickCeoSplitQuestion(native)).toBe(2);
  expect(native).toEqual(original);
});

test('the extra channel uses its unique offered deferral even when choices move', () => {
  const native = extraChannel();
  native.options = [native.options[1]!, native.options[2]!, native.options[0]!];
  expect(pickCeoSplitQuestion(native)).toBe(1);
});

test.each([
  ['Add to scope', 'Skip'],
  ['Add to scope', 'Defer to TODOS.md', 'Defer to TODOS.md'],
  ['Add to scope', 'If the cap stays, Defer to TODOS.md'],
  ['Add to scope', 'Defer to TODOS.md if convenient'],
  ['Add to scope', 'Defer to TODOS.md', 'Skip the review'],
].map(labels => [labels]))('a capped extra channel cannot invent a deferral: %j', labels => {
  const native = extraChannel();
  native.options = labels.map(label => ({ label, description: '' }));
  expect(() => pickCeoSplitQuestion(native)).toThrow('no unique offered deferral');
});

test('multi-select or repeated candidate IDs do not establish three confirmed integrations', () => {
  expect(() => pickCeoSplitQuestion({ ...extraChannel(), multiSelect: true })).toThrow('no unique offered deferral');
  const native = extraChannel();
  native.question = native.question.replace('E1 + E3 + E4', 'E1 + E3 + E1');
  expect(() => pickCeoSplitQuestion(native)).toThrow('no unique offered deferral');
});

test('the added-channel policy does not decline features, swaps, examples or a two-candidate set', () => {
  const native = extraChannel();
  for (const other of [
    { ...native, header: 'Test alert', question: native.question.replace(
      'add a generic Slack-compatible incoming-webhook channel?', "add a 'Send test alert' button on each integration's settings page?") },
    { ...native, header: 'Routing', question: native.question.replace(
      'add a generic Slack-compatible incoming-webhook channel?', 'route alerts by severity to different channels?') },
    { ...native, question: native.question.replace('Expansion: add', 'Expansion: replace Teams with') },
    { ...native, question: native.question.replace('E1 + E3 + E4', 'E1 + E3') },
    { ...native, question: 'Quoted example: ' + native.question },
    { ...native, question: 'If capacity later changes, ' + native.question },
    { ...native, question: native.question.replace('the confirmed', 'the proposed') },
  ]) expect(pickCeoSplitQuestion(other)).toBe(pickPlanReviewQuestion(other));
});

// Import the actual paid case with its provider boundary mocked. The caller
// supplies all five candidates; the native runner owns the workspace and count.
test.each([
  { outcome: 'plan_ready', count: 5, passes: true },
  { outcome: 'completion_summary', count: 5, passes: true },
  { outcome: 'ceiling_reached', count: 8, passes: true },
  { outcome: 'plan_ready', count: 3, passes: false },
  { outcome: 'timeout', count: 5, passes: false },
])('actual split registration preserves every candidate and its native outcome/count gates: %j', async scenario => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-cap-registration-')));
  const facts = path.join(temp, 'facts.json');
  const script = path.join(temp, 'registration.test.ts');
  fs.writeFileSync(script, `
import { describe, expect, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CEO_SCOPE_CANDIDATES } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-cases.ts'))};
import { FORCING_SPLIT_OVERFLOW_CEO } from ${JSON.stringify(path.join(ROOT, 'test/fixtures/forcing-finding-seeds.ts'))};
import retained from ${JSON.stringify(path.join(ROOT, 'test/fixtures/ceo-split-actor-6aef.json'))};
import { ceoSplitCandidate, isCeoSplitCandidateCall, pickCeoSplitCountQuestion } from ${JSON.stringify(path.join(ROOT, 'test/helpers/ceo-split-question-policy.ts'))};
import { validatePlanReviewDecisionResponse } from ${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))};
const validate = validatePlanReviewDecisionResponse;
const facts = { calls: 0, judges: 0, directory: '', candidates: [], validated: false };
const save = () => fs.writeFileSync(${JSON.stringify(facts)}, JSON.stringify(facts));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/plan-review-decisions.ts'))}, () => ({
  evaluatePlanReviewDecisions: async input => {
    facts.judges++; save();
    expect(input.kind).toBe('scope'); expect(input.floor).toBe(4);
    expect(input.targets).toEqual(CEO_SCOPE_CANDIDATES);
    expect(input.deadlineAt).toBeGreaterThan(Date.now());
    expect(input.deadlineAt - Date.now()).toBeLessThanOrEqual(1_500_000);
    return validate(input, { questions: input.fingerprints.map(fp => ({
      toolUseId: fp.toolUseId, questionIndex: 1, kind: 'scope',
      targetIds: [fp.questions[0].header.split(' ')[0]], independentDecisions: 1,
      evidence: [{field: 'question', optionIndex: null, quote: fp.questions[0].question.split('\\n')[0]}],
      reason: 'Controlled classification of the complete captured integration menu.',
      optionActions: fp.questions[0].options.map((option, i) => ({optionIndex: i + 1,
        action: ['include', 'defer', 'cut', 'hold'][i]})),
    })) });
  },
}));
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/e2e-gate.ts'))}, () => ({
  describeE2ETier: tier => { expect(tier).toBe('periodic'); return describe; },
}));
const boundary = () => false;
mock.module(${JSON.stringify(path.join(ROOT, 'test/helpers/claude-pty-runner.ts'))}, () => ({
  ceoStep0Boundary: boundary,
  runPlanSkillCounting: async opts => {
    facts.calls++; save();
    expect(opts.skillName).toBe('plan-ceo-review');
    expect(opts.slashCommand).toBe('/plan-ceo-review');
    expect(opts.cwd).toBeUndefined();
    expect(opts.reviewCountCeiling).toBe(8);
    expect(opts.isLastStep0AUQ).toBe(boundary);
    expect(opts.isReviewAUQ).toBe(isCeoSplitCandidateCall);
    expect(opts.pickAUQ).toBe(pickCeoSplitCountQuestion);
    expect(opts.observeSetupQuestions).toBe(true);
    const activeCall = { ...structuredClone(retained.calls[1]), answered: false, answers: undefined };
    const active = { signature: activeCall.sessionId + ':' + activeCall.toolUseId, preReview: true,
      nativeCall: activeCall, nativeQuestionIndex: 0, observedAtMs: 1, promptSnippet: activeCall.questions[0].question,
      options: activeCall.questions[0].options.map((option, i) => ({index: i + 1, label: option.label})) };
    expect(opts.pickAUQ(active, active)).toBe(2);
    expect(opts.timeoutMs).toBeGreaterThan(1_499_000);
    expect(opts.timeoutMs).toBeLessThanOrEqual(1_500_000);
    expect(opts.preconfiguredReviewActor).toBe(true);
    expect(opts.env).toEqual({ QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' });
    const directory = fs.readdirSync(${JSON.stringify(temp)}).find(name => name.startsWith('gstack-e2e-plan-ceo-split-overflow-'));
    expect(directory).toBeDefined();
    facts.directory = path.join(${JSON.stringify(temp)}, directory);
    const planPath = path.join(facts.directory, 'gstack-test-plan-ceo-split-overflow.md');
    expect(opts.followUpPrompt).toBe(FORCING_SPLIT_OVERFLOW_CEO.replaceAll('/tmp/gstack-test-plan-ceo-split-overflow.md', planPath));
    expect(opts.permissionPlanPath).toBe(planPath);
    expect(opts.expectedPlanPath).toBeUndefined();
    for (const target of CEO_SCOPE_CANDIDATES) {
      expect(opts.followUpPrompt).toContain('## ' + target.id + ')');
      facts.candidates.push(target.id);
    }
    facts.validated = true; save();
    return { outcome: ${JSON.stringify(scenario.outcome)}, reviewCount: ${scenario.count},
      transcript: {status: 'ready', calls: retained.calls.slice(0, Math.min(5, ${scenario.count})), assistantMessages: []},
      fingerprints: retained.calls.slice(0, Math.min(5, ${scenario.count})).map(call => ({
        signature: call.sessionId + ':' + call.toolUseId, nativeCall: call, preReview: false,
        promptSnippet: call.questions[0].question, options: call.questions[0].options.map((option, i) => ({index: i + 1, label: option.label})),
      })),
      step0Count: 0, elapsedMs: 1, evidence: 'controlled registration' };
  },
}));
await import(${JSON.stringify(path.join(ROOT, 'test/skill-e2e-plan-ceo-split-overflow.test.ts'))});
`);
  try {
    const child = Bun.spawn([process.execPath, 'test', script], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: temp, TMPDIR: temp, TEMP: temp, TMP: temp,
        GIT_CONFIG_NOSYSTEM: '1', EVALS_HERMETIC: '1',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    });
    const [exit, out, err] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const observed = JSON.parse(fs.readFileSync(facts, 'utf8'));
    expect(observed.calls, out + err).toBe(1); expect(observed.validated, out + err).toBe(true);
    expect(observed.candidates).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
    expect(fs.existsSync(observed.directory)).toBe(false);
    expect(exit, out + err).toBe(scenario.passes ? 0 : 1);
    expect(observed.judges).toBe(scenario.outcome === 'timeout' ? 0 : 1);
    if (scenario.outcome === 'timeout') expect(out + err).toContain('split-overflow test FAILED: outcome=timeout');
    if (scenario.count < 4) expect(out + err).toContain('target call count 3 below floor 4');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}, 20_000);


test.each(['original', 'blank rows', 'CRLF', 'clipped body'])(
  'captured split native viewport padding binds the exact call: %s', variant => {
    const call = structuredClone(padding.call);
    const screen = variant === 'blank rows' ? '\n \t\n' + padding.screen
      : variant === 'CRLF' ? padding.screen.replace(/\n/g, '\r\n')
      : variant === 'clipped body' ? '\n' + padding.screen.split('\n').slice(2).join('\n')
      : padding.screen;
    const before = structuredClone(call);
    const seen = new Set<string>();
    const active = capturePlanCountQuestion(screen, seen, padding.elapsedMs, true, call)!;
    expect(active?.nativeCall).toEqual(call);
    expect(active?.options).toEqual(call.questions[0]!.options.map((option, i) => ({ index: i + 1, label: option.label })));
    expect(pickCeoSplitCountQuestion(nativePlanCallFingerprint(call, 1, true), active)).toBe(2);
    expect(capturePlanCountQuestion(screen, seen, padding.elapsedMs + 1, true, call)).toBeNull();
    expect(call).toEqual(before);
    expect(padding.outcome).toBe('THREW');
  },
);

test.each(['foreign prefix', 'quoted pane', 'changed body', 'changed label', 'missing label',
  'missing footer', 'trailing question', 'preceding menu', 'choices only', 'wrong native body',
  'failed native', 'answered native', 'ambiguous packet'])(
  'captured split viewport padding cannot borrow native identity: %s', variant => {
    const call = structuredClone(padding.call);
    let screen = padding.screen;
    if (variant === 'foreign prefix') screen = '\nA different question with the same choices?\n' + screen;
    if (variant === 'quoted pane') screen = '\n```text\n' + screen + '\n```';
    if (variant === 'changed body') screen = screen.replace('Discord is asked for', 'Slack is asked for');
    if (variant === 'changed label') screen = screen.replace('2. Defer (recommended)', '2. Include everything');
    if (variant === 'missing label') screen = screen.replace('  4. Hold', '  Hold');
    if (variant === 'missing footer') screen = screen.replace('Enter to select', 'Enter to inspect');
    if (variant === 'trailing question') screen += '\nDo you want to create another.md?\n❯ 1. Yes\n2. No\nEsc to cancel · Tab to amend';
    if (variant === 'preceding menu') screen = '\n❯ 1. Old choice\n2. Other\n' + screen;
    if (variant === 'choices only') screen = '\n' + screen.slice(screen.indexOf('❯ 1.'));
    if (variant === 'wrong native body') call.questions[0]!.question += '\nAdditional approval required.';
    if (variant === 'failed native') call.failed = true;
    if (variant === 'answered native') call.answered = true;
    if (variant === 'ambiguous packet') call.questions.push(structuredClone(call.questions[0]!));
    const active = capturePlanCountQuestion(screen, new Set(), padding.elapsedMs, true, call);
    expect(active?.nativeCall).toBeUndefined();
    if (active) expect(() => pickCeoSplitCountQuestion(nativePlanCallFingerprint(call, 1, true), active))
      .toThrow('complete matched native question');
  },
);


test('captured split report permission advances only through distinct owned native epochs', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'split-report-permission-')));
  const cwd = path.join(dir, 'cwd'), config = path.join(dir, 'config');
  fs.mkdirSync(cwd); fs.mkdirSync(config);
  const expected = path.join(cwd, path.basename(splitEdit.event.input.file_path));
  const screen = splitEdit.screen.replaceAll(path.dirname(splitEdit.event.input.file_path), cwd);
  const sessionId = splitEdit.event.sessionId, currentId = splitEdit.event.toolUseId;
  const recorder = createFilePermissionRecorder(cwd, config, expected)!;
  const startedAt = Date.now() - 1000;
  const transcript = {status: 'ready' as const, calls: [], assistantMessages: [{sessionId, text: 'Reviewing the supplied plan.', timestamp: new Date().toISOString()}]};
  // Reconstruct only hook state in this isolated free fixture. The paid attempt
  // had no recorder; these epochs are never presented as historical grants.
  const record = (kind: string, id: string) => recordFilePermission(JSON.stringify({
    hook_event_name: kind, tool_name: 'Edit', session_id: sessionId, tool_use_id: id,
    cwd, transcript_path: path.join(config, 'projects', 'owned', sessionId + '.jsonl'),
    tool_input: {...splitEdit.event.input, file_path: expected},
  }), recorder.file, cwd, config, expected);
  const epoch = (pane = screen) => currentFilePermissionEpoch(recorder.file, expected, cwd, config, startedAt, transcript, pane);
  try {
    const withoutOwnership = createPlanCountPermissionGuard();
    expect(currentFilePermissionEpoch(undefined, expected, cwd, config, startedAt, transcript, screen)).toBeUndefined();
    expect(withoutOwnership(screen, '')).toBe('grant');
    expect(withoutOwnership(screen, '')).toBe('handled');
    record('PreToolUse', 'prior-edit');
    const guard = createPlanCountPermissionGuard();
    expect(guard(screen, '', epoch())).toBe('grant');
    expect(guard(screen, '', epoch())).toBe('handled');
    record('PostToolUse', 'prior-edit');
    record('PreToolUse', currentId);
    expect(epoch()?.pendingId).toBe(sessionId + ':' + currentId);
    expect(guard(screen, '', epoch())).toBe('grant');
    expect(guard(screen, '', epoch())).toBe('handled');
    expect(epoch(screen.replaceAll(cwd, path.join(dir, 'foreign')))).toBeNull();
    const state = JSON.parse(fs.readFileSync(recorder.file, 'utf8'));
    fs.writeFileSync(recorder.file, JSON.stringify({...state, sessionId: 'foreign'}));
    expect(epoch()).toBeNull();
  } finally { recorder.dispose(); fs.rmSync(dir, {recursive: true, force: true}); }
});

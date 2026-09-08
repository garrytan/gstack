import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanCountTranscript, unresolvedPlanQuestionCalls } from './helpers/plan-count-transcript';
import { nativePlanCallFingerprint, planCountQuestionPhase, engStep0Boundary, ceoStep0Boundary, ceoFirstReviewAUQ } from './helpers/claude-pty-runner';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-count-transcript-'));
  dirs.push(config);
  const cwd = path.join(config, 'fixture');
  const project = path.join(config, 'projects', 'fixture');
  fs.mkdirSync(project, { recursive: true });
  const sessionId = 'session-a';
  const file = path.join(project, `${sessionId}.jsonl`);
  const record = (role: string, content: object[], extra = {}) => ({
    cwd, sessionId, isSidechain: false, timestamp: '2026-09-08T15:31:13.607Z',
    message: { role, content }, ...extra,
  });
  const question = (text = 'D1 — Cross-project learnings scope <gstack-qid:learnings-cross-project>') => ({
    header: 'Learnings', question: text,
    options: [{ label: 'Enable cross-project learnings (Recommended)' }, { label: 'Keep project-scoped' }],
  });
  const ask = (id: string, questions = [question()], extra = {}) => record('assistant', [
    { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } },
  ], extra);
  const answer = (id: string, questions = [question()], extra = {}) => record('user', [
    { type: 'tool_result', tool_use_id: id, content: 'Your questions have been answered.' },
  ], { toolUseResult: { answers: Object.fromEntries(questions.map(q => [q.question, q.options[0].label])) }, ...extra });
  const append = (...records: object[]) => fs.appendFileSync(file, records.map(r => JSON.stringify(r) + '\n').join(''));
  const read = () => readPlanCountTranscript(config, cwd);
  return { config, cwd, project, file, question, ask, answer, append, read, record };
}

describe('native plan-count transcripts', () => {
  test('the actual partially answered CEO setup packet counts once without selecting its unanswered mode', () => {
    const f = fixture();
    // Native question/header/label metadata from targeted-a's paired CEO
    // call. The successful tool_result answered only routing and approach.
    const packet = [{"header":"Routing","question":"gstack works best when your project's CLAUDE.md includes skill routing rules — should I add them? <gstack-qid:routing-injection>","options":[{"label":"Add routing rules (Recommended)"},{"label":"Skip for now"}]},{"header":"Prerequisites","question":"No design doc found for this branch. Run /office-hours to capture structured problem context first, or proceed directly to the plan review? <gstack-qid:plan-ceo-review-office-hours>","options":[{"label":"Skip — review the plan directly (Recommended)"},{"label":"Run /office-hours first"}]},{"header":"Test Scope","question":"Which implementation approach should the tests follow? This shapes the review scope. <gstack-qid:plan-ceo-review-approach>\n\nD1 — Approach selection for processPayment() test coverage\nProject: Payment Processing — adding missing unit tests\nELI10: The plan calls for exactly 2 tests. Adding a few more for the most common real-world Stripe failures (card declined, rate limit) costs ~10 extra minutes with CC but closes the gaps users actually hit. The question is whether to stay at 2 or expand to ~5-6 tests.\nStakes if we pick wrong: Choosing minimal leaves 402 (card declined) untested — the most common production failure. Choosing full adds ~5 min of CC work.\nRecommendation: B (Core Stripe paths) because 402 card declined is the highest-volume real-world failure and CC compresses the extra work to near-zero.\nCompleteness: A=7/10, B=9/10","options":[{"label":"Minimal — 2 tests as planned (7/10)"},{"label":"Core paths — ~5 tests (9/10) (Recommended)"}]},{"header":"Review Mode","question":"D2 — Review mode for this plan?\nProject: Payment Processing test coverage — adding missing unit tests for processPayment()\nELI10: The plan adds 2 missing unit tests. HOLD SCOPE means: take the scope as given, review it with maximum rigor — catch every ambiguity, failure mode, edge case, observability gap. SELECTIVE EXPANSION means: do all that AND surface cherry-pick expansions (additional test scenarios, receipt schema validation, etc.) one at a time for your approval.\nStakes if we pick wrong: HOLD keeps the review tight and fast. SELECTIVE surfaces more opportunities but adds round-trips.\nRecommendation: HOLD SCOPE — this is a focused gap-fill, and rigor matters more than ambition here.\nNote: options differ in kind, not coverage — no completeness score. <gstack-qid:plan-ceo-review-mode>","options":[{"label":"HOLD SCOPE — maximum rigor (Recommended)"},{"label":"SELECTIVE EXPANSION — rigor + cherry-picks"}]}];
    f.append(f.ask('actual-packet', packet), f.answer('actual-packet', [packet[0], packet[2]]));
    const [call] = f.read().calls;
    expect(call.answered).toBe(true);
    expect(call.failed).toBe(false);
    expect(call.unansweredQuestionIndices).toEqual([1, 3]);
    expect(f.read().calls.filter(c => c.answered)).toHaveLength(1);
    const setup = nativePlanCallFingerprint(call, 0, true);
    expect(setup.options.some(o => /HOLD SCOPE/.test(o.label))).toBe(false);
    expect(ceoStep0Boundary(setup)).toBe(false);
    expect(ceoFirstReviewAUQ(setup)).toBe(false);

    const finding = [{"header":"Receipt Schema","question":"D3 — The plan says 'assert correct receipt is generated' but doesn't define what a correct receipt looks like. Without a schema, the test will pass even if the receipt is missing critical fields.\n\nELI10: Right now the test could assert `receipt != nil` and call it a day. That test passes even if the receipt has the wrong amount or no charge ID. We need to specify what fields a correct receipt must have.\n\nStakes if we pick wrong: Tests pass in CI but fail to catch a real receipt bug — e.g., wrong charge_id linked to wrong customer.\n\nRecommendation: A — specify the receipt schema in the plan now; costs ~5 min, prevents a class of silent bugs.\nCompleteness: A=9/10, B=7/10, C=3/10 <gstack-qid:plan-ceo-receipt-schema>","options":[{"label":"Specify schema in plan (Recommended)"},{"label":"Specify during implementation"},{"label":"Skip — too much detail for a plan"}]}];
    f.append(f.ask('receipt-schema', finding), f.answer('receipt-schema', finding));
    const review = nativePlanCallFingerprint(f.read().calls[1], 1, true);
    expect(planCountQuestionPhase(review, false, ceoStep0Boundary, ceoFirstReviewAUQ))
      .toEqual({ preReview: false, reviewStarted: true });

    // A refused/empty packet must not receive the same completion credit.
    f.append(f.ask('empty-packet', packet), f.answer('empty-packet', []));
    const empty = f.read().calls[2];
    expect(empty.answered).toBe(false);
    expect(empty.failure).toContain('no matching nonempty answers');
  });

  test('CEO first-finding fallback requires native finding identity and rejects setup decisions', () => {
    const f = fixture();
    for (const [id, text] of [
      ['setup', 'D1 — Missing context: choose a scope <gstack-qid:plan-ceo-review-scope>'],
      ['mode', 'D1 — Missing context: choose a mode <gstack-qid:plan-ceo-review-mode>'],
      ['unscoped', 'D1 — Missing receipt schema'],
      ['arbitrary', 'D1 — Pick an option <gstack-qid:plan-ceo-review-choice>'],
      ['next', 'D1 — Missing engineering review: what next? <gstack-qid:plan-ceo-next-steps>'],
    ]) {
      const questions = [f.question(text)];
      f.append(f.ask(id, questions), f.answer(id, questions));
    }
    for (const call of f.read().calls) expect(ceoFirstReviewAUQ(nativePlanCallFingerprint(call, 0, true))).toBe(false);
  });

  test('requires a matching successful answer and preserves full native question metadata', () => {
    const f = fixture();
    const questions = [f.question('D1 — Cross-project learnings scope\n' + 'full context '.repeat(40) + '<gstack-qid:learnings-cross-project>')];
    f.append(f.ask('one', questions));
    expect(f.read().calls[0].answered).toBe(false);
    f.append(f.answer('one', questions));
    const before = fs.readFileSync(f.file, 'utf8');
    const observed = f.read();
    expect(observed.status).toBe('ready');
    expect(observed.calls).toHaveLength(1);
    expect(observed.calls[0].answered).toBe(true);
    expect(observed.calls[0].questions).toEqual(questions);
    const fp = nativePlanCallFingerprint(observed.calls[0], 1, true);
    expect(fp.promptSnippet.length).toBeGreaterThan(240);
    expect(fp.promptSnippet).toContain('<gstack-qid:learnings-cross-project>');
    expect(planCountQuestionPhase(fp, false, engStep0Boundary)).toEqual({ preReview: true, reviewStarted: true });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  });

  test('one completed batched AskUserQuestion call remains one count even with unanswered questions', () => {
    const f = fixture();
    const questions = [f.question('D1 — Retry behavior?'), f.question('D2 — Error handling?')];
    f.append(f.ask('batch', questions), f.answer('batch', [questions[0]]));
    expect(f.read().calls.filter(c => c.answered)).toHaveLength(1);
    expect(f.read().calls[0].unansweredQuestionIndices).toEqual([1]);
    f.append(f.answer('batch', questions));
    expect(f.read().calls.filter(c => c.answered)).toHaveLength(1);
    expect(f.read().calls[0].questions).toHaveLength(2);
  });

  test('partial JSONL appends add no call or completion until the final newline', () => {
    const f = fixture();
    const call = JSON.stringify(f.ask('one'));
    fs.writeFileSync(f.file, call.slice(0, 80));
    expect(f.read()).toEqual({ status: 'missing', calls: [], assistantMessages: [] });
    fs.appendFileSync(f.file, call.slice(80));
    expect(f.read().calls).toEqual([]);
    fs.appendFileSync(f.file, '\n');
    expect(f.read().calls[0].answered).toBe(false);
    const result = JSON.stringify(f.answer('one'));
    fs.appendFileSync(f.file, result.slice(0, 80));
    expect(f.read().calls[0].answered).toBe(false);
    fs.appendFileSync(f.file, result.slice(80) + '\n');
    expect(f.read().calls[0].answered).toBe(true);
  });

  test('repeated records and polls dedupe by tool ID, while identical questions in distinct calls remain distinct', () => {
    const f = fixture();
    f.append(f.ask('one'), f.ask('one'), f.answer('one'), f.answer('one'), f.ask('two'), f.answer('two'));
    const first = f.read();
    expect(first.calls.filter(c => c.answered)).toHaveLength(2);
    expect(f.read()).toEqual(first);
    expect(first.calls.map(c => nativePlanCallFingerprint(c, 0, false).signature)).toEqual(['session-a:one', 'session-a:two']);
  });

  test('wrong cwd, sidechain, session, tool ID, and missing scope cannot provide an answer', () => {
    const f = fixture();
    f.append(f.ask('one'));
    for (const extra of [{ cwd: '/other' }, { isSidechain: true }, { sessionId: 'other' }, { cwd: undefined }, { isSidechain: undefined }]) {
      f.append(f.answer('one', undefined, extra), f.ask('foreign', undefined, extra));
    }
    f.append(f.answer('wrong-id'));
    expect(f.read().calls).toHaveLength(1);
    expect(f.read().calls[0].answered).toBe(false);
    fs.writeFileSync(path.join(f.project, 'other.jsonl'), JSON.stringify(f.answer('one', undefined, { sessionId: 'other' })) + '\n');
    expect(f.read().calls[0].answered).toBe(false);
  });

  test('native permissions, schema failures, errors and refusals do not become completed questions', () => {
    const f = fixture();
    f.append(f.record('assistant', [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'PLAN.md' } }]));
    f.append(f.answer('write'));
    f.append(f.record('assistant', [{ type: 'tool_use', id: 'bad', name: 'AskUserQuestion', input: { questions: [] } }]));
    f.append(f.answer('bad'));
    f.append(f.ask('error'));
    f.append(f.record('user', [{ type: 'tool_result', tool_use_id: 'error', is_error: true, content: 'Rejected' }],
      { toolUseResult: { answers: { [f.question().question]: 'Yes' } } }));
    f.append(f.ask('refusal'), f.answer('refusal', undefined, { toolUseResult: { answers: {} } }));
    expect(f.read().calls).toHaveLength(2);
    expect(f.read().calls.filter(c => c.answered)).toHaveLength(0);
    expect(f.read().calls.every(c => c.failed)).toBe(true);
  });

  test('unrelated answered questions cannot conceal a refusal, but an actual retry can resolve it', () => {
    const f = fixture();
    const missing = [f.question('Should retries preserve idempotency?')];
    const unrelated = [f.question('Should errors be logged?')];
    f.append(f.ask('refusal', missing), f.answer('refusal', [], { toolUseResult: { answers: {} } }));
    f.append(f.ask('unrelated', unrelated), f.answer('unrelated', unrelated));
    expect(unresolvedPlanQuestionCalls(f.read().calls).map(c => c.toolUseId)).toEqual(['refusal']);
    f.append(f.ask('retry', missing), f.answer('retry', missing));
    expect(unresolvedPlanQuestionCalls(f.read().calls)).toEqual([]);
    expect(f.read().calls.filter(c => c.answered)).toHaveLength(2);
  });

  test('missing transcripts and files from another fixture produce no positive coverage', () => {
    const f = fixture();
    expect(f.read()).toEqual({ status: 'missing', calls: [], assistantMessages: [] });
    f.append(f.ask('other', undefined, { cwd: '/different-fixture' }), f.answer('other', undefined, { cwd: '/different-fixture' }));
    expect(f.read()).toEqual({ status: 'missing', calls: [], assistantMessages: [] });
    expect(readPlanCountTranscript(path.join(f.config, 'absent'), f.cwd)).toEqual({ status: 'missing', calls: [], assistantMessages: [] });
  });

  test('invalid completed JSON and excessive bytes fail explicitly without retaining partial coverage', () => {
    const f = fixture();
    f.append(f.ask('one'), f.answer('one'));
    fs.appendFileSync(f.file, 'not JSON\n');
    expect(f.read().status).toBe('error');
    expect(f.read().calls).toEqual([]);
    fs.writeFileSync(f.file, '');
    fs.truncateSync(f.file, 32 * 1024 * 1024 + 1);
    expect(f.read().error).toContain('32 MiB');
    expect(f.read().calls).toEqual([]);
  });

  test('assistant posture evidence is scoped, timestamped text rather than tool results or partial records', () => {
    const f = fixture();
    f.append(f.record('assistant', [{ type: 'text', text: 'Earlier assistant posture.' }], { timestamp: '2026-09-08T15:31:10.000Z' }));
    f.append(f.ask('mode'), f.answer('mode'));
    f.append(f.record('assistant', [{ type: 'text', text: 'Later assistant posture.' }], { timestamp: '2026-09-08T15:31:20.000Z' }));
    for (const extra of [{ cwd: '/other' }, { isSidechain: true }, { sessionId: 'other' }, { timestamp: 'invalid' }, { timestamp: undefined }]) {
      f.append(f.record('assistant', [{ type: 'text', text: 'Not evidence.' }], extra));
    }
    f.append(f.record('user', [{ type: 'text', text: 'User prose is not assistant posture.' }]));
    f.append(f.record('user', [{ type: 'tool_result', tool_use_id: 'other', content: 'Tool result posture is not evidence.' }]));
    const observed = f.read();
    expect(observed.assistantMessages).toEqual([
      { sessionId: 'session-a', text: 'Earlier assistant posture.', timestamp: '2026-09-08T15:31:10.000Z' },
      { sessionId: 'session-a', text: 'Later assistant posture.', timestamp: '2026-09-08T15:31:20.000Z' },
    ]);
    expect(observed.calls[0].answeredAt).toBe('2026-09-08T15:31:13.607Z');
    fs.appendFileSync(f.file, JSON.stringify(f.record('assistant', [{ type: 'text', text: 'Still writing.' }])));
    expect(f.read().assistantMessages).toEqual(observed.assistantMessages);
    fs.appendFileSync(f.file, '\ninvalid JSON\n');
    expect(f.read().assistantMessages).toEqual([]);
    expect(f.read().calls).toEqual([]);
  });
});

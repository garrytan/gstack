import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPlanCountTranscript, unresolvedPlanQuestionCalls, readOwnedClaudePublicTranscript, nativePathSpelling,
  ownedNativePath, sameNativePath } from './helpers/plan-count-transcript';
import { nativePlanCallFingerprint, planCountQuestionPhase, engStep0Boundary } from './helpers/claude-pty-runner';

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

describe('native plan approval request evidence', () => {
  test('captures only a scoped complete ExitPlanMode request and retains error results', () => {
    const f = fixture();
    // Exact native tool shape from G Design's pending approval gate (its
    // zero-question workflow remains a separate failed count observation).
    const ready = f.record('assistant', [{ type: 'tool_use', id: 'plan-ready', name: 'ExitPlanMode', input: {}, caller: { type: 'direct' } }]);
    const line = JSON.stringify(ready);
    fs.writeFileSync(f.file, line);
    expect(f.read().planReadyRequests).toBeUndefined();
    fs.appendFileSync(f.file, '\n');
    expect(f.read().planReadyRequests).toEqual([{ sessionId: 'session-a', toolUseId: 'plan-ready', timestamp: ready.timestamp, failed: false }]);
    f.append(f.record('user', [{ type: 'tool_result', tool_use_id: 'plan-ready', is_error: true, content: 'Plan not accepted' }]));
    expect(f.read().planReadyRequests![0]!.failed).toBe(true);
    f.append(ready); // duplicate request cannot clear a recorded failure
    expect(f.read().planReadyRequests![0]!.failed).toBe(true);
  });
  test('foreign, sidechain, quoted, lookalike and untimestamped requests add no readiness', () => {
    const f = fixture();
    const block = { type: 'tool_use', id: 'ready', name: 'ExitPlanMode', input: {} };
    f.append(f.record('assistant', [block], { cwd: f.cwd + '-other' }),
      f.record('assistant', [block], { sessionId: 'foreign' }),
      f.record('assistant', [block], { isSidechain: true }),
      f.record('assistant', [block], { timestamp: 'invalid' }),
      f.record('assistant', [{ ...block, name: 'example_ExitPlanMode' }]),
      f.record('assistant', [{ type: 'text', text: JSON.stringify(block) }]));
    expect(f.read().planReadyRequests).toBeUndefined();
    fs.appendFileSync(f.file, 'bad JSON\n');
    expect(f.read().status).toBe('error');
    expect(f.read().planReadyRequests).toBeUndefined();
  });
});

describe('native journal roots: SessionStart preamble, resumed genesis and reason codes', () => {
  function rooted() {
    const config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-roots-')));
    dirs.push(config);
    const cwd = path.join(config, 'project');
    const project = path.join(config, 'projects', 'project');
    fs.mkdirSync(cwd); fs.mkdirSync(project, { recursive: true });
    const sessionId = 'session-roots';
    const file = path.join(project, `${sessionId}.jsonl`);
    let tick = 0;
    const node = (parentUuid: string | null, extra: object) => ({ uuid: randomUUID(), parentUuid, cwd, sessionId,
      isSidechain: false, version: '2.1.284', timestamp: new Date(Date.parse('2026-10-02T14:00:00Z') + tick++ * 1000).toISOString(), ...extra });
    const hook = (parentUuid: string | null, extra: object = {}) => node(parentUuid, { type: 'attachment',
      attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: 'SessionStart:startup' }, ...extra });
    const preamble = (count: number) => {
      const chain = [hook(null)];
      while (chain.length < count) chain.push(hook(chain.at(-1)!.uuid));
      return chain;
    };
    const user = (parentUuid: string | null, extra: object = {}) => node(parentUuid, { type: 'user',
      message: { role: 'user', content: 'Plan the retry change.' }, origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID(), ...extra });
    const say = (parentUuid: string, text: string, extra: object = {}) => node(parentUuid, { type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
    const write = (rows: object[], tail = '\n') => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + tail);
    const owned = () => readOwnedClaudePublicTranscript(file, cwd, sessionId);
    const plain = () => readPlanCountTranscript(config, cwd);
    const messages = () => owned().events.filter(e => e.kind === 'message').map(e => (e as { text: string }).text);
    return { config, cwd, project, file, sessionId, node, hook, preamble, user, say, write, owned, plain, messages };
  }

  test('a user root without a preamble stays owned', () => {
    const j = rooted(), prompt = j.user(null);
    j.write([prompt, j.say(prompt.uuid, 'Reviewed.')]);
    expect(j.owned().transcript.status).toBe('ready');
    expect(j.messages()).toEqual(['Reviewed.']);
  });

  for (const count of [1, 3])
    test(`${count} leading SessionStart attachment(s) root the first user turn for both readers`, () => {
      const j = rooted(), chain = j.preamble(count), prompt = j.user(chain.at(-1)!.uuid);
      j.write([...chain, prompt, j.say(prompt.uuid, 'Reviewed.')]);
      const read = j.owned();
      expect(read.transcript).toMatchObject({ status: 'ready' });
      expect(read.transcript.reason).toBeUndefined();
      expect(read.events.map(e => e.kind)).toEqual(['user_turn', 'message']);
      expect(j.plain().assistantMessages.map(m => m.text)).toEqual(['Reviewed.']);
    });

  test('a preamble flushed after its children still roots ownership; the plain reader follows a later cwd change', () => {
    const j = rooted(), chain = j.preamble(3), prompt = j.user(chain.at(-1)!.uuid);
    const other = path.join(j.config, 'elsewhere'); fs.mkdirSync(other);
    const first = j.say(prompt.uuid, 'Before cd.'), moved = j.say(first.uuid, 'After cd.', { cwd: other });
    j.write([prompt, first, moved, ...chain.toReversed()]);
    expect(j.messages()).toEqual(['Before cd.', 'After cd.']);
    // Origin seeding uses the causal root, not physical order, so the native
    // continuation across Bash cd keeps its ownership.
    expect(j.plain().assistantMessages.map(m => m.text)).toEqual(['Before cd.', 'After cd.']);
  });

  test('a resumed fork whose first record is a compact boundary with an absent logical parent is a root', () => {
    const j = rooted();
    const boundary = j.node(null, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: randomUUID(), content: 'Conversation compacted' });
    const summary = j.user(boundary.uuid, { isCompactSummary: true, origin: undefined, promptSource: undefined });
    const prompt = j.user(summary.uuid);
    j.write([{ type: 'ai-title', sessionId: j.sessionId }, boundary, summary, prompt, j.say(prompt.uuid, 'Resumed.')]);
    expect(j.owned().transcript.status).toBe('ready');
    expect(j.messages()).toEqual(['Resumed.']);
    // Mid-file, the same boundary may be an unflushed ancestor: no ownership, no hard code.
    const stray = j.hook(null);
    j.write([stray, boundary, summary, prompt, j.say(prompt.uuid, 'Resumed.')]);
    expect(j.owned().transcript).toMatchObject({ status: 'missing', calls: [] });
    expect(j.owned().transcript.reason).toBeUndefined();
    expect(j.owned().events).toEqual([]);
  });

  test('competing roots stay hard: a second user root, a second preamble carrying a turn, or a genesis beside a user root', () => {
    const j = rooted(), chain = j.preamble(2), prompt = j.user(chain.at(-1)!.uuid);
    const base = [...chain, prompt, j.say(prompt.uuid, 'Reviewed.')];
    j.write([...base, j.hook(null)]);
    expect(j.owned().transcript.status).toBe('ready');
    const second = j.hook(null);
    for (const extra of [[j.user(null)], [second, j.user(second.uuid)]]) {
      j.write([...base, ...extra]);
      expect(j.owned().transcript).toMatchObject({ status: 'error', reason: 'competing_root' });
      expect(j.owned().events).toEqual([]);
    }
    const boundary = j.node(null, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: randomUUID() });
    const resumed = j.user(boundary.uuid);
    j.write([boundary, resumed, j.user(null)]);
    expect(j.owned().transcript.reason).toBe('competing_root');
  });

  test('foreign cwd is hard only when the spelling and the real directory both differ', () => {
    const j = rooted(), chain = j.preamble(1), prompt = j.user(chain[0]!.uuid);
    const other = path.join(j.config, 'other-project'); fs.mkdirSync(other);
    j.write([{ ...chain[0]!, cwd: other }, prompt]);
    expect(j.owned().transcript.reason).toBe('foreign_cwd');
    j.write([{ ...chain[0]!, cwd: j.cwd + path.sep }, { ...prompt, cwd: j.cwd + path.sep }]);
    expect(j.owned().transcript.reason).toBe('unrecognized_shape:cwd_spelling');
  });

  test('sidechain, agent and cyclic ancestry are hard codes', () => {
    const j = rooted();
    const [head] = j.preamble(1), prompt = j.user(head!.uuid);
    j.write([{ ...head!, isSidechain: true }, prompt]);
    expect(j.owned().transcript.reason).toBe('sidechain');
    j.write([{ ...head!, agentId: 'agent-1' }, prompt]);
    expect(j.owned().transcript.reason).toBe('agent');
    j.write([{ ...head!, parentUuid: prompt.uuid }, prompt]);
    expect(j.owned().transcript).toMatchObject({ status: 'error', reason: 'cycle' });
  });

  test('unknown root shapes report a typed code and the record types, never content or ownership', () => {
    const j = rooted();
    const command = j.node(null, { type: 'system', subtype: 'local_command', content: '<command-name>/model</command-name>' });
    const setup = j.hook(null, { attachment: { type: 'hook_success', hookEvent: 'Setup' } });
    const assistantFirst = j.hook(null);
    for (const [rows, code] of [
      [[command, j.user(command.uuid)], 'unrecognized_shape:preamble:system:local_command'],
      [[setup, j.user(setup.uuid)], 'unrecognized_shape:preamble:attachment:hook_success'],
      [[assistantFirst, j.say(assistantFirst.uuid, 'No prompt yet.')], 'unrecognized_shape:first_turn:assistant'],
    ] as const) {
      const current = j.node(rows[1].uuid, { type: 'assistant', message: { role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_current', name: 'Read', input: { file_path: '/x' } }] } });
      j.write([...rows, current]);
      const read = j.owned();
      expect(read.transcript).toMatchObject({ status: 'missing', reason: code, calls: [], assistantMessages: [] });
      expect(read.events).toEqual([]);
      expect(read.diagnostic).toMatchObject({ claudeVersion: '2.1.284', toolUseIds: ['toolu_current'], complete: true });
      expect(read.diagnostic!.rootShape[0]).toBe(code === 'unrecognized_shape:preamble:system:local_command' ? 'system:local_command' : 'attachment:hook_success');
      expect(JSON.stringify(read.diagnostic)).not.toContain('Plan the retry change');
      expect(JSON.stringify(read.diagnostic)).not.toContain('/model');
    }
  });

  test('malformed, partial and changing journals are retry codes, never shape advisories', () => {
    const j = rooted(), prompt = j.user(null);
    j.write([prompt]);
    fs.appendFileSync(j.file, 'not JSON\n');
    expect(j.owned().transcript.reason).toBe('malformed');
    j.write([prompt, j.say(prompt.uuid, 'Reviewed.')], '\n{"partial":');
    expect(j.owned().transcript.status).toBe('ready');
    expect(j.owned().diagnostic).toBeUndefined();
    expect(readOwnedClaudePublicTranscript(path.join(j.project, 'absent.jsonl'), j.cwd, 'absent').transcript.reason).toBeUndefined();
  });

  test('win32 spellings fold before validation; dot segments stay rejected', () => {
    const w = path.win32;
    expect(nativePathSpelling('C:/Users/a/proj', w)).toBe('C:\\Users\\a\\proj');
    expect(nativePathSpelling('c:\\Users\\a', w)).toBe('C:\\Users\\a');
    expect(nativePathSpelling('/c/Users/a', w)).toBe('C:\\Users\\a');
    expect(nativePathSpelling('\\\\server\\share\\x', w)).toBe('\\\\server\\share\\x');
    expect(nativePathSpelling('/c/Users/a', path.posix)).toBe('/c/Users/a');
    for (const good of ['C:/Users/a/proj', '/c/Users/a', 'c:\\x', '\\\\server\\share\\x']) expect(ownedNativePath(good, w)).toBe(true);
    expect(nativePathSpelling('/cc/x', w)).toBe('\\cc\\x');
    for (const bad of ['C:/Users/a/../b', 'C:\\Users\\.\\a', '/c', 'relative\\x', 'C:\\a\\\\b', 42])
      expect(ownedNativePath(bad, w)).toBe(false);
    expect(ownedNativePath('/c/Users/a', path.posix)).toBe(true);
    expect(sameNativePath('C:/x/y', 'c:\\x\\y', w)).toBe(true);
    expect(sameNativePath('/c/x', 'C:\\x', w)).toBe(true);
    expect(sameNativePath('C:\\x\\..\\y', 'C:\\y', w)).toBe(false);
    expect(sameNativePath('C:/x', 'C:\\x', path.posix)).toBe(false);
  });

  describe('real Claude Code 2.1.284 journals (redacted)', () => {
    const real = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'claude-native-journal-roots-2.1.284.json'), 'utf8')) as {
      claudeCodeVersion: string; journals: Record<string, { sessionId: string; lines: string[] }>;
    };
    const load = (name: string) => {
      const j = rooted(), journal = real.journals[name]!;
      const file = path.join(j.project, `${journal.sessionId}.jsonl`);
      fs.writeFileSync(file, journal.lines.map(line => line.replaceAll('__CWD__', JSON.stringify(j.cwd).slice(1, -1))).join('\n') + '\n');
      const records = journal.lines.map(line => JSON.parse(line));
      return { j, file, records, read: readOwnedClaudePublicTranscript(file, j.cwd, journal.sessionId) };
    };
    test('the fixture is structure only and names its Claude Code version', () => {
      expect(real.claudeCodeVersion).toBe('2.1.284');
      expect(Object.keys(real.journals).sort()).toEqual(['clear', 'compact', 'forkAfterCompact', 'startup']);
      for (const journal of Object.values(real.journals)) for (const line of journal.lines) {
        const record = JSON.parse(line);
        if (typeof record.message?.content === 'string') expect(record.message.content).toBe('[redacted]');
        if (record.version) expect(record.version).toBe('2.1.284');
      }
    });
    for (const [name, head] of [['startup', 'attachment'], ['clear', 'attachment'], ['compact', 'attachment'], ['forkAfterCompact', 'system']] as const)
      test(`${name}: the owned reader accepts the real root shape`, () => {
        const { j, records, read } = load(name);
        const first = records.find(r => r.uuid)!;
        expect(first.type).toBe(head);
        expect(first.parentUuid).toBeNull();
        if (head === 'attachment') expect(first.attachment).toMatchObject({ hookEvent: 'SessionStart' });
        else expect(records.some(r => r.uuid === first.logicalParentUuid)).toBe(false);
        expect(read.transcript.status).toBe('ready');
        expect(read.events.filter(e => e.kind === 'message').length).toBeGreaterThan(0);
        expect(j.plain().assistantMessages.length).toBeGreaterThan(0);
      });
  });
});

describe('skill text Claude Code loaded', () => {
  test('keeps only scoped, timestamped skill expansions with their load-time output', () => {
    const f = fixture();
    const text = 'Base directory for this skill: /fixture/.claude/skills/plan-ceo-review\n\n## Preamble (run first)\n\nSKILL_START_PROTO: 1\n';
    const other = (name: string) => text.replace('plan-ceo-review', name);
    f.append(
      f.record('user', [{ type: 'text', text: '<command-message>plan-ceo-review</command-message>' }]),
      f.record('user', [{ type: 'text', text }], { isMeta: true }),
      f.record('user', [{ type: 'text', text: other('typed-by-user') }]),
      f.record('user', [{ type: 'text', text: other('sidechain') }], { isMeta: true, isSidechain: true }),
      f.record('user', [{ type: 'text', text: other('untimed') }], { isMeta: true, timestamp: 'later' }),
      f.record('user', [{ type: 'text', text: other('foreign') }], { isMeta: true, cwd: '/elsewhere' }),
      f.record('user', [{ type: 'text', text: `Quoted: ${text}` }], { isMeta: true }),
      f.record('assistant', [{ type: 'text', text: other('assistant') }], { isMeta: true }),
    );
    expect(f.read().skillLoads).toEqual([{ sessionId: 'session-a', skill: 'plan-ceo-review', text, timestamp: '2026-09-08T15:31:13.607Z' }]);
  });

  test('a transcript with no skill expansion reports none', () => {
    const f = fixture();
    f.append(f.ask('one'));
    expect(f.read().skillLoads).toBeUndefined();
  });
});

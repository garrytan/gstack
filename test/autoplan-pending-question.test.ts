import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPendingQuestionRecorder, readPendingQuestion, recordPendingQuestion } from './helpers/plan-count-pending-question';
import { readPlanCountTranscript } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import captured from './fixtures/autoplan-routing-manual-skills-ac.json';

// Exact retained public question; hook envelopes and owned temp paths are
// synthetic controls. AC retry 2's unpublished native payload is unknown.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-auq-' quote $()-"));
  const cwd = path.join(root, 'repo with spaces');
  const config = path.join(root, 'config');
  const project = path.join(config, 'projects', 'fixture');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const session = captured.call.sessionId;
  const transcriptPath = path.join(project, `${session}.jsonl`);
  const startedAt = Date.now();
  fs.writeFileSync(transcriptPath, JSON.stringify({ cwd, sessionId: session, isSidechain: false,
    timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Review setup.' }] },
  }) + '\n');
  const recorder = createPendingQuestionRecorder(cwd, config);
  const event = (kind = 'PreToolUse', id = captured.call.toolUseId) => ({ hook_event_name: kind,
    tool_name: 'AskUserQuestion', session_id: session, tool_use_id: id, cwd,
    transcript_path: transcriptPath, tool_input: { questions: structuredClone(captured.call.questions) },
  });
  const write = (value: unknown) => recordPendingQuestion(typeof value === 'string' ? value : JSON.stringify(value), recorder.file, cwd, config);
  const transcript = () => readPlanCountTranscript(config, cwd);
  const read = (native = transcript(), after = startedAt) => readPendingQuestion(recorder.file, cwd, config, after, native);
  const dispose = () => { recorder.dispose(); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, cwd, config, recorder, startedAt, session, transcriptPath, event, write, read, transcript, dispose };
}

describe('opt-in pending native AskUserQuestion capture', () => {
  test('a scoped request supplies pending identity, never an answer or coverage', () => {
    const f = fixture();
    try {
      expect(f.read()).toBeUndefined();
      f.write(f.event());
      expect(f.read()).toMatchObject({ sessionId: f.session, toolUseId: captured.call.toolUseId,
        source: 'pre_tool_use', answered: false, questions: captured.call.questions });
      expect(f.read()?.answers).toBeUndefined();
      expect(f.read()?.answeredAt).toBeUndefined();
    } finally { f.dispose(); }
  });

  test.each(['PostToolUse', 'PostToolUseFailure'])('%s closes a request and a replay cannot reopen it', kind => {
    const f = fixture();
    try {
      f.write(f.event());
      expect(f.read()).toBeDefined();
      f.write(f.event(kind));
      expect(f.read()).toBeUndefined();
      f.write(f.event());
      expect(f.read()).toBeUndefined();
      f.write(f.event('PreToolUse', 'toolu_new_owned_question'));
      expect(f.read()?.toolUseId).toBe('toolu_new_owned_question');
    } finally { f.dispose(); }
  });

  test('a duplicate pending request does not refresh its evidence timestamp', async () => {
    const f = fixture();
    try {
      f.write(f.event());
      expect(f.read()).toBeDefined();
      const before = fs.readFileSync(f.recorder.file, 'utf8');
      await Bun.sleep(5);
      f.write(f.event());
      expect(fs.readFileSync(f.recorder.file, 'utf8')).toBe(before);
    } finally { f.dispose(); }
  });

  test('a completion observed before its request cannot reopen', () => {
    const f = fixture();
    try {
      f.write(f.event('PostToolUse'));
      f.write(f.event());
      expect(f.read()).toBeUndefined();
    } finally { f.dispose(); }
  });

  test('concurrent calls and conflicting same-call payloads poison the ambiguous pending capture', () => {
    for (const sameId of [false, true]) {
      const f = fixture();
      try {
        f.write(f.event());
        const next = f.event('PreToolUse', sameId ? captured.call.toolUseId : 'toolu_other_pending');
        if (sameId) next.tool_input.questions[0]!.question += ' Changed.';
        f.write(next);
        expect(f.read()).toBeUndefined();
        f.write(f.event('PostToolUse'));
        f.write(f.event('PreToolUse', 'toolu_later'));
        expect(f.read()).toBeUndefined();
      } finally { f.dispose(); }
    }
  });

  test.each(['cwd', 'session', 'subagent'])('foreign %s cannot replace or clear the owned request', field => {
    const f = fixture();
    try {
      f.write(f.event());
      const prior = f.read();
      for (const kind of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
        const event: Record<string, unknown> = f.event(kind);
        if (field === 'cwd') event.cwd = path.join(f.root, 'foreign');
        if (field === 'session') {
          event.session_id = '3f7e6255-331b-4c3f-b5b6-cc9481be0548';
          event.transcript_path = path.join(path.dirname(f.transcriptPath), `${event.session_id}.jsonl`);
          fs.writeFileSync(event.transcript_path as string, '');
        }
        if (field === 'subagent') event.agent_id = 'foreign-subagent';
        f.write(event);
        expect(f.read()).toEqual(prior);
      }
    } finally { f.dispose(); }
  });

  test.each(['empty questions', 'too many questions', 'too few options', 'too many options', 'invalid option',
    'oversize', 'outside transcript path', 'wrong tool name', 'missing cwd'])('malformed scoped %s fails closed', kind => {
    const f = fixture();
    try {
      f.write(f.event());
      const event = f.event();
      const question = event.tool_input.questions[0]!;
      if (kind === 'empty questions') event.tool_input.questions = [];
      if (kind === 'too many questions') event.tool_input.questions = Array.from({ length: 5 }, () => structuredClone(question));
      if (kind === 'too few options') question.options.splice(1);
      if (kind === 'too many options') question.options = Array.from({ length: 5 }, (_, i) => ({ label: `Option ${i}`, description: '' }));
      if (kind === 'invalid option') question.options[0]!.label = '';
      if (kind === 'oversize') question.question = 'x'.repeat(128 * 1024);
      if (kind === 'outside transcript path') event.transcript_path = path.join(f.root, `${f.session}.jsonl`);
      if (kind === 'wrong tool name') event.tool_name = 'Write';
      if (kind === 'missing cwd') delete (event as Partial<typeof event>).cwd;
      f.write(event);
      expect(f.read()).toBeUndefined();
      f.write(f.event());
      expect(f.read()).toBeUndefined();
    } finally { f.dispose(); }
  });

  test('a late result for another call cannot clear the current pending request', () => {
    const f = fixture();
    try {
      f.write(f.event());
      const current = f.read();
      f.write(f.event('PostToolUse', 'toolu_earlier_call'));
      expect(f.read()).toEqual(current);
      f.write(f.event('PreToolUse', 'toolu_earlier_call'));
      expect(f.read()).toEqual(current);
    } finally { f.dispose(); }
  });

  test('read requires the same ready native session, isolated directory and current epoch', () => {
    const f = fixture();
    try {
      f.write(f.event());
      const native = f.transcript();
      expect(f.read(native)).toBeDefined();
      expect(f.read(native, Date.now() + 1_000)).toBeUndefined();
      for (const status of ['missing', 'error'] as const) {
        expect(f.read({ ...native, status })).toBeUndefined();
      }
      const foreign = structuredClone(native);
      foreign.assistantMessages[0]!.sessionId = '3f7e6255-331b-4c3f-b5b6-cc9481be0548';
      expect(f.read(foreign)).toBeUndefined();
      const mixed = structuredClone(native);
      mixed.assistantMessages.push({ ...foreign.assistantMessages[0]! });
      expect(f.read(mixed)).toBeUndefined();
      expect(readPendingQuestion(undefined, f.cwd, f.config, f.startedAt, native)).toBeUndefined();
      expect(readPendingQuestion(f.recorder.file, f.cwd, null, f.startedAt, native)).toBeUndefined();
      expect(readPendingQuestion(f.recorder.file, path.join(f.root, 'other'), f.config, f.startedAt, native)).toBeUndefined();
    } finally { f.dispose(); }
  });

  test('published native identity takes precedence even while unanswered or failed', () => {
    const f = fixture();
    try {
      f.write(f.event());
      for (const state of [{ answered: false }, { answered: true }, { answered: false, failed: true }]) {
        const native = f.transcript();
        native.calls.push({ ...structuredClone(captured.call), sessionId: f.session, ...state });
        expect(f.read(native)).toBeUndefined();
      }
    } finally { f.dispose(); }
  });

  test('generated shell hooks are exact, bounded, correctly quoted and silent on valid or broken input', () => {
    const f = fixture();
    try {
      expect(Object.keys(f.recorder.hooks).sort()).toEqual(['PostToolUse', 'PostToolUseFailure', 'PreToolUse']);
      for (const kind of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const) {
        const matchers = f.recorder.hooks[kind];
        expect(matchers).toHaveLength(1);
        expect(matchers[0]!.matcher).toBe('^AskUserQuestion$');
        expect(matchers[0]!.hooks).toHaveLength(1);
        const hook = matchers[0]!.hooks[0]!;
        expect(hook.timeout).toBe(5);
        for (const input of [JSON.stringify(f.event(kind)), '{invalid json']) {
          const result = spawnSync('bash', ['-c', hook.command], { cwd: f.cwd, input, encoding: 'utf8', timeout: 6_000 });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(0);
          expect(result.stdout).toBe('');
        }
      }
    } finally { f.dispose(); }
  });

  test('the helper and new free test select only the two opted-in workflows', () => {
    for (const file of ['test/helpers/plan-count-pending-question.ts', 'test/autoplan-pending-question.test.ts']) {
      expect(selectTests([file], E2E_TOUCHFILES, []).selected.sort()).toEqual(['autoplan-chain-pty', 'plan-ceo-mode-routing']);
    }
  });

  test('a hook whose input never ends closes within its own bound and remains silent', async () => {
    const f = fixture();
    const hook = f.recorder.hooks.PreToolUse[0]!.hooks[0]!;
    const child = Bun.spawn(['bash', '-c', ['exec', hook.command].join(' ')], { cwd: f.cwd,
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    // Use an actual shell command argument; no fixture string is interpolated.
    let forced = false;
    const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 6_000);
    try {
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(forced).toBe(false);
      expect(code).toBe(0);
      expect(stdout).toBe('');
      expect(f.read()).toBeUndefined();
      expect(fs.existsSync(f.recorder.file + '.invalid')).toBe(true);
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGKILL');
      await child.exited;
      f.dispose();
    }
  }, 7_000);
});

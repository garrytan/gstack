import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runPublicationHook } from '../autoplan/bin/phase-publication-hook.ts';

const ROOT = path.join(import.meta.dir, '..');
// Every guarded decision appends to the guard log; keep it out of the real state root.
process.env.GSTACK_HOME = fs.mkdtempSync(path.join(tmpdir(), 'autoplan-guard-log-'));
const SHIM = path.join(ROOT, 'autoplan/bin/phase-publication-hook');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const input = { hook_event_name: 'PreToolUse', session_id: 'parent', cwd: ROOT,
  transcript_path: path.join(ROOT, 'missing-config/projects/project/parent.jsonl'), tool_name: 'Read',
  tool_use_id: 'current', tool_input: { file_path: path.join(ROOT, 'autoplan/sections/design-phase.md') } };
function run(bytes: string, shim = SHIM, env = process.env) {
  const child = spawnSync('bash', [shim], { input: bytes, encoding: 'utf8', timeout: 8_000,
    env: { ...env, PATH: `${path.dirname(process.execPath)}:${env.PATH ?? ''}` } });
  expect(child.signal).toBeNull(); expect(child.stdout.trim().split('\n')).toHaveLength(1);
  return { child, output: JSON.parse(child.stdout) };
}

describe('Autoplan hook transport', () => {
  test('ordinary project and non-Read tools abstain without a parent journal', () => {
    expect(run(JSON.stringify({ ...input, tool_name: 'Bash' })).output).toEqual({});
    expect(run(JSON.stringify({ ...input, tool_input: { file_path: path.join(ROOT, 'autoplan/sections/phase-close.md') } })).output).toEqual({});
  });
  test('invalid input fails closed with one nested native denial', () => {
    const { child, output } = run('{'); expect(child.status).toBe(0);
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  });
  test('missing current journal is evidence unavailable, not a claim that publication is missing', () => {
    const { child, output } = run(JSON.stringify(input)); expect(child.status).toBe(0);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('no missing-publication conclusion');
  });
  test('missing TypeScript helper cannot silently allow a phase Read', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'autoplan-hook-missing-')); dirs.push(dir);
    const shim = path.join(dir, 'phase-publication-hook'); fs.copyFileSync(SHIM, shim);
    const { output } = run(JSON.stringify(input), shim);
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('hook unavailable');
  });
  test('unknown child input does not publish or answer anything', () => {
    const { output } = run(JSON.stringify({ ...input, agent_id: 'reviewer-child' })); expect(output).toEqual({});
  });
});

describe('Autoplan hook journal-root verdicts', () => {
  const entry = path.join(ROOT, 'autoplan/sections/design-phase.md');
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/claude-native-journal-roots-2.1.284.json'), 'utf8'));
  /** One owned native journal; the current phase-entry Read is its last record unless `current` is false. */
  function session(shape: 'unknown' | 'competing_root' | 'foreign_cwd' | 'sidechain' | 'agent' | 'cycle' | 'startup',
    { current = true, partial = false } = {}) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'autoplan-hook-roots-'))); dirs.push(base);
    const cwd = path.join(base, 'project'), project = path.join(base, 'config', 'projects', 'project');
    fs.mkdirSync(cwd); fs.mkdirSync(project, { recursive: true });
    const home = path.join(base, 'gstack-home');
    const sessionId = 'parent-session', file = path.join(project, `${sessionId}.jsonl`);
    const node = (parentUuid: string | null, extra: object) => ({ uuid: randomUUID(), parentUuid, cwd, sessionId,
      isSidechain: false, version: '2.1.284', timestamp: '2026-10-02T14:00:00.000Z', ...extra });
    const hook = (parentUuid: string | null) => node(parentUuid, { type: 'attachment',
      attachment: { type: 'hook_success', hookEvent: 'SessionStart', hookName: 'SessionStart:startup' } });
    const prompt = (parentUuid: string | null) => node(parentUuid, { type: 'user',
      message: { role: 'user', content: 'Secret plan text.' }, origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID() });
    let rows: object[];
    if (shape === 'startup') {
      rows = real.journals.startup.lines.map((line: string) => JSON.parse(line.replaceAll('__CWD__', JSON.stringify(cwd).slice(1, -1))));
      for (const row of rows as any[]) if (row.sessionId) row.sessionId = sessionId;
    } else {
      const head = shape === 'unknown' ? node(null, { type: 'system', subtype: 'local_command' }) : hook(null);
      const turn = prompt(head.uuid);
      rows = [head, turn];
      if (shape === 'competing_root') rows.push(prompt(null));
      if (shape === 'foreign_cwd') Object.assign(head, { cwd: path.join(base, 'config') });
      if (shape === 'sidechain') Object.assign(head, { isSidechain: true });
      if (shape === 'agent') Object.assign(head, { agentId: 'agent-1' });
      if (shape === 'cycle') Object.assign(head, { parentUuid: turn.uuid });
    }
    const last = [...rows].reverse().find((r: any) => r.uuid) as { uuid: string };
    if (current) rows.push(node(last.uuid, { type: 'assistant', message: { role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_current', name: 'Read', input: { file_path: entry } }] } }));
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n' + (partial ? '{"type":"assistant"' : ''));
    const value = { hook_event_name: 'PreToolUse', session_id: sessionId, cwd, transcript_path: file,
      tool_name: 'Read', tool_use_id: 'toolu_current', tool_input: { file_path: entry } };
    const env = { CLAUDE_PROJECT_DIR: cwd, GSTACK_HOME: home, GSTACK_STATE_ROOT: home };
    const log = path.join(home, 'analytics', 'autoplan-guard.jsonl');
    async function hookRun(overrides: Record<string, string> = {}): Promise<any> {
      const previous = Object.fromEntries(Object.keys({ ...env, ...overrides }).map(k => [k, process.env[k]]));
      Object.assign(process.env, env, overrides);
      try { return await runPublicationHook(value, ROOT); }
      finally { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    return { cwd, file, home, log, value, env, hookRun };
  }

  test('an unrecognized root shape degrades to an advisory: no permission decision, user and model notices, a content-free log', async () => {
    const s = session('unknown');
    const output = await s.hookRun();
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.systemMessage).toContain('phase publication was NOT verified for this session (journal shape unrecognized_shape:preamble:system:local_command)');
    expect(output.systemMessage).toContain('Claude Code 2.1.284');
    expect(output.systemMessage).toContain('docs/autoplan-guard-troubleshooting.md');
    expect(output.hookSpecificOutput.additionalContext).toContain('NOT verified');
    const records = fs.readFileSync(s.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ schema: 1, decision: 'allow', disposition: 'unverified', code: 'unrecognized_shape:preamble:system:local_command',
      path: 'none', claude_code_version: '2.1.284', record_types: ['system:local_command', 'user'] });
    expect(fs.readFileSync(s.log, 'utf8')).not.toContain('Secret plan text');
  });

  test('a logging failure never changes the advisory verdict', async () => {
    const s = session('unknown');
    fs.writeFileSync(s.home, 'not a directory');
    const output = await s.hookRun();
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.systemMessage).toContain('NOT verified');
  });

  test('UC1: an unrecognized shape is unverified even before Claude Code journals the current call', async () => {
    const s = session('unknown', { current: false });
    const output = await s.hookRun();
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.systemMessage).toContain('code unrecognized_shape:preamble:system:local_command');
  });
  test('CEO-2: a record still being written is ignored, so the complete unrecognized shape is the advisory', async () => {
    const s = session('unknown', { partial: true });
    const output = await s.hookRun();
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.systemMessage).toContain('code unrecognized_shape:preamble:system:local_command');
    expect(output.systemMessage).not.toContain('Wait for the current response to finish');
  });

  for (const code of ['competing_root', 'foreign_cwd', 'sidechain', 'agent', 'cycle'] as const)
    test(`${code} is a hard denial naming the code, version, fallback and guide`, async () => {
      const s = session(code);
      const output = await s.hookRun();
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
      const reason: string = output.hookSpecificOutput.permissionDecisionReason;
      expect(reason).toContain(`code ${code}`);
      expect(reason).toContain('Claude Code 2.1.284');
      expect(reason).toContain('/plan-ceo-review, then /plan-devex-review, then /plan-eng-review');
      expect(reason).toContain('docs/autoplan-guard-troubleshooting.md');
      expect(reason).not.toContain('no missing-publication conclusion');
      const records = fs.readFileSync(s.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(records).toEqual([expect.objectContaining({ decision: 'deny', disposition: 'fallback', code, path: 'none' })]);
    });

  test('a real 2.1.284 SessionStart journal is owned and reaches publication evaluation', async () => {
    const s = session('startup');
    const output = await s.hookRun();
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    // Ownership succeeded: the denial is the evaluator's own invocation check.
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Autoplan invocation evidence is unavailable');
  });

  test('the shipped shim degrades and denies with real native spellings', () => {
    // On Windows the hook env and transcript arrive spelled C:/...; the fold must accept them.
    const forward = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
    const advisory = session('unknown');
    const soft = run(JSON.stringify({ ...advisory.value, transcript_path: forward(advisory.file) }), SHIM,
      { ...process.env, ...advisory.env, CLAUDE_PROJECT_DIR: forward(advisory.cwd) }).output;
    expect(soft.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(soft.systemMessage).toContain('NOT verified');
    const hard = session('competing_root');
    const denied = run(JSON.stringify(hard.value), SHIM, { ...process.env, ...hard.env }).output;
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('code competing_root');
  });

  test('the guide documents every guard code', () => {
    const guide = fs.readFileSync(path.join(ROOT, 'docs/autoplan-guard-troubleshooting.md'), 'utf8');
    for (const code of ['competing_root', 'foreign_cwd', 'sidechain', 'agent', 'cycle', 'changing', 'identity', 'malformed',
      'unrecognized_shape']) expect(guide).toContain(`\`${code}`);
    for (const detail of ['unrecognized_shape:cwd_spelling', 'analytics/autoplan-guard.jsonl']) expect(guide).toContain(detail);
  });
});

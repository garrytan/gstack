import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setupQuestionEventSource, readQuestionEvents, readPermissionRequestEvents, readFileCompletionEvents } from './helpers/plan-skill-question-events';

const sessionId = '00000000-0000-4000-8000-000000000001';
const otherSession = '00000000-0000-4000-8000-000000000002';
const input = { questions: [{ question: 'D1 — 哪個方案？\nKeep the exact UTF-8 content.', header: 'Approach', multiSelect: false,
  options: [{ label: 'Extend dispatcher', description: 'Reuse delivery rules.' }, { label: 'Queue fanout', description: 'Separate delivery.' }] }] };

async function fixture(fn: (f: ReturnType<typeof createFixture>) => unknown) {
  const f = createFixture();
  try { await fn(f); } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
}
function createFixture() {
  // Shell metacharacters in a legitimate temp parent exercise command quoting.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "question-events-'space ")));
  const configDir = path.join(root, '.claude');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(configDir); fs.mkdirSync(cwd);
  const transcriptFile = path.join(configDir, 'projects', 'fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  fs.writeFileSync(transcriptFile, '{"type":"user","message":{"content":"Review the plan"}}\n');
  const { source, settingsPath } = setupQuestionEventSource({ configDir, cwd, sessionId, rootDir: root });
  const directory = path.dirname(settingsPath);
  const events = path.join(directory, 'events');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const event = { hook_event_name: 'PreToolUse', session_id: sessionId, transcript_path: transcriptFile, cwd,
    tool_name: 'AskUserQuestion', tool_use_id: 'toolu_current', tool_input: input };
  const expected = { configDir, sessionId, transcriptFile };
  const run = (value: unknown = event, raw = false) => {
    const result = spawnSync('/bin/sh', ['-c', command], { input: raw ? String(value) : JSON.stringify(value), encoding: 'utf8', timeout: 5000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
    return result;
  };
  return { root, configDir, cwd, transcriptFile, source, settingsPath, settings, directory, events, command, event, expected, run };
}

test('silent native hook publishes the pending invocation before its assistant JSONL exists', () => fixture(f => {
  expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
  f.run();
  expect(readQuestionEvents(f.source, f.expected)).toEqual([{ id: 'toolu_current', toolName: 'AskUserQuestion', input, cwd: f.cwd }]);
  expect(fs.readFileSync(f.transcriptFile, 'utf8')).not.toContain('AskUserQuestion');
  const call = readQuestionEvents(f.source, f.expected)[0]!;
  expect(call).not.toHaveProperty('result'); expect(call).not.toHaveProperty('answered');
  expect(f.settings.hooks.PreToolUse).toHaveLength(1);
  expect(f.settings.hooks.PreToolUse[0].matcher).toBe('^(AskUserQuestion|ExitPlanMode|Bash)$');
  expect(f.settings.hooks.PermissionRequest).toHaveLength(1);
  expect(f.settings.hooks.PermissionRequest[0]).toEqual({ matcher: '^(Write|Edit|Bash|WebFetch)$',
    hooks: [{ type: 'command', command: f.command, timeout: 5 }] });
  expect(f.settings.hooks.PostToolUse[0]).toEqual({ matcher: '^(Write|Edit|AskUserQuestion|Bash)$',
    hooks: [{ type: 'command', command: f.command, timeout: 5 }] });
  expect(f.settings.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: f.command, timeout: 5 });
  expect(Object.keys(f.settings)).toEqual(['hooks']);
}));

test('early ExitPlanMode recorder preserves normalized input and never becomes AUQ/file permission', () => fixture(f => {
  const toolInput = { plan: '# Plan\n日本語', planFilePath: path.join(f.cwd, 'plan.md'), allowedPrompts: [] };
  const event = { ...f.event, tool_name: 'ExitPlanMode', tool_input: toolInput };
  f.run(event); f.run(event);
  expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
  expect(readPermissionRequestEvents(f.source, f.expected)).toEqual([]);
  const records = fs.readdirSync(f.events);
  expect(records).toHaveLength(1);
  const record = JSON.parse(fs.readFileSync(path.join(f.events, records[0]!), 'utf8'));
  expect(record).toMatchObject({ id: event.tool_use_id, hookEventName: 'PreToolUse', toolName: 'ExitPlanMode', input: toolInput, cwd: f.cwd });
  for (const key of ['result', 'answered', 'requestId', 'permissionDecision']) expect(record).not.toHaveProperty(key);
}));

test('early ExitPlanMode recorder retains owner, immutable input and unchanged byte bounds', async () => {
  for (const patch of [{ session_id: otherSession }, { agent_id: 'fork' }]) await fixture(f => {
    f.run({ ...f.event, tool_name: 'ExitPlanMode', tool_input: {}, ...patch });
    expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
    expect(fs.readdirSync(f.events)).toEqual([]);
  });
  for (const patch of [{ cwd: '/wrong' }, { tool_use_id: '' }, { tool_input: { plan: 'x'.repeat(256 * 1024) } }]) await fixture(f => {
    f.run({ ...f.event, tool_name: 'ExitPlanMode', tool_input: {}, ...patch });
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow('capture failed');
  });
  await fixture(f => {
    f.run({ ...f.event, tool_name: 'ExitPlanMode', tool_input: { plan: 'first' } });
    expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
    f.run({ ...f.event, tool_name: 'ExitPlanMode', tool_input: { plan: 'changed' } });
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow('capture failed');
  });
});

function permissionEvent(f: ReturnType<typeof createFixture>, toolName: 'Write' | 'Edit', toolInput: Record<string, unknown>) {
  return { hook_event_name: 'PermissionRequest', session_id: sessionId, transcript_path: f.transcriptFile,
    cwd: f.cwd, tool_name: toolName, tool_input: toolInput };
}

for (const toolName of ['Write', 'Edit'] as const) {
  test(`silent ${toolName} permission observer preserves full input without a native ID or grant`, () => fixture(f => {
    const file = path.join(f.cwd, 'plan with spaces.md');
    const content = Array.from({ length: 518 }, (_, index) => `${index}: Exact 日本語 plan line.\n`).join('');
    const toolInput = toolName === 'Write' ? { file_path: file, content }
      : { file_path: file, old_string: 'old\ntext', new_string: content, replace_all: false };
    const before = Date.now();
    f.run({ ...permissionEvent(f, toolName, toolInput), requestId: 'payload-cannot-choose', tool_use_id: 'invented-native-id', capturedAtMs: 1,
      hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { file_path: '/not-the-source' } } });
    const calls = readPermissionRequestEvents(f.source, f.expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), capturedAtMs: expect.any(Number), toolName, input: toolInput, cwd: f.cwd });
    expect(calls[0]!.capturedAtMs).toBeGreaterThanOrEqual(before);
    expect(calls[0]!.capturedAtMs).toBeLessThanOrEqual(Date.now());
    expect(calls[0]!.requestId).not.toBe('payload-cannot-choose');
    for (const key of ['id', 'tool_use_id', 'result', 'permissionDecision']) expect(calls[0]).not.toHaveProperty(key);
    expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(f.transcriptFile, 'utf8')).not.toContain(toolName);
    const record = JSON.parse(fs.readFileSync(path.join(f.events, fs.readdirSync(f.events)[0]!), 'utf8'));
    expect(record.hookEventName).toBe('PermissionRequest'); expect(record.toolName).toBe(toolName);
    expect(record.input).toEqual(toolInput); expect(record).not.toHaveProperty('id');
  }));

  test(`${toolName} permission observer retains exact session, main-agent and cwd boundaries`, async () => {
    for (const patch of [{ session_id: otherSession }, { agent_id: 'fork' }]) await fixture(f => {
      f.run({ ...permissionEvent(f, toolName, { file_path: 'plan.md', content: 'original' }), ...patch });
      expect(readPermissionRequestEvents(f.source, f.expected)).toEqual([]);
    });
    await fixture(f => {
      f.run({ ...permissionEvent(f, toolName, { file_path: 'plan.md', content: 'original' }), cwd: f.root });
      expect(() => readPermissionRequestEvents(f.source, f.expected)).toThrow('capture failed');
    });
  });
}

test('separate identical and changed permission requests stay distinct without replacing observed input', () => fixture(f => {
  const event = permissionEvent(f, 'Write', { file_path: 'plan.md', content: 'first' });
  f.run(event); const first = readPermissionRequestEvents(f.source, f.expected)[0]!;
  const file = path.join(f.events, fs.readdirSync(f.events)[0]!); const original = fs.readFileSync(file);
  f.run(event); f.run({ ...event, tool_input: { ...event.tool_input, content: 'changed later' } });
  const calls = readPermissionRequestEvents(f.source, f.expected);
  expect(calls).toHaveLength(3); expect(new Set(calls.map(call => call.requestId)).size).toBe(3);
  expect(calls).toContainEqual(first); expect(fs.readFileSync(file)).toEqual(original);
}));

test('a stored permission input or tool-name change cannot alter observed authority', async () => {
  for (const patch of [{ toolName: 'Edit' }, { input: { file_path: 'other.md', content: 'changed' } }, { capturedAtMs: 1 }]) await fixture(f => {
    f.run(permissionEvent(f, 'Write', { file_path: 'plan.md', content: 'first' }));
    expect(readPermissionRequestEvents(f.source, f.expected)).toHaveLength(1);
    const file = path.join(f.events, fs.readdirSync(f.events)[0]!);
    const event = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...event, ...patch }) + '\n');
    expect(() => readPermissionRequestEvents(f.source, f.expected)).toThrow('Previously observed');
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow('Previously observed');
  });
});

test('permission records require a finite real capture timestamp', async () => {
  for (const capturedAtMs of [undefined, null, '2026-09-09', 0, -1, 1.5, 8_640_000_000_000_001]) await fixture(f => {
    f.run(permissionEvent(f, 'Write', { file_path: 'plan.md', content: 'first' }));
    const file = path.join(f.events, fs.readdirSync(f.events)[0]!);
    const event = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...event, capturedAtMs }) + '\n');
    expect(() => readPermissionRequestEvents(f.source, f.expected)).toThrow('identity');
  });
});

test('permission records cannot be recast as native-ID events', () => fixture(f => {
  f.run(permissionEvent(f, 'Write', { file_path: 'plan.md', content: 'first' }));
  expect(readPermissionRequestEvents(f.source, f.expected)).toHaveLength(1);
  const file = path.join(f.events, fs.readdirSync(f.events)[0]!);
  const event = JSON.parse(fs.readFileSync(file, 'utf8')); event.id = event.requestId;
  fs.writeFileSync(file, JSON.stringify(event) + '\n');
  expect(() => readPermissionRequestEvents(f.source, f.expected)).toThrow('identity');
}));

test('colliding native and observer identity strings poison the ledger instead of replacing a request', () => fixture(f => {
  f.run(permissionEvent(f, 'Write', { file_path: 'plan.md', content: 'first' }));
  const request = readPermissionRequestEvents(f.source, f.expected)[0]!;
  const file = path.join(f.events, fs.readdirSync(f.events)[0]!); const original = fs.readFileSync(file);
  f.run({ ...f.event, tool_use_id: request.requestId });
  expect(() => readPermissionRequestEvents(f.source, f.expected)).toThrow('capture failed');
  expect(fs.readFileSync(file)).toEqual(original);
}));

test('file permission admission rechecks competing PermissionRequest hooks', () => fixture(f => {
  f.run(permissionEvent(f, 'Write', { file_path: 'plan.md', content: 'first' }));
  expect(readPermissionRequestEvents(f.source, f.expected)).toHaveLength(1);
  fs.writeFileSync(path.join(f.configDir, 'settings.local.json'), JSON.stringify({ hooks: { PermissionRequest: [
    { matcher: 'Write', hooks: [{ type: 'command', command: 'must-not-run' }] },
  ] } }));
  expect(() => readPermissionRequestEvents(f.source, f.expected)).toThrow('Unsupported question hook scope');
}));

test('AUQ and file permission evidence stay separate in one immutable ledger', () => fixture(f => {
  f.run();
  f.run(permissionEvent(f, 'Write', { file_path: 'plan.md', content: 'first' }));
  f.run(permissionEvent(f, 'Edit', { file_path: 'plan.md', old_string: 'first', new_string: 'second' }));
  expect(readQuestionEvents(f.source, f.expected)).toEqual([{ id: 'toolu_current', toolName: 'AskUserQuestion', input, cwd: f.cwd }]);
  expect(readPermissionRequestEvents(f.source, f.expected).map(call => call.toolName).sort()).toEqual(['Edit', 'Write']);
}));

test('Write permission input cannot exceed the unchanged event byte limit', () => fixture(f => {
  f.run(permissionEvent(f, 'Write', { file_path: 'plan.md', content: 'x'.repeat(256 * 1024) }));
  expect(() => readPermissionRequestEvents(f.source, f.expected)).toThrow('capture failed');
  expect(fs.existsSync(path.join(f.cwd, 'plan.md'))).toBe(false);
}));

test.skipIf(process.platform === 'win32')('a parent-directory alias binds canonical native paths without accepting a redirected alias', () => fixture(f => {
  const physical = path.join(f.root, 'physical');
  const runRoot = path.join(physical, 'run');
  const alias = path.join(f.root, 'parent-alias');
  const configDir = path.join(runRoot, '.claude');
  const cwd = path.join(runRoot, 'project');
  const transcriptFile = path.join(configDir, 'projects', 'fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
  fs.writeFileSync(transcriptFile, '{}\n'); fs.symlinkSync(physical, alias);
  const logicalRoot = path.join(alias, 'run');
  const logicalConfig = path.join(logicalRoot, '.claude');
  const logicalTranscript = path.join(logicalConfig, 'projects', 'fixture', `${sessionId}.jsonl`);
  const { source, settingsPath } = setupQuestionEventSource({ configDir: logicalConfig,
    cwd: path.join(logicalRoot, 'project'), rootDir: logicalRoot, sessionId });
  expect(source.configDir).toBe(configDir); expect(source.cwd).toBe(cwd);
  expect(settingsPath.startsWith(runRoot + path.sep)).toBe(true);
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  const result = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ ...f.event, cwd, transcript_path: transcriptFile }), encoding: 'utf8', timeout: 5000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  const calls = [{ id: 'toolu_current', toolName: 'AskUserQuestion', input, cwd }];
  expect(readQuestionEvents(source, { configDir: logicalConfig, sessionId, transcriptFile: logicalTranscript })).toEqual(calls);
  expect(readQuestionEvents(source, { configDir: logicalConfig, sessionId, transcriptFile })).toEqual(calls);
  expect(readQuestionEvents(source, { configDir, sessionId, transcriptFile })).toEqual(calls);
  const different = path.join(f.root, 'different');
  fs.mkdirSync(path.join(different, 'run', '.claude'), { recursive: true });
  fs.unlinkSync(alias); fs.symlinkSync(different, alias);
  expect(() => readQuestionEvents(source, { configDir: logicalConfig, sessionId, transcriptFile: logicalTranscript })).toThrow('another session');
}));

test.skipIf(process.platform === 'win32')('canonical setup still rejects leaf directory symlinks', () => fixture(f => {
  for (const key of ['configDir', 'cwd', 'rootDir'] as const) {
    const link = path.join(f.root, `leaf-${key}`);
    fs.symlinkSync(key === 'configDir' ? f.configDir : key === 'cwd' ? f.cwd : f.root, link);
    expect(() => setupQuestionEventSource({ configDir: f.configDir, cwd: f.cwd, rootDir: f.root, sessionId, [key]: link })).toThrow('directory');
  }
}));

test.skipIf(process.platform === 'win32')('project, transcript and event-directory symlinks cannot inherit canonical ownership', async () => {
  for (const target of ['projects', 'project', 'transcript', 'events']) await fixture(f => {
    f.run();
    const original = target === 'projects' ? path.join(f.configDir, 'projects')
      : target === 'project' ? path.dirname(f.transcriptFile) : target === 'transcript' ? f.transcriptFile : f.events;
    const moved = path.join(f.root, `moved-${target}`);
    fs.renameSync(original, moved); fs.symlinkSync(moved, original);
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow();
  });
});

test('observer setup refuses a competing hook before creating another capture directory', () => fixture(f => {
  const before = fs.readdirSync(f.root).sort();
  fs.writeFileSync(path.join(f.configDir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'echo mutation' }] },
  ] } }));
  expect(() => setupQuestionEventSource({ configDir: f.configDir, cwd: f.cwd, sessionId, rootDir: f.root })).toThrow('Unsupported question hook scope');
  expect(fs.readdirSync(f.root).sort()).toEqual(before);
}));

test('captured input loses admission when the controlled hook scope changes', () => fixture(f => {
  f.run(); expect(readQuestionEvents(f.source, f.expected)).toHaveLength(1);
  fs.writeFileSync(path.join(f.configDir, 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'echo mutation' }] },
  ] } }));
  expect(() => readQuestionEvents(f.source, f.expected)).toThrow('Unsupported question hook scope');
}));

test('the helper remains synchronously requireable without running its recorder', () => {
  const file = path.join(import.meta.dir, 'helpers/plan-skill-question-events.ts');
  const result = spawnSync(process.execPath, ['-e', `const helper = require(${JSON.stringify(file)}); if (typeof helper.readQuestionEvents !== 'function') throw new Error('missing export'); process.stdout.write('sync-import-ok');`], { encoding: 'utf8', timeout: 5000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  expect(result.stdout).toBe('sync-import-ok'); expect(result.stderr).toBe('');
});

test.skipIf(process.platform === 'win32')('FIFO event, binding and settings files cannot block a synchronous poll', () => fixture(f => {
  const file = path.join(import.meta.dir, 'helpers/plan-skill-question-events.ts');
  // A bounded child keeps a regressed blocking open from hanging the test runner.
  const script = `
    const [helperFile, configDir, cwd, transcriptFile, target] = process.argv.slice(-5);
    const fs = require('node:fs'), path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const { createHash } = require('node:crypto');
    const { setupQuestionEventSource, readQuestionEvents, readPermissionRequestEvents, readFileCompletionEvents } = require(helperFile);
    const sessionId = ${JSON.stringify(sessionId)};
    const { source, settingsPath } = setupQuestionEventSource({ configDir, cwd, sessionId, rootDir: path.dirname(configDir) });
    const directory = path.dirname(settingsPath);
    const targetFile = target === 'event'
      ? path.join(directory, 'events', createHash('sha256').update('toolu_current').digest('hex') + '.json')
      : path.join(directory, target + '.json');
    if (target !== 'event') fs.unlinkSync(targetFile);
    const fifo = spawnSync('mkfifo', [targetFile], { timeout: 1000 });
    if (fifo.error || fifo.status !== 0) throw new Error('mkfifo failed');
    let refused = false;
    try { readQuestionEvents(source, { configDir, sessionId, transcriptFile }); }
    catch (error) { refused = /Invalid or oversized question event file/.test(String(error)); }
    if (!refused) throw new Error('nonregular input did not fail closed');
    process.stdout.write('fifo-refused');
  `;
  for (const target of ['event', 'binding', 'settings']) {
    const result = spawnSync(process.execPath, ['-e', script, file, f.configDir, f.cwd, f.transcriptFile, target], { encoding: 'utf8', timeout: 1500 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toBe('fifo-refused'); expect(result.stderr).toBe('');
  }
}));

test('exact duplicate emissions coalesce, including concurrent publications', () => fixture(async f => {
  await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', f.command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
    child.on('error', reject); child.on('close', code => {
      try { expect(code).toBe(0); expect(output).toBe(''); resolve(); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(f.event));
  })));
  expect(fs.readdirSync(f.events)).toHaveLength(1);
  expect(readQuestionEvents(f.source, f.expected)).toHaveLength(1);
  f.run({ ...f.event, tool_input: { questions: input.questions } });
  expect(readQuestionEvents(f.source, f.expected)).toHaveLength(1);
}));

test('different input under the same native tool ID poisons the ledger instead of replacing it', () => fixture(f => {
  f.run();
  f.run({ ...f.event, tool_input: { questions: [{ ...input.questions[0], question: 'Different question' }] } });
  expect(() => readQuestionEvents(f.source, f.expected)).toThrow('capture failed');
  expect(fs.readdirSync(f.events)).toHaveLength(2);
}));

for (const patch of [{ session_id: otherSession }, { session_id: 'served:foreign' }, { agent_id: 'subagent-1' }, { agent_id: null }, { agent_id: '' }]) {
  test(`foreign or subagent event has no main-session authority: ${JSON.stringify(patch)}`, () => fixture(f => {
    f.run({ ...f.event, ...patch });
    expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
    expect(fs.readdirSync(f.events)).toEqual([]);
  }));
}

for (const patch of [{ hook_event_name: 'PostToolUse' }, { tool_name: 'Write' }, { tool_name: 'Edit' }, { tool_name: 'Read' }, { hook_event_name: 'PermissionRequest' }, { tool_name: 'mcp__foreign__AskUserQuestion' },
  { tool_use_id: '' }, { tool_use_id: 'x'.repeat(257) }, { tool_input: null }, { tool_input: [] }]) {
  test(`malformed own hook fails closed without affecting provider output: ${JSON.stringify(patch).slice(0, 100)}`, () => fixture(f => {
    f.run({ ...f.event, ...patch });
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow('capture failed');
  }));
}

test('exact cwd and selected main transcript path are mandatory', () => fixture(f => {
  f.run({ ...f.event, cwd: f.root });
  expect(() => readQuestionEvents(f.source, f.expected)).toThrow('capture failed');
}));
test('subagent and foreign transcript paths cannot establish an invocation', () => fixture(f => {
  f.run({ ...f.event, transcript_path: path.join(f.configDir, 'projects', 'fixture', sessionId, 'subagents', 'agent-a.jsonl') });
  expect(() => readQuestionEvents(f.source, f.expected)).toThrow('capture failed');
}));
test('a structurally owned event must still match the exact transcript selected by the reader', () => fixture(f => {
  f.run();
  expect(readQuestionEvents(f.source, { ...f.expected, transcriptFile: null })).toEqual([]);
  expect(() => readQuestionEvents(f.source, { ...f.expected, transcriptFile: path.join(f.configDir, 'projects', 'another-project', `${sessionId}.jsonl`) })).toThrow('identity');
  expect(() => readQuestionEvents(f.source, { ...f.expected, sessionId: otherSession })).toThrow('another session');
}));

test('malformed, truncated and oversized stdin produce no admissible input', async () => {
  for (const raw of ['{', '{"session_id":', 'x'.repeat(256 * 1024 + 1)]) await fixture(f => {
    f.run(raw, true);
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow('capture failed');
  });
});
test('invalid UTF-8 is not silently rewritten into a different native input', () => fixture(f => {
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(f.event).slice(0, -1) + ',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  const result = spawnSync('/bin/sh', ['-c', f.command], { input: bytes, encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  expect(() => readQuestionEvents(f.source, f.expected)).toThrow('capture failed');
}));
test('the payload cannot choose an output path or inject a permission decision', () => fixture(f => {
  const outside = path.join(f.root, 'do-not-create');
  f.run({ ...f.event, destination: outside, hookSpecificOutput: { permissionDecision: 'allow', updatedInput: { answers: { question: 'choice' } } } });
  expect(fs.existsSync(outside)).toBe(false);
  expect(readQuestionEvents(f.source, f.expected)).toEqual([{ id: 'toolu_current', toolName: 'AskUserQuestion', input, cwd: f.cwd }]);
}));
test('setup creates distinct private settings, event directories and nonces for concurrent sessions', () => fixture(f => {
  const second = setupQuestionEventSource({ configDir: f.configDir, cwd: f.cwd, sessionId: otherSession, rootDir: f.root });
  expect(second.settingsPath).not.toBe(f.settingsPath);
  const firstBinding = JSON.parse(fs.readFileSync(path.join(f.directory, 'binding.json'), 'utf8'));
  const secondBinding = JSON.parse(fs.readFileSync(path.join(path.dirname(second.settingsPath), 'binding.json'), 'utf8'));
  expect(firstBinding.nonce).not.toBe(secondBinding.nonce);
  expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700);
  expect(fs.statSync(f.settingsPath).mode & 0o777).toBe(0o600);
  f.run();
  expect(readQuestionEvents(second.source, { configDir: f.configDir, sessionId: otherSession,
    transcriptFile: path.join(f.configDir, 'projects', 'fixture', `${otherSession}.jsonl`) })).toEqual([]);
}));
test('wrong nonce, copied records and mutated launch bindings cannot be admitted', () => fixture(f => {
  const bindingPath = path.join(f.directory, 'binding.json');
  const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
  const wrongCommand = f.command.replace(binding.nonce, '0'.repeat(64));
  const result = spawnSync('/bin/sh', ['-c', wrongCommand], { input: JSON.stringify(f.event), encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
  f.run();
  const second = setupQuestionEventSource({ configDir: f.configDir, cwd: f.cwd, sessionId, rootDir: f.root });
  const name = fs.readdirSync(f.events)[0]!;
  fs.copyFileSync(path.join(f.events, name), path.join(path.dirname(second.settingsPath), 'events', name));
  expect(() => readQuestionEvents(second.source, f.expected)).toThrow('identity');
  fs.appendFileSync(bindingPath, ' ');
  expect(() => readQuestionEvents(f.source, f.expected)).toThrow('binding or settings changed');
}));
test('a complete event is immutable after observation and cannot silently disappear', () => fixture(f => {
  f.run(); readQuestionEvents(f.source, f.expected);
  const file = path.join(f.events, fs.readdirSync(f.events)[0]!);
  const original = fs.readFileSync(file);
  const record = JSON.parse(original.toString()); record.input = { questions: [] };
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
  expect(() => readQuestionEvents(f.source, f.expected)).toThrow('Previously observed');
  fs.writeFileSync(file, original); fs.unlinkSync(file);
  expect(() => readQuestionEvents(f.source, f.expected)).toThrow('disappeared');
}));
test('partial publications, malformed final records, symlinks and oversized files refuse input', async () => {
  await fixture(f => {
    f.run(); const temporary = path.join(f.events, '.pending-00000000-0000-4000-8000-000000000009');
    fs.writeFileSync(temporary, '{'); expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
    fs.unlinkSync(temporary); expect(readQuestionEvents(f.source, f.expected)).toHaveLength(1);
    const file = path.join(f.events, fs.readdirSync(f.events)[0]!); fs.writeFileSync(file, '{}');
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow('Incomplete');
  });
  await fixture(f => {
    f.run(); const file = path.join(f.events, fs.readdirSync(f.events)[0]!);
    const copy = path.join(f.root, 'copy.json'); fs.renameSync(file, copy); fs.symlinkSync(copy, file);
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow();
  });
  await fixture(f => {
    f.run(); const file = path.join(f.events, fs.readdirSync(f.events)[0]!); fs.writeFileSync(file, 'x'.repeat(256 * 1024 + 1));
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow('oversized');
  });
});
test('multiple pending invocations remain separate for the caller ambiguity guard', () => fixture(f => {
  f.run(); f.run({ ...f.event, tool_use_id: 'toolu_second' });
  expect(readQuestionEvents(f.source, f.expected).map(call => call.id).sort()).toEqual(['toolu_current', 'toolu_second']);
}));
test('event inventory and aggregate byte limits never admit a truncated subset', async () => {
  for (const [count, padding, message] of [[257, 0, 'inventory'], [43, 200_000, 'total bound']] as const) await fixture(f => {
    f.run(); const record = JSON.parse(fs.readFileSync(path.join(f.events, fs.readdirSync(f.events)[0]!), 'utf8'));
    for (const name of fs.readdirSync(f.events)) fs.unlinkSync(path.join(f.events, name));
    for (let index = 0; index < count; index++) {
      const id = `toolu_${index}`;
      const name = createHash('sha256').update(id).digest('hex') + '.json';
      fs.writeFileSync(path.join(f.events, name), JSON.stringify({ ...record, id, input: { ...input, padding: 'x'.repeat(padding) } }) + '\n');
    }
    expect(() => readQuestionEvents(f.source, f.expected)).toThrow(message);
  });
});


test('successful file event preserves full native ID/input/response in the existing silent immutable channel', () => fixture(f => {
  const toolInput = { file_path: path.join(f.cwd, 'plan.md'), content: 'Exact 日本語 report' };
  const response = { type: 'create', filePath: toolInput.file_path, content: toolInput.content,
    structuredPatch: [], originalFile: null, userModified: false };
  f.run({ ...permissionEvent(f, 'Write', toolInput), hook_event_name: 'PostToolUse', tool_use_id: 'native-completed-write',
    tool_response: response, capturedAtMs: 1, permissionDecision: 'allow' });
  expect(readFileCompletionEvents(f.source, f.expected)).toEqual([{ id: 'native-completed-write',
    capturedAtMs: expect.any(Number), toolName: 'Write', input: toolInput, response, cwd: f.cwd }]);
  expect(readFileCompletionEvents(f.source, f.expected)[0].capturedAtMs).toBeGreaterThan(1);
  expect(readPermissionRequestEvents(f.source, f.expected)).toEqual([]);
  expect(readQuestionEvents(f.source, f.expected)).toEqual([]);
  expect(fs.existsSync(toolInput.file_path)).toBe(false);
  fs.writeFileSync(path.join(f.configDir, 'settings.local.json'), JSON.stringify({ hooks: { PostToolUse: [
    { matcher: 'Write', hooks: [{ type: 'command', command: 'must-not-run' }] },
  ] } }));
  expect(() => readFileCompletionEvents(f.source, f.expected)).toThrow('Unsupported question hook scope');
}));

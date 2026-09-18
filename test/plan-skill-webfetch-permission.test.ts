import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import captured from './fixtures/webfetch-permission.json';
import { setupQuestionEventSource, readPermissionRequestEvents, readWebFetchPermissionRequestEvents } from './helpers/plan-skill-question-events';
import { currentWebFetchPermissionCard, nativePermissionKey, readPlanSkillQuestions, reserveNativePermissionGrant } from './helpers/plan-skill-questions';
import { isPermissionDialogVisible } from './helpers/claude-pty-runner';

const sessionId = '00000000-0000-4000-8000-000000000001';
let config: string;
let file: string;
beforeEach(() => {
  config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-fetch-')));
  file = path.join(config, 'projects', 'fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
});
afterEach(() => fs.rmSync(config, { recursive: true, force: true }));
const append = (row: object) => fs.appendFileSync(file, JSON.stringify({ sessionId, timestamp: new Date().toISOString(), ...row }) + '\n');
function fixture() {
  const { source, settingsPath } = setupQuestionEventSource({ configDir: config, cwd: config, sessionId, rootDir: config });
  const command = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
  const invoke = (id = 'fetch-1', input: unknown = captured.input, extra: Record<string, unknown> = {}) => append({
    type: 'assistant', cwd: config, message: { role: 'assistant', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'WebFetch', input }] }, ...extra,
  });
  const request = (input: unknown = captured.input, extra: Record<string, unknown> = {}) => {
    const result = Bun.spawnSync(['bash', '-c', command], { timeout: 5000, stdin: Buffer.from(JSON.stringify({
      hook_event_name: 'PermissionRequest', session_id: sessionId, transcript_path: file, cwd: config,
      tool_name: 'WebFetch', tool_input: input, ...extra,
    })), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0); expect(result.stdout.length).toBe(0); expect(result.stderr.length).toBe(0);
  };
  const result = (id = 'fetch-1', is_error = false) => append({ type: 'user', message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'Native fetch result', is_error }] } });
  const read = () => readPlanSkillQuestions(config, sessionId, source);
  const grants = new Set<string>(); const requests = new Map();
  const grant = (card = captured.card) => reserveNativePermissionGrant(read(), card, grants, requests);
  return { source, invoke, request, result, read, grants, grant };
}

test('captured complete Fetch card binds URL, wrapped prompt and domain to one owned one-time grant', () => {
  const s = fixture(); s.invoke();
  expect(isPermissionDialogVisible(captured.card)).toBe(true);
  expect(currentWebFetchPermissionCard(captured.card)).toMatchObject({ columns: 240, domain: 'devblogs.microsoft.com' });
  expect(s.grant()).toBe(false);
  s.request();
  const expected = { configDir: config, sessionId, transcriptFile: file };
  expect(readPermissionRequestEvents(s.source, expected)).toEqual([]);
  expect(readWebFetchPermissionRequestEvents(s.source, expected)).toHaveLength(1);
  expect(s.grant()).toBe(true); expect(s.grant()).toBe(false);
  expect([...s.grants]).toEqual(['fetch-1']);
  expect(s.read().calls).toEqual([]); expect(s.read().ready).toBe(false);
  s.result('foreign'); expect(s.read().permissionTools).toHaveLength(1);
  s.result(); expect(s.read().permissionTools).toEqual([]);
  expect(s.read().permissionResults).toEqual([{ id: 'fetch-1', result: 'completed' }]);
});

test('Fetch one-cell Unicode projection retains exact prompt and native request binding', () => {
  const s = fixture();
  const input = { ...captured.input, prompt: captured.input.prompt.replace('exact', '≤date') };
  const frame = captured.card.replace('exact', '≤date');
  expect(input.prompt).not.toBe(captured.input.prompt);
  s.invoke('fetch-1', input);
  expect(s.grant(frame)).toBe(false);
  expect([...s.grants]).toEqual([]);
  s.request(input);
  expect(() => s.grant(captured.card)).toThrow('cannot be bound');
  expect([...s.grants]).toEqual([]);
  expect(s.grant(frame)).toBe(true);
  expect(s.grant(frame)).toBe(false);
  s.result();
  expect(s.read().permissionResults).toEqual([{ id: 'fetch-1', result: 'completed' }]);
});

const damaged = {
  url: captured.card.replace('/retirement-of-office-', '/other-retirement-of-office-'),
  prompt: captured.card.replace('Quote the exact dates.', 'Quote approximate dates.'),
  domain: captured.card.replaceAll('from devblogs.microsoft.com', 'from learn.microsoft.com'),
  standingDomain: captured.card.replace("again for devblogs.microsoft.com", 'again for learn.microsoft.com'),
  clipped: captured.card.replace('   │ url:', '   │ …'),
  missingPrompt: captured.card.replace(/\n   │ prompt:[^\n]+/, ''),
  wrongFocus: captured.card.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes', ' ❯ 2. Yes'),
  missingNo: captured.card.slice(0, captured.card.lastIndexOf('\n')),
  extraOption: captured.card + '\n   4. Always allow',
  history: captured.card + '\n❯ New draft',
  quoted: captured.card.split('\n').map(line => '> ' + line).join('\n'),
  fenced: '```text\n' + captured.card + '\n```',
  openFence: '```text\n' + captured.card,
  clippedRule: captured.card.slice(241),
  ambiguousWidth: captured.card.replace('replacement', '\treplacement'),
};
test.each(Object.entries(damaged))('Fetch refuses damaged or mismatched captured frame: %s', (_name, card) => {
  const s = fixture(); s.invoke(); s.request();
  expect(() => s.grant(card)).toThrow('cannot be bound');
  expect([...s.grants]).toEqual([]);
});

test.each(['url', 'prompt', 'extra', 'foreign-session', 'subagent', 'wrong-cwd', 'orphan', 'unfinished', 'late-request', 'no-time'])(
  'Fetch request cannot invent or change native invocation authority: %s', variant => {
    const s = fixture();
    if (variant !== 'orphan') s.invoke('fetch-1', captured.input,
      variant === 'unfinished' ? { message: { role: 'assistant', stop_reason: null, content: [{ type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: captured.input }] } }
        : variant === 'no-time' ? { timestamp: null } : {});
    if (variant === 'late-request') s.result();
    const input = variant === 'url' || variant === 'prompt' ? { ...captured.input, [variant]: variant === 'url' ? 'https://example.com/' : 'Changed prompt' }
      : variant === 'extra' ? { ...captured.input, allow_all: true } : captured.input;
    s.request(input, variant === 'foreign-session' ? { session_id: '00000000-0000-4000-8000-000000000002' }
      : variant === 'subagent' ? { agent_id: 'outside-critic' } : variant === 'wrong-cwd' ? { cwd: '/wrong' } : {});
    if (variant === 'extra' || variant === 'wrong-cwd') expect(() => s.read()).toThrow('capture failed');
    else expect(s.grant()).toBe(false);
    expect([...s.grants]).toEqual([]);
  });

test.each(['duplicate', 'same-input-owners', 'other-owner', 'changed-native', 'changed-unfinished', 'changed-name', 'changed-cwd'])(
  'Fetch refuses duplicate, ambiguous or changed ownership: %s', variant => {
    const s = fixture(); s.invoke(); s.request();
    if (variant === 'duplicate') s.request();
    else if (variant === 'same-input-owners') { s.invoke('fetch-2'); s.request(); }
    else if (variant === 'other-owner') s.invoke('fetch-2', { ...captured.input, url: 'https://example.com/' });
    else s.invoke('fetch-1', variant === 'changed-cwd' || variant === 'changed-name' ? captured.input : { ...captured.input, prompt: 'Changed' },
      variant === 'changed-cwd' ? { cwd: '/wrong' } : variant === 'changed-unfinished' || variant === 'changed-name'
        ? { message: { role: 'assistant', stop_reason: variant === 'changed-unfinished' ? null : 'tool_use', content: [{ type: 'tool_use', id: 'fetch-1', name: variant === 'changed-name' ? 'Read' : 'WebFetch', input: captured.input }] } } : {});
    // A conflicting unfinished record still invalidates an earlier complete invocation.
    if (variant === 'changed-unfinished') s.invoke('fetch-1', captured.input, { message: { role: 'assistant', stop_reason: null,
      content: [{ type: 'tool_use', id: 'fetch-1', name: 'WebFetch', input: { ...captured.input, prompt: 'Changed' } }] } });
    expect(() => s.grant()).toThrow(); expect([...s.grants]).toEqual([]);
  });

test('Fetch preserves native errors and refuses indistinguishable stale rendering for another invocation', () => {
  const s = fixture(); s.invoke(); s.request(); expect(s.grant()).toBe(true);
  s.result('fetch-1', true);
  expect(s.read().permissionResults).toEqual([{ id: 'fetch-1', result: 'error' }]);
  s.invoke('fetch-2'); s.request();
  expect(() => s.grant()).toThrow('stale rendering');
  expect([...s.grants]).toEqual(['fetch-1']);
});

const syntheticCredentialUrl = new URL('https://example.com/');
syntheticCredentialUrl.username = 'user';
syntheticCredentialUrl.password = 'password';
test.each([{ ...captured.input, prompt: '' }, { ...captured.input, url: 'file:///tmp/page' },
  { ...captured.input, url: syntheticCredentialUrl.href }, { ...captured.input, prompt: 'Injected\u001b[2J' }])(
  'Fetch rejects malformed or non-projectable payload %#', input => {
    expect(() => nativePermissionKey({ id: 'fetch', name: 'WebFetch', input }, captured.card)).toThrow('cannot be bound');
  });

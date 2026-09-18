import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import captured from './fixtures/read-permission.json';
import { isPermissionDialogVisible } from './helpers/claude-pty-runner';
import { nativePermissionKey, readPlanSkillQuestions, reserveNativePermissionGrant } from './helpers/plan-skill-questions';

const sessionId = '00000000-0000-4000-8000-000000000001';
let config: string, file: string;
beforeEach(() => {
  config = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-read-')));
  file = path.join(config, 'projects/fixture', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, '');
});
afterEach(() => fs.rmSync(config, {recursive: true, force: true}));
const append = (row: object) => fs.appendFileSync(file, JSON.stringify({sessionId, cwd: config, ...row}) + '\n');
const invoke = (id = 'read-1', input: unknown = captured.input, extra: object = {}) => append({
  type: 'assistant', message: {role: 'assistant', stop_reason: 'tool_use', content: [{type: 'tool_use', id, name: 'Read', input}]}, ...extra,
});
const result = (id = 'read-1', is_error = false) => append({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: id, content: 'Read result', is_error}]}});
const read = () => ({...readPlanSkillQuestions(config, sessionId), permissionRequestCapture: true});

test('captured Read card grants its exact owned file once without granting the directory', () => {
  invoke(); const granted = new Set<string>(), requests = new Map();
  expect(isPermissionDialogVisible(captured.card)).toBe(false); // Legacy unbound callers keep their prior scope.
  expect(isPermissionDialogVisible(captured.card, true)).toBe(true);
  expect(nativePermissionKey(read().permissionTools[0]!, captured.card)).toBe('Read:' + captured.input.file_path);
  expect(reserveNativePermissionGrant(read(), captured.card, granted, requests)).toBe(true);
  expect(reserveNativePermissionGrant(read(), captured.card, granted, requests)).toBe(false);
  expect([...granted]).toEqual(['read-1']);
  result('foreign'); expect(read().permissionTools).toHaveLength(1);
  result(); expect(read().permissionTools).toEqual([]);
  expect(read().permissionResults).toEqual([{id: 'read-1', result: 'completed'}]);
  invoke('read-2');
  expect(() => reserveNativePermissionGrant(read(), captured.card, granted, requests)).toThrow('stale rendering');
});

const damaged = {
  file: captured.card.replace('Read(' + captured.input.file_path, 'Read(' + captured.input.file_path + '.other'),
  directory: captured.card.replace('reading from ' + path.dirname(captured.input.file_path), 'reading from /other'),
  focus: captured.card.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes', ' ❯ 2. Yes'),
  missingNo: captured.card.replace('   3. No', ''),
  standingOnly: captured.card.replace(' ❯ 1. Yes', ' ❯ 1. Yes, always allow'),
  footer: captured.card.replace(' Esc to cancel · Tab to amend', ''),
  stale: captured.card + '\n❯ Another prompt',
  quoted: captured.card.split('\n').map(line => '> ' + line).join('\n'),
  fenced: '```text\n' + captured.card + '\n```',
  openFence: '```text\n' + captured.card,
  clipped: captured.card.replace('Read(/home/vercel-sandbox/', 'Read(…/'),
  wrongKind: captured.card.replace(' Read file', ' Edit file'),
};
test.each(Object.entries(damaged))('Read refuses malformed or mismatched current card: %s', (_variant, card) => {
  invoke(); const granted = new Set<string>();
  expect(() => reserveNativePermissionGrant(read(), card, granted, new Map())).toThrow('cannot be bound');
  expect([...granted]).toEqual([]);
});

test.each(['input', 'name', 'cwd', 'unfinished', 'foreign-session', 'multiple', 'no-owner', 'completed', 'extra-input'])(
  'Read refuses absent, changed or ambiguous native ownership: %s', variant => {
    if (variant !== 'no-owner') invoke('read-1', variant === 'extra-input' ? {...captured.input, limit: 1} : captured.input,
      variant === 'foreign-session' ? {sessionId: '00000000-0000-4000-8000-000000000002'} : {});
    if (variant === 'completed') result();
    if (variant === 'multiple') invoke('read-2');
    if (['input', 'name', 'cwd', 'unfinished'].includes(variant)) invoke('read-1', {...captured.input, file_path: '/other'},
      variant === 'cwd' ? {cwd: '/other'} : variant === 'name' || variant === 'unfinished'
        ? {message: {role: 'assistant', stop_reason: variant === 'unfinished' ? null : 'tool_use', content: [{type: 'tool_use', id: 'read-1', name: variant === 'name' ? 'Write' : 'Read', input: variant === 'unfinished' ? {...captured.input, file_path: '/other'} : captured.input}]}}
        : {});
    const granted = new Set<string>();
    if (['foreign-session', 'no-owner', 'completed'].includes(variant)) expect(reserveNativePermissionGrant(read(), captured.card, granted, new Map())).toBe(false);
    else expect(() => reserveNativePermissionGrant(read(), captured.card, granted, new Map())).toThrow();
    expect([...granted]).toEqual([]);
  });

test('Read keeps native failure distinct from a successful result', () => {
  invoke(); result('read-1', true);
  expect(read().permissionResults).toEqual([{id: 'read-1', result: 'error'}]);
});

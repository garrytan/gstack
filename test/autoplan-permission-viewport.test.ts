import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoplanFilePermissionViewport, reserveAutoplanFilePermission } from './helpers/autoplan-phase-order';
import { PtyCurrentScreen } from './helpers/pty-current-screen';
import { isNumberedOptionListVisible, isPermissionDialogVisible } from './helpers/claude-pty-runner';
import type { readPlanSkillQuestions, NativePermissionGrant } from './helpers/plan-skill-questions';

// Pinned 2.1.263 file renderer layout: full relative subtitle above the diff,
// basename below it, and the settings-specific standing option. Only 1 is sent.
let cwd: string, file: string, screen: PtyCurrentScreen;
let native: ReturnType<typeof readPlanSkillQuestions>;
let viewport: AutoplanFilePermissionViewport;
let granted: Set<string>, requests: Map<string, NativePermissionGrant>;
let raw = '', lines = 350, extraWidth = 0, repaint = true, displayPath: string;
let resizes: number[], sends: string[], deadlineAt: number;
let operation: 'create' | 'edit' | 'overwrite' = 'edit';
const card = () => [
  '─'.repeat(120), ` ${{ create: 'Create', edit: 'Edit', overwrite: 'Overwrite' }[operation]} file`, ' ' + displayPath, '╌'.repeat(120),
  ...Array.from({ length: lines }, (_, i) => ` ${i + 1} +ordinary proposed plan line ${i + 1}` + 'x'.repeat(extraWidth)),
  '╌'.repeat(120), ` Do you want to ${operation === 'edit' ? 'make this edit to' : operation} ${path.basename(file)}?`,
  ' ❯ 1. Yes', '   2. Yes, and allow Claude to edit its own settings for this session',
  '   3. No', '', ' Esc to cancel · Tab to amend',
].join('\r\n');
const paint = () => { const text = '\x1b[2J\x1b[H' + card(); raw += text; screen.feed(text); };
const sample = async () => ({ text: (await screen.snapshot()).text, rawEnd: raw.length });
const reserve = (frame: { text: string }) => reserveAutoplanFilePermission(native, frame.text,
  { cwd, planDir: path.join(cwd, '.claude', 'plans'), granted, requests });
const tick = async () => {
  const frame = await sample();
  if (viewport.active && await viewport.advance(native, frame)) return;
  try { if (reserve(frame)) sends.push('1\r'); }
  catch (error) { if (!await viewport.recover(error, native, frame)) throw error; }
};
const useOperation = (value: typeof operation) => {
  operation = value;
  const owner = native.permissionRequests[0]!;
  owner.name = value === 'edit' ? 'Edit' : 'Write';
  owner.input = value === 'edit' ? { file_path: file, old_string: 'existing plan', new_string: 'reviewed plan' }
    : { file_path: file, content: 'reviewed plan' };
  paint();
};
beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-card-free-')));
  file = path.join(cwd, '.claude', 'plans', 'review.md');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'existing plan');
  raw = ''; lines = 350; extraWidth = 0; repaint = true; operation = 'edit'; displayPath = path.relative(cwd, file);
  resizes = []; sends = []; granted = new Set(); requests = new Map(); deadlineAt = Date.now() + 5000;
  native = { calls: [], ready: false, pendingExitPlanModeIds: [], pendingBytes: 0,
    permissionTools: [], permissionResults: [], permissionRequestCapture: true,
    permissionRequests: [{ requestId: 'owned-edit', capturedAtMs: 1, name: 'Edit', cwd,
      input: { file_path: file, old_string: 'existing plan', new_string: 'reviewed plan' }, result: 'pending', nativeToolId: null }] };
  screen = new PtyCurrentScreen({ cols: 120, rows: 120 });
  viewport = new AutoplanFilePermissionViewport({ deadlineAt, granted, session: {
    mark: () => raw.length,
    resizeQuestionViewport: async (rows, deadline) => {
      if (Date.now() >= deadline) return null;
      await screen.snapshot(); const mark = raw.length;
      screen.resize(120, rows); resizes.push(rows);
      if (repaint) paint(); return mark;
    },
  } });
  paint();
});
afterEach(() => { screen.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); });

test.each(['create', 'edit', 'overwrite'] as const)('a taller-than120 owned file needs fresh paints, grants once, and restores only after ACK (%s)', async operation => {
  useOperation(operation);
  const name = operation === 'edit' ? 'Edit' : 'Write';
  expect((await sample()).text).not.toContain(' file\n .claude/plans/review.md');
  expect(() => reserve({ text: card().split('\r\n').slice(-120).join('\n') })).toThrow('cannot be bound');
  await tick(); expect(resizes).toEqual([240]); expect(sends).toEqual([]);
  await tick(); expect(resizes).toEqual([240, 480]); expect(sends).toEqual([]);
  expect((await sample()).text).toContain(' file\n .claude/plans/review.md');
  await tick(); await tick();
  expect(sends).toEqual(['1\r']); expect(resizes).toEqual([240, 480]);
  Object.assign(native.permissionRequests[0]!, { result: 'completed', nativeToolId: 'actual-edit', nativeResultAtMs: 2 });
  await tick(); expect(resizes).toEqual([240, 480, 120]); expect(viewport.active).toBe(false);
  expect([...granted]).toEqual(['request:owned-edit']); expect([...requests.keys()]).toEqual([name + ':' + file]);
});

test('captured Autoplan overwrite reaches a controlled full-header repaint before one grant and a controlled native-ID ACK', async () => {
  const captured = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'autoplan-settings-overwrite.json'), 'utf8'));
  // Preserve the actual card and public input; remap only the dead fixture root
  // to this owned disposable root. Later header paints and ACK are controlled.
  file = path.join(cwd, '.claude/plans', path.basename(captured.pendingRequest.input.file_path));
  fs.writeFileSync(file, 'existing plan'); displayPath = path.relative(cwd, file); operation = 'overwrite';
  native.permissionRequests = [{ ...structuredClone(captured.pendingRequest), cwd,
    input: { ...captured.pendingRequest.input, file_path: file } }];
  const literal = '\x1b[2J\x1b[H' + captured.frame.text.replaceAll('\n', '\r\n');
  raw += literal; screen.feed(literal);
  const initial = await sample();
  expect(initial.text).toBe(captured.frame.text);
  expect(isNumberedOptionListVisible(initial.text)).toBe(true);
  expect(isPermissionDialogVisible(initial.text)).toBe(true);
  expect(() => reserve(initial)).toThrow('cannot be bound');
  await tick(); expect(resizes).toEqual([240]); expect(sends).toEqual([]);
  await tick(); expect(resizes).toEqual([240, 480]); expect(sends).toEqual([]);
  await tick(); await tick(); expect(sends).toEqual(['1\r']);
  expect([...requests.entries()]).toEqual([['Write:' + file, { requestId: captured.pendingRequest.requestId, operation: 'overwrite' }]]);
  expect(native.permissionRequests[0]!.nativeToolId).toBeNull();
  expect(viewport.active).toBe(true);
  Object.assign(native.permissionRequests[0]!, { result: 'completed', nativeToolId: 'controlled-write-ack', nativeResultAtMs: captured.pendingRequest.capturedAtMs + 1 });
  await tick(); expect(resizes).toEqual([240, 480, 120]); expect(viewport.active).toBe(false);
  expect(sends).toEqual(['1\r']);
});

test('a 600-line owned Edit recovers its complete path only after the third fresh paint', async () => {
  lines = 600; paint(); await tick(); await tick();
  expect((await sample()).text).not.toContain(' Edit file');
  expect(sends).toEqual([]); expect(granted.size).toBe(0);
  await tick(); expect(resizes).toEqual([240, 480, 960]);
  expect((await sample()).text).toContain(' Edit file\n .claude/plans/review.md');
  await tick(); await tick();
  expect(sends).toEqual(['1\r']);
  expect([...granted]).toEqual(['request:owned-edit']);
  expect([...requests.entries()]).toEqual([['Edit:' + file, { requestId: 'owned-edit', operation: 'edit' }]]);
  Object.assign(native.permissionRequests[0]!, { result: 'completed', nativeToolId: 'large-edit', nativeResultAtMs: 2 });
  await tick(); expect(resizes).toEqual([240, 480, 960, 120]); expect(viewport.active).toBe(false);
});

test.each(['create', 'edit', 'overwrite'] as const)('a card still clipped at the finite cap fails with the original identity error and no grant (%s)', async operation => {
  useOperation(operation);
  lines = 1000; paint(); await tick(); await tick(); await tick();
  await expect(tick()).rejects.toThrow('Visible permission cannot be bound');
  expect(resizes).toEqual([240, 480, 960]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test('wrapped physical diff rows recover within the cap without treating logical lines as viewport height', async () => {
  lines = 180; extraWidth = 160; paint();
  expect((await screen.snapshot()).lines.some(line => line.wrapped)).toBe(true);
  expect((await sample()).text).not.toContain(' Edit file');
  await tick(); expect((await sample()).text).not.toContain(' Edit file');
  await tick(); expect((await sample()).text).toContain(' Edit file\n .claude/plans/review.md');
  await tick(); expect(sends).toEqual(['1\r']); expect(resizes).toEqual([240, 480]);
  Object.assign(native.permissionRequests[0]!, { result: 'completed', nativeToolId: 'wrapped-edit', nativeResultAtMs: 2 });
  await tick(); expect(resizes).toEqual([240, 480, 120]);
});

test('the first learned native tool ID cannot change on a later recovery sample', async () => {
  await tick(); native.permissionRequests[0]!.nativeToolId = 'first-known-id';
  await tick(); native.permissionRequests[0]!.nativeToolId = 'other-known-id';
  await expect(tick()).rejects.toThrow('changed ownership or input');
  expect(sends).toEqual([]); expect(resizes).toEqual([240, 480]);
});

test.each(['input', 'request', 'cwd', 'operation', 'time', 'native-id'])('repaint cannot transfer authority to changed %s', async kind => {
  if (kind === 'native-id') native.permissionRequests[0]!.nativeToolId = 'first-id';
  await tick(); const owner = native.permissionRequests[0]!;
  if (kind === 'input') owner.input.new_string = 'different changes';
  if (kind === 'request') owner.requestId = 'different-request';
  if (kind === 'cwd') owner.cwd += '-other';
  if (kind === 'operation') owner.name = 'Write';
  if (kind === 'time') owner.capturedAtMs++;
  if (kind === 'native-id') owner.nativeToolId = 'different-id';
  await expect(tick()).rejects.toThrow('changed ownership or input');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]);
});

test.each(['request', 'tool'])('a competing %s introduced during recovery remains ambiguous', async kind => {
  await tick();
  if (kind === 'request') native.permissionRequests.push({ ...structuredClone(native.permissionRequests[0]!), requestId: 'competing' });
  else native.permissionTools.push({ id: 'competing', name: 'Edit', cwd, input: { file_path: file } });
  await expect(tick()).rejects.toThrow('Ambiguous native permission owner');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]);
});

test('an already ambiguous request cannot start recovery', async () => {
  native.permissionTools.push({ id: 'competing', name: 'Edit', cwd, input: { file_path: file } });
  await expect(tick()).rejects.toThrow('multiple tools are pending');
  expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test.each(['create', 'edit', 'overwrite'] as const)('explicit full-path mismatch is an error, not another request to enlarge the viewport (%s)', async operation => {
  useOperation(operation);
  await tick(); lines = 3; displayPath = '.claude/other/review.md'; paint();
  await expect(tick()).rejects.toThrow('cannot be bound');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]);
});

test.each(['create', 'edit', 'overwrite'] as const)('a resize without new native output cannot reuse stale text or renew recovery (%s)', async operation => {
  useOperation(operation);
  repaint = false; await tick();
  for (let i = 0; i < 4; i++) await tick();
  expect(resizes).toEqual([240]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test.each(['create', 'overwrite'] as const)('a settings %s card cannot nominate an Edit owner for repaint', async operation => {
  useOperation(operation); native.permissionRequests[0]!.name = 'Edit';
  await expect(tick()).rejects.toThrow('cannot be bound');
  expect(resizes).toEqual([]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test.each(['error', 'missing-ack'])('a %s completion never restores or grants again', async kind => {
  await tick(); await tick(); await tick();
  native.permissionRequests[0]!.result = kind === 'error' ? 'error' : 'completed';
  await expect(tick()).rejects.toThrow(kind === 'error' ? 'returned an error' : 'successful native ACK');
  expect(sends).toEqual(['1\r']); expect(resizes).toEqual([240, 480]);
});

test('a complete initial card uses the unchanged grant without a viewport transaction', async () => {
  lines = 3; paint(); await tick(); await tick();
  expect(sends).toEqual(['1\r']); expect(resizes).toEqual([]); expect(viewport.active).toBe(false);
});

test('existing scope refusal is not a clipping recovery trigger', async () => {
  native.permissionRequests[0]!.input.file_path = path.join(path.dirname(cwd), 'outside', 'review.md');
  await expect(tick()).rejects.toThrow('outside its fixture');
  expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test('a different basename cannot start recovery', async () => {
  native.permissionRequests[0]!.input.file_path = path.join(path.dirname(file), 'different.md');
  await expect(tick()).rejects.toThrow('cannot be bound');
  expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test('a changed raw barrier cannot start recovery from the previous frame', async () => {
  const frame = await sample(); let error: unknown;
  try { reserve(frame); } catch (cause) { error = cause; }
  raw += 'later native output';
  expect(await viewport.recover(error, native, frame)).toBe(false);
  expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test('a recovery deadline causes no viewport mutation or permission input', async () => {
  const expired = new AutoplanFilePermissionViewport({ deadlineAt: Date.now() - 1, granted, session: {
    mark: () => raw.length, resizeQuestionViewport: async (_rows, deadline) => {
      expect(deadline).toBeLessThan(Date.now()); return null;
    },
  } });
  const frame = await sample(); let error: unknown;
  try { reserve(frame); } catch (cause) { error = cause; }
  expect(await expired.recover(error, native, frame)).toBe(true);
  expect(expired.inputMark).toBe(-1); expect(resizes).toEqual([]); expect(sends).toEqual([]);
});


const queueBashDuringRepaint = () => {
  const owner = native.permissionRequests[0]!;
  owner.nativeToolId = 'owned-edit-tool';
  native.permissionTools.push(
    { id: owner.nativeToolId, name: 'Edit', cwd, input: structuredClone(owner.input) },
    { id: 'queued-bash', name: 'Bash', cwd,
      input: { command: 'printf queued', description: 'Separate queued command' }, bashPermissionRequestId: null },
  );
};

test('a queued Bash during file repaint cannot own or block the exact Edit grant', async () => {
  await tick(); expect(resizes).toEqual([240]);
  queueBashDuringRepaint();
  await tick(); expect(resizes).toEqual([240, 480]); expect(sends).toEqual([]);
  await tick(); await tick();
  expect(sends).toEqual(['1\r']);
  expect([...granted]).toEqual(['request:owned-edit']);
  expect([...requests.entries()]).toEqual([['Edit:' + file, { requestId: 'owned-edit', operation: 'edit' }]]);
  expect(native.permissionTools.find(tool => tool.id === 'queued-bash')?.bashPermissionRequestId).toBeNull();
  Object.assign(native.permissionRequests[0]!, { result: 'completed', nativeResultAtMs: 2 });
  native.permissionTools = native.permissionTools.filter(tool => tool.name === 'Bash');
  await tick(); expect(resizes).toEqual([240, 480, 120]); expect(viewport.active).toBe(false);
  expect(sends).toEqual(['1\r']); expect(granted.has('queued-bash')).toBe(false);
});

test.each(['request', 'Edit', 'Write'])('queued Bash cannot hide a competing %s owner', async kind => {
  await tick(); queueBashDuringRepaint();
  if (kind === 'request') native.permissionRequests.push({ ...structuredClone(native.permissionRequests[0]!), requestId: 'competitor' });
  else native.permissionTools.push({ id: 'competitor', name: kind, cwd, input: { file_path: file } });
  await expect(tick()).rejects.toThrow('Ambiguous native permission owner');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test('queued Bash cannot conceal a change to the pinned file input', async () => {
  await tick(); queueBashDuringRepaint();
  native.permissionRequests[0]!.input.new_string = 'changed plan';
  await expect(tick()).rejects.toThrow('changed ownership or input');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test('a Bash permission frame cannot replace the pinned Edit during recovery', async () => {
  await tick(); queueBashDuringRepaint();
  const bashFrame = '\x1b[2J\x1b[H' + [
    ' Bash command', '   printf queued', '   Separate queued command',
    ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel',
  ].join('\r\n');
  raw += bashFrame; screen.feed(bashFrame);
  await expect(tick()).rejects.toThrow('Visible permission cannot be bound');
  expect(resizes).toEqual([240]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});


test('a Bash queued before the first repaint still leaves one exact captured Edit owner', async () => {
  queueBashDuringRepaint();
  await tick(); expect(resizes).toEqual([240]); expect(sends).toEqual([]);
  await tick(); expect(resizes).toEqual([240, 480]); expect(sends).toEqual([]);
  await tick(); await tick();
  expect(sends).toEqual(['1\r']); expect([...granted]).toEqual(['request:owned-edit']);
  expect([...requests.keys()]).toEqual(['Edit:' + file]);
  Object.assign(native.permissionRequests[0]!, { result: 'completed', nativeResultAtMs: 2 });
  native.permissionTools = native.permissionTools.filter(tool => tool.name === 'Bash');
  await tick(); expect(resizes).toEqual([240, 480, 120]); expect(viewport.active).toBe(false);
  expect(sends).toEqual(['1\r']); expect(granted.has('queued-bash')).toBe(false);
});

test.each(['Edit', 'Write'])('initial queued Bash cannot hide a second %s file owner', async name => {
  queueBashDuringRepaint();
  native.permissionTools.push({ id: 'competitor', name, cwd, input: { file_path: file } });
  await expect(tick()).rejects.toThrow('multiple tools are pending');
  expect(viewport.active).toBe(false); expect(resizes).toEqual([]); expect(sends).toEqual([]);
});

test('initial queued Bash cannot start recovery with two captured file requests', async () => {
  queueBashDuringRepaint();
  native.permissionRequests.push({ ...structuredClone(native.permissionRequests[0]!), requestId: 'competitor' });
  await tick();
  expect(viewport.active).toBe(false); expect(resizes).toEqual([]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test('initial queued Bash cannot turn an explicit full-path mismatch into clipping', async () => {
  queueBashDuringRepaint(); lines = 3; displayPath = '.claude/other/review.md'; paint();
  await expect(tick()).rejects.toThrow('multiple tools are pending');
  expect(viewport.active).toBe(false); expect(resizes).toEqual([]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

test('an initial Bash permission card cannot start file recovery', async () => {
  queueBashDuringRepaint();
  const bashFrame = '\x1b[2J\x1b[H' + [
    ' Bash command', '   printf queued', '   Separate queued command',
    ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel',
  ].join('\r\n');
  raw += bashFrame; screen.feed(bashFrame);
  await expect(tick()).rejects.toThrow('multiple tools are pending');
  expect(viewport.active).toBe(false); expect(resizes).toEqual([]); expect(sends).toEqual([]); expect(granted.size).toBe(0);
});

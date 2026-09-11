import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import captured from './fixtures/autoplan-edit-panel-aj.json';
import published from './fixtures/autoplan-edit-prefix-ai.json';
import { autoplanArtifactPermissionInput, pendingAutoplanArtifactPermissionInput, autoplanArtifactMenuKey } from './helpers/autoplan-artifact-permission';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import type { NativePublicToolEvent } from './helpers/plan-count-transcript';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function replay() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-edit-panel-')); roots.push(root);
  const cwd = path.join(root, path.basename(captured.cwd)), ownedStateRoot = path.join(root, 'home', '.gstack');
  const file = path.normalize(captured.pending.file.replace(captured.ownedStateRoot, ownedStateRoot));
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, captured.before);
  const time = new Date(Date.parse(captured.pending.timestamp) - 1000); fs.utimesSync(file, time, time);
  const events = structuredClone(captured.events) as NativePublicToolEvent[];
  for (const event of events) if (event.input?.file_path === captured.pending.file) event.input.file_path = file;
  const context = { cwd, ownedStateRoot, commandStartedAt: Date.parse(events[0]!.timestamp) - 1,
    now: captured.viewportCapturedAt, viewportCapturedAt: captured.viewportCapturedAt,
    pending: { ...captured.pending, source: 'pre_tool_use' as const, tool: 'Edit' as const, file }, transcriptStatus: 'ready', publicTools: events };
  const viewport = captured.viewport.replace(/^ …[^\n]+$/m, ' …' + path.relative(ownedStateRoot, file));
  return { root, file, context, viewport };
}
const pick = (r: ReturnType<typeof replay>, seen = new Set<string>()) => pendingAutoplanArtifactPermissionInput(r.viewport, r.context, seen);

test('the exact standalone native Edit panel binds the owned current unpublished request', () => {
  const r = replay();
  expect(pick(r)).toEqual({ input: '1\r', signature: r.context.pending.sessionId + ':' + r.context.pending.toolUseId, file: r.file });
  expect(autoplanArtifactPermissionInput(r.viewport, r.context, new Set())).toBeNull();
});

test('complete absolute, home alias and full relative suffix paths retain ownership', () => {
  for (const displayed of ['absolute', 'alias', 'suffix'] as const) {
    const r = replay(), relative = path.relative(r.context.ownedStateRoot, r.file).split(path.sep).join('/');
    const value = displayed === 'absolute' ? r.file : displayed === 'alias' ? '~/.gstack/' + relative : '…' + relative;
    r.viewport = r.viewport.replace(/^ …[^\n]+$/m, ' ' + value); expect(pick(r)?.input).toBe('1\r');
  }
  const crop = replay(); crop.viewport = crop.viewport.split('\n').slice(4).join('\n'); expect(pick(crop)?.input).toBe('1\r');
});

test('missing, foreign, quoted and ambiguous headers do not authorize the current file', () => {
  for (const change of [
    (s: string) => s.replace(/^ …[^\n]+$/m, ' /tmp/foreign.md'),
    (s: string) => s.replace(/^ …[^\n]+$/m, ' …' + path.basename(captured.pending.file)),
    (s: string) => s.replace(/^ …[^\n]+$/m, ' …projects/sibling/ceo-plans/' + path.basename(captured.pending.file)),
    (s: string) => s.replace(' Edit file\n', ''),
    (s: string) => s.replace(' Edit file', ' Read file'),
    (s: string) => s.split('\n').slice(1).join('\n'),
    (s: string) => s.replace(/^─+\n/, '--------\n'),
    (s: string) => '> quoted panel\n' + s,
    (s: string) => '```text\n' + s + '\n```',
    (s: string) => s.split('\n').slice(0, 4).join('\n') + '\n' + s,
    (s: string) => '● Update(/tmp/foreign.md)\n\n' + s,
    (s: string) => s + '\n' + s,
  ]) { const r = replay(); r.viewport = change(r.viewport); expect(pick(r)).toBeNull(); }
});

test('current hook, observed time, same-file history and one-time menu remain required', () => {
  const once = replay(), granted = pick(once)!;
  expect(pick(once, new Set([granted.signature]))).toBeNull();
  expect(pick(once, new Set([autoplanArtifactMenuKey(once.viewport)]))).toBeNull();
  for (const change of [
    (r: ReturnType<typeof replay>) => { r.context.pending.sessionId = 'foreign'; },
    (r: ReturnType<typeof replay>) => { r.context.pending.file = r.file + '.foreign'; },
    (r: ReturnType<typeof replay>) => { r.context.viewportCapturedAt = Date.parse(r.context.pending.timestamp) - 1; },
    (r: ReturnType<typeof replay>) => { r.context.publicTools[1]!.isError = true; },
    (r: ReturnType<typeof replay>) => { r.context.publicTools.push({ kind: 'result', sessionId: r.context.pending.sessionId, toolUseId: r.context.pending.toolUseId, timestamp: new Date(r.context.now).toISOString(), isError: false }); },
    (r: ReturnType<typeof replay>) => { r.context.publicTools.push({ kind: 'use', sessionId: r.context.pending.sessionId, toolUseId: 'newer', timestamp: new Date(r.context.now).toISOString(), name: 'Write', input: { file_path: r.file } }); },
    (r: ReturnType<typeof replay>) => { fs.writeFileSync(r.file, 'Foreign content'); },
    (r: ReturnType<typeof replay>) => { fs.renameSync(r.file, r.file + '.target'); fs.symlinkSync(r.file + '.target', r.file); },
    (r: ReturnType<typeof replay>) => { r.viewport = r.viewport.replace('❯ 1. Yes', '❯ 2. Yes'); },
    (r: ReturnType<typeof replay>) => { r.viewport = r.viewport.replace('3. No', '3. Maybe'); },
    (r: ReturnType<typeof replay>) => { r.viewport = r.viewport.replace(' 10  ', ' 0  '); },
  ]) { const r = replay(); change(r); expect(pick(r)).toBeNull(); }
});

test('published edits retain exact old/new content guards with the standalone presentation', () => {
  const r = replay(), events = structuredClone(published.events) as NativePublicToolEvent[];
  const edit = events.find(e => e.kind === 'use' && e.toolUseId === published.pending.toolUseId)!;
  const oldFile = edit.input!.file_path;
  const file = path.normalize((oldFile as string).replace(published.ownedStateRoot, r.context.ownedStateRoot));
  const cwd = path.join(r.root, path.basename(published.cwd)); fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, published.before);
  for (const event of events) if (event.input?.file_path === oldFile) event.input.file_path = file;
  const header = published.viewport.lastIndexOf('\n● Update(') + 1;
  const viewport = published.viewport.slice(header).split('\n').slice(2).join('\n').replace(/^ …[^\n]+$/m, ' …' + path.relative(r.context.ownedStateRoot, file));
  const context = { cwd, ownedStateRoot: r.context.ownedStateRoot, commandStartedAt: Date.parse(events[0]!.timestamp) - 1, now: Date.parse(published.viewportCapturedAt), transcriptStatus: 'ready', publicTools: events };
  expect(autoplanArtifactPermissionInput(viewport, context, new Set())?.input).toBe('1\r');
  const original = edit.input!.new_string; edit.input!.new_string = 'Unrelated replacement';
  expect(autoplanArtifactPermissionInput(viewport, context, new Set())).toBeNull();
  edit.input!.new_string = original; edit.input!.old_string = 'Unrelated original';
  expect(autoplanArtifactPermissionInput(viewport, context, new Set())).toBeNull();
});

test('only Autoplan owns the standalone panel regression inputs', () => {
  for (const file of ['test/autoplan-edit-panel-aj.test.ts', 'test/fixtures/autoplan-edit-panel-aj.json'])
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['autoplan-chain-pty']);
});

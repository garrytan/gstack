import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import captured from './fixtures/autoplan-edit-prefix-ai.json';
import { autoplanArtifactPermissionInput, pendingAutoplanArtifactPermissionInput, autoplanArtifactMenuKey } from './helpers/autoplan-artifact-permission';
import type { NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function replay() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-edit-prefix-')); roots.push(root);
  const cwd = path.join(root, path.basename(captured.cwd)), ownedStateRoot = path.join(root, 'home', '.gstack');
  const events = structuredClone(captured.events) as NativePublicToolEvent[];
  const latest = events.find(e => e.kind === 'use' && e.toolUseId === captured.pending.toolUseId)!
  const original = latest.input!.file_path as string, file = original.replace(captured.ownedStateRoot, ownedStateRoot);
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, captured.before);
  const time = new Date(Date.parse(latest.timestamp) - 1000); fs.utimesSync(file, time, time);
  for (const event of events) if (event.input?.file_path === original) event.input.file_path = file;
  const context = { cwd, ownedStateRoot, commandStartedAt: Date.parse(events[0]!.timestamp) - 1,
    now: Date.parse(captured.viewportCapturedAt), viewportCapturedAt: Date.parse(captured.viewportCapturedAt), transcriptStatus: 'ready', publicTools: events };
  const viewport = captured.viewport.replace(/^ …[^\n]+$/m, ' …' + path.relative(ownedStateRoot, file));
  const header = viewport.lastIndexOf('\n● Update(') + 1;
  return { root, file, current: latest, context, viewport, prefix: viewport.slice(0, header), panel: viewport.slice(header) };
}
const pick = (r: ReturnType<typeof replay>, seen = new Set<string>()) => autoplanArtifactPermissionInput(r.viewport, r.context, seen);

test('the exact retained prior diff output does not hide the current published owned edit', () => {
  const r = replay();
  expect(r.prefix.split('\n')).toHaveLength(17);
  expect(pick(r)).toEqual({ input: '1\r', signature: r.current.sessionId + ':' + r.current.toolUseId, file: r.file });
  r.viewport = r.panel;
  expect(pick(r)?.input).toBe('1\r');
});

test('completed diff rows are ignored only before one complete current native panel', () => {
  for (const prefix of ['      1 +Previous completed output\n\n', '         +cropped prior row\n      2 +next prior row\n         +wrapped row\n\n', '      1 -Old value\n      1 +New value\n\n']) {
    const r = replay(); r.viewport = prefix + r.panel; expect(pick(r)?.input).toBe('1\r');
  }
});

test('competing headers, previous panels, misleading prose and quotes remain rejected', () => {
  for (const prefix of [
    '● Update(/tmp/foreign.md)\n\n',
    '● Update(~/.gstack/projects/gstack-autoplan-chain-9599im/ceo-plans/2026-09-10-user-dashboard.md)\n  ⎿ Added 1 line\n\n',
    ' Edit file\n /tmp/foreign.md\n────────\n',
    'Example:\n', '> quoted output\n', '```diff\n      1 +quoted\n```\n',
  ]) { const r = replay(); r.viewport = prefix + r.viewport; expect(pick(r)).toBeNull(); }
  const priorPanel = replay(); priorPanel.viewport = priorPanel.panel + '\n' + priorPanel.panel; expect(pick(priorPanel)).toBeNull();
});

test('malformed completed-output gutters cannot become a panel delimiter', () => {
  for (const prefix of ['     1 +wrong indent\n', '      0 +zero line\n', '      9007199254740992 +unsafe line\n', '      1 +row\n        +short wrap\n', '      1 +row\n         -wrong kind\n', '         +only a cropped fragment\n']) {
    const r = replay(); r.viewport = prefix + r.panel; expect(pick(r)).toBeNull();
  }
});

test('the complete current header, exact target, menu and requested replacement remain binding', () => {
  for (const change of [
    (r: ReturnType<typeof replay>) => { r.viewport = r.viewport.replace('● Update(~/.gstack/', '● Update(/foreign/'); },
    (r: ReturnType<typeof replay>) => { r.viewport = r.viewport.replace(/^ …[^\n]+$/m, ' …projects/sibling/ceo-plans/2026-09-10-user-dashboard.md'); },
    (r: ReturnType<typeof replay>) => { r.viewport = r.viewport.replace(' Edit file', ' Read file'); },
    (r: ReturnType<typeof replay>) => { r.viewport = r.viewport.replace('❯ 1. Yes', '❯ 2. Yes'); },
    (r: ReturnType<typeof replay>) => { r.viewport = r.viewport.replace('3. No', '3. Maybe'); },
    (r: ReturnType<typeof replay>) => { r.viewport += '\nDo another action.'; },
    (r: ReturnType<typeof replay>) => { r.current.input!.new_string = 'Unrelated replacement'; },
    (r: ReturnType<typeof replay>) => { fs.writeFileSync(r.file, 'Unrelated current file'); },
  ]) { const r = replay(); change(r); expect(pick(r)).toBeNull(); }
});

test('seen, completed, foreign or superseded native requests cannot borrow the valid panel', () => {
  const once = replay(), granted = pick(once)!;
  expect(pick(once, new Set([granted.signature]))).toBeNull();
  for (const change of [
    (r: ReturnType<typeof replay>) => { const e = r.current; r.context.publicTools.push({ kind: 'result', sessionId: e.sessionId, toolUseId: e.toolUseId, timestamp: new Date(r.context.now).toISOString(), isError: false }); },
    (r: ReturnType<typeof replay>) => { r.current.sessionId = 'foreign'; },
    (r: ReturnType<typeof replay>) => { r.current.name = 'Write'; },
    (r: ReturnType<typeof replay>) => { r.current.input!.file_path = r.file + '.foreign'; },
    (r: ReturnType<typeof replay>) => { r.context.publicTools.find(e => e.kind === 'result')!.isError = true; },
    (r: ReturnType<typeof replay>) => { const e = structuredClone(r.current); e.toolUseId = 'newer-edit'; r.context.publicTools.push(e); },
  ]) { const r = replay(); change(r); expect(pick(r)).toBeNull(); }
});

test('metadata fallback uses the same panel boundary while published inputs stay authoritative', () => {
  const r = replay(), current = r.current;
  const pending = { source: 'pre_tool_use' as const, tool: 'Edit' as const, sessionId: current.sessionId, toolUseId: current.toolUseId, timestamp: captured.pending.timestamp, file: r.file };
  expect(pendingAutoplanArtifactPermissionInput(r.viewport, { ...r.context, pending }, new Set())).toBeNull();
  // Synthetic missing-publication projection; actual AI request was published.
  r.context.publicTools = r.context.publicTools.filter(e => e.toolUseId !== current.toolUseId);
  const context = { ...r.context, pending };
  expect(pendingAutoplanArtifactPermissionInput(r.viewport, context, new Set())?.input).toBe('1\r');
  expect(pendingAutoplanArtifactPermissionInput(r.viewport, context, new Set([autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
  expect(pendingAutoplanArtifactPermissionInput(r.viewport, { ...context, viewportCapturedAt: Date.parse(pending.timestamp) - 1 }, new Set())).toBeNull();
  r.viewport = 'Example:\n' + r.viewport;
  expect(pendingAutoplanArtifactPermissionInput(r.viewport, context, new Set())).toBeNull();
});

test('the exact prefix fixture and controls select only Autoplan', () => {
  for (const file of ['test/autoplan-edit-prefix-ai.test.ts', 'test/fixtures/autoplan-edit-prefix-ai.json'])
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['autoplan-chain-pty']);
});

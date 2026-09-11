import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fixture from './fixtures/autoplan-artifact-permission-ad-v3.json';
import { autoplanArtifactPermissionInput } from './helpers/autoplan-artifact-permission';
import { isPermissionDialogVisible } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';
import type { NativePublicToolEvent } from './helpers/plan-count-transcript';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function replay(relative?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-artifact-permission-')); roots.push(root);
  const cwd = path.join(root, path.basename(fixture.cwd)); fs.mkdirSync(cwd);
  const ownedStateRoot = path.join(root, 'home', '.gstack');
  const original = fixture.events.at(-1)!.input!.file_path;
  const file = path.join(ownedStateRoot, 'projects', path.basename(cwd), relative ?? path.relative(
    path.join(fixture.stateRoot, 'projects', path.basename(fixture.cwd)), original));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const publicTools = structuredClone(fixture.events) as NativePublicToolEvent[];
  for (const event of publicTools) if (event.input?.file_path) event.input.file_path = file;
  const lastWrite = publicTools.filter(event => event.name === 'Write').at(-1)!;
  fs.writeFileSync(file, lastWrite.input!.content as string);
  const context = { cwd, ownedStateRoot, commandStartedAt: fixture.commandStartedAt,
    now: Date.parse('2026-09-09T20:36:27.729Z'), transcriptStatus: 'ready', publicTools };
  const viewport = fixture.viewport.replaceAll(path.basename(original), path.basename(file));
  return { root, file, context, viewport };
}
const pick = (r: ReturnType<typeof replay>, seen = new Set<string>()) =>
  autoplanArtifactPermissionInput(r.viewport, r.context, seen);

describe('owned Autoplan artifact edit permission', () => {
  test('captured cropped pane needs its pending identity; shared generic recognition stays unchanged', () => {
    const r = replay();
    expect(isPermissionDialogVisible(fixture.viewport)).toBe(false);
    expect(pick(r)).toEqual({ input: '1\r', signature: `${fixture.sessionId}:${fixture.events.at(-1)!.toolUseId}`, file: r.file });
    expect(pick(r, new Set([pick(r)!.signature]))).toBeNull();
  });

  test('a later same-file Edit has a new one-time epoch even when the footer is identical', () => {
    const r = replay(); const first = pick(r)!; const edit = r.context.publicTools.at(-1)!;
    fs.writeFileSync(r.file, fs.readFileSync(r.file, 'utf8').replace(edit.input!.old_string as string, edit.input!.new_string as string));
    r.context.publicTools.push({ sessionId: fixture.sessionId, toolUseId: edit.toolUseId, kind: 'result',
      timestamp: '2026-09-09T20:28:00.000Z', isError: false });
    r.context.publicTools.push({ ...structuredClone(edit), toolUseId: 'next-owned-edit', timestamp: '2026-09-09T20:28:01.000Z' });
    expect(pick(r, new Set([first.signature]))?.signature).toBe(`${fixture.sessionId}:next-owned-edit`);
  });

  test('a queued non-file tool cannot replace or grant the unique current Edit permission', () => {
    const r = replay();
    r.context.publicTools.push({ sessionId: fixture.sessionId, toolUseId: 'queued-bash', kind: 'use',
      timestamp: '2026-09-09T20:27:41.541Z', name: 'Bash', input: { command: 'echo unrelated queued work' } });
    expect(pick(r)?.input).toBe('1\r');
    r.context.publicTools.push({ ...r.context.publicTools.at(-1)!, toolUseId: 'concurrent-write', name: 'Write',
      input: { file_path: r.file, content: 'other mutation' } });
    expect(pick(r)).toBeNull();
  });

  test('the two source-declared Eng test-plan layouts have the same bounded edit path', () => {
    for (const file of ['test-main-eng-review-test-plan-20260909-203000.md', 'test-main-test-plan-20260909-203000.md'])
      expect(pick(replay(file))?.input).toBe('1\r');
  });

  test('requires the exact owned project and known artifact filename; no broad state/home approval', () => {
    for (const file of ['../sibling/ceo-plans/2026-09-09-user-dashboard.md', 'config.yaml', 'reviews.jsonl',
      'main-autoplan-restore-20260909-200700.md', 'ceo-plans/archive/2026-09-09-user-dashboard.md',
      'designs/screen-20260909/mockup.md', 'dx-plans/2026-09-09-plan.md', 'arbitrary.md'])
      expect(pick(replay(file)), file).toBeNull();
    const r = replay();
    r.context.ownedStateRoot = undefined as any; expect(pick(r)).toBeNull();
    r.context.ownedStateRoot = path.join(r.root, 'caller-GSTACK_HOME'); expect(pick(r)).toBeNull();
    r.context.ownedStateRoot = path.join(r.root, 'home', '.gstack');
    r.context.cwd = path.join(r.root, 'sibling'); expect(pick(r)).toBeNull();
  });

  test('regular current file and exact requested old/new text are mandatory', () => {
    const r = replay(); const before = fs.readFileSync(r.file);
    fs.writeFileSync(r.file, 'unrelated current content'); expect(pick(r)).toBeNull();
    fs.writeFileSync(r.file, before);
    r.context.publicTools.at(-1)!.input!.new_string = 'unrelated replacement'; expect(pick(r)).toBeNull();
    fs.unlinkSync(r.file); fs.mkdirSync(r.file); expect(pick(r)).toBeNull();
  });

  test.skipIf(process.platform === 'win32')('rejects symlink escape and symlink aliases within the owned tree', () => {
    const r = replay(); const other = path.join(r.root, 'external.md');
    fs.renameSync(r.file, other); fs.symlinkSync(other, r.file); expect(pick(r)).toBeNull();
    fs.unlinkSync(r.file); fs.renameSync(other, r.file);
    const directory = path.dirname(r.file); const alias = directory + '-actual';
    fs.renameSync(directory, alias); fs.symlinkSync(alias, directory); expect(pick(r)).toBeNull();
  });

  test.skipIf(process.platform === 'win32')('trusted temp-parent aliases preserve ownership without permitting a symlink state root', () => {
    const r = replay(); const alias = path.join(r.root, 'temp-parent-alias');
    fs.symlinkSync(path.join(r.root, 'home'), alias);
    const target = path.join(alias, '.gstack', path.relative(r.context.ownedStateRoot, r.file));
    r.context.ownedStateRoot = path.join(alias, '.gstack');
    for (const event of r.context.publicTools) if (event.input?.file_path) event.input.file_path = target;
    r.file = target;
    expect(pick(r)?.input).toBe('1\r'); // e.g. macOS /var -> /private/var, above owned root
    const stateAlias = path.join(r.root, 'state-alias');
    fs.symlinkSync(r.context.ownedStateRoot, stateAlias);
    const other = path.join(stateAlias, path.relative(r.context.ownedStateRoot, r.file));
    r.context.ownedStateRoot = stateAlias;
    for (const event of r.context.publicTools) if (event.input?.file_path) event.input.file_path = other;
    r.file = other;
    expect(pick(r)).toBeNull();
  });

  test('missing, stale, future, foreign, completed, failed, duplicate and concurrent identities stay closed', () => {
    const mutations: Array<(r: ReturnType<typeof replay>) => void> = [
      r => { r.context.transcriptStatus = 'error'; },
      r => { r.context.publicTools = []; },
      r => { r.context.commandStartedAt = r.context.now + 1; },
      r => { r.context.commandStartedAt = Date.parse(r.context.publicTools.at(-1)!.timestamp) + 1; },
      r => { r.context.publicTools.at(-1)!.timestamp = '2026-09-10T00:00:00.000Z'; },
      r => { r.context.publicTools.at(-1)!.timestamp = 'invalid'; },
      r => { r.context.publicTools.at(-1)!.sessionId = 'foreign'; },
      r => { r.context.publicTools.at(-1)!.sessionId = ''; },
      r => { r.context.publicTools.at(-1)!.toolUseId = ''; },
      r => { r.context.publicTools.at(-1)!.name = 'Write'; },
      r => { r.context.publicTools.at(-1)!.input!.replace_all = true; },
      r => { r.context.publicTools.push({ ...r.context.publicTools.at(-1)!, kind: 'result', isError: false }); },
      r => { r.context.publicTools.push({ ...r.context.publicTools.at(-1)!, kind: 'result', isError: true }); },
      r => { r.context.publicTools.push(structuredClone(r.context.publicTools.at(-1)!)); },
      r => { r.context.publicTools.splice(-1, 0, { ...structuredClone(r.context.publicTools.at(-1)!), toolUseId: 'other-pending-edit' }); },
      r => { for (const event of r.context.publicTools) if (event.kind === 'result') event.isError = true; },
      r => { for (const event of r.context.publicTools.slice(0, -1)) if (event.input) event.input.file_path = r.file + '-sibling'; },
      r => { r.context.publicTools.reverse(); },
    ];
    for (const mutate of mutations) { const r = replay(); mutate(r); expect(pick(r), mutate.toString()).toBeNull(); }
  });

  test('quotes, examples, unrelated diffs, malformed menus, extra options and broad selection are rejected', () => {
    const mutations = [
      (s: string) => 'Example:\n' + s, (s: string) => '```\n' + s + '\n```',
      (s: string) => s.split('\n').map(line => '> ' + line).join('\n'),
      (s: string) => s.replace('Success target made numeric', 'Unrelated line copied from another plan'),
      (s: string) => s.replace('2026-09-09-user-dashboard.md?', 'sibling.md?'),
      (s: string) => s.replace('❯ 1. Yes', '  1. Yes').replace(' 2. Yes', '❯2. Yes'),
      (s: string) => s.replace('❯ 1. Yes', '❯ 1. Yes, always allow'),
      (s: string) => s.replace('   3. No', '   3. No\n   4. Change permission mode'),
      (s: string) => s.replace('Esc to cancel · Tab to amend', 'Enter to select'),
      (s: string) => s + '\nPlease choose the quoted example above.',
      (s: string) => s.slice(s.indexOf(' Do you want')), // no bound diff
    ];
    for (const mutate of mutations) { const r = replay(); r.viewport = mutate(r.viewport); expect(pick(r), mutate.toString()).toBeNull(); }
  });

  for (const deletion of [false, true]) test(`native ${deletion ? 'deletion' : 'replacement'} diff rows remain bound to the requested old/new text`, () => {
    const r = replay(); const before = 'Old first\nOld second\nContext\n';
    fs.writeFileSync(r.file, before);
    r.context.publicTools.filter(event => event.name === 'Write').at(-1)!.input!.content = before;
    const edit = r.context.publicTools.at(-1)!;
    edit.input!.old_string = 'Old first\nOld second';
    edit.input!.new_string = deletion ? '' : 'New first\nNew second';
    const menu = r.viewport.slice(r.viewport.indexOf(' Do you want'));
    // Existing native fixtures include 102-,103-,102+,103+ replacements,
    // and deleted-only rows. These small controls are projected, not live panes.
    r.viewport = ' 1 -Old first\n 2 -Old second\n' +
      (deletion ? '' : ' 1 +New first\n 2 +New second\n') +
      ' 3  Context\n' + '╌'.repeat(20) + '\n' + menu;
    expect(pick(r)?.input).toBe('1\r');
    r.viewport = r.viewport.replace(' 2 -Old second', ' 2 -Context');
    expect(pick(r)).toBeNull(); // Existing context is not part of the requested deletion.
  });

  // AZ's public line 116 wraps at column five, not the old fixed column four.
  // These small panes exercise the same renderer rule without a transcript corpus.
  for (const [line, numbered, continuation] of [
    [7, ' 7 ', '   '], [17, ' 17 ', '    '],
    [116, ' 116 ', '     '], [1024, ' 1024 ', '      '],
  ] as const) test(`wrapped line ${line} binds its own marker column and exact requested bytes`, () => {
    const r = replay(), old = 'Old first portion kept together', replacement = 'New first portion kept together';
    const before = Array.from({ length: line - 1 }, (_, n) => `Context ${n}`).concat(old, 'Context tail').join('\n');
    fs.writeFileSync(r.file, before);
    r.context.publicTools.filter(event => event.name === 'Write').at(-1)!.input!.content = before;
    const edit = r.context.publicTools.at(-1)!;
    edit.input!.old_string = old; edit.input!.new_string = replacement;
    const menu = r.viewport.slice(r.viewport.indexOf(' Do you want'));
    const rows = `${numbered}-Old first portion\n${continuation}- kept together\n` +
      `${numbered}+New first portion\n${continuation}+ kept together\n`;
    const pane = rows + '╌'.repeat(20) + '\n' + menu;
    r.viewport = pane;
    expect(pick(r)).toEqual({ input: '1\r', signature: `${edit.sessionId}:${edit.toolUseId}`, file: r.file });
    expect(pick(r, new Set([pick(r)!.signature]))).toBeNull();
    for (const invalid of [
      pane.replaceAll(`\n${continuation}`, `\n${continuation.slice(1)}`), // left-shifted continuation
      pane.replaceAll(`\n${continuation}`, `\n ${continuation}`), // right-shifted continuation
      pane.replace(`${continuation}- kept`, `${continuation}+ kept`), // different kind
      pane.replace(`${numbered}+New`, ` ${numbered}+New`), // mixed complete-row columns
      `${continuation}- kept together\n` + pane, // no owning numbered row
      pane.replace('New first portion', 'Foreign replacement'),
      pane.replace(numbered, ' 0 '),
      pane.replace(numbered, ' 01 '),
      pane.replace(numbered, ' 9007199254740992 '),
    ]) { r.viewport = invalid; expect(pick(r), invalid).toBeNull(); }
  });

  test('an earlier unresolved mutation cannot make the latest completed Edit current', () => {
    const r = replay(); const events = r.context.publicTools; const edit = events.at(-1)!;
    events.splice(-1, 0, { ...structuredClone(edit), toolUseId: 'earlier-unresolved-edit',
      input: { ...edit.input, file_path: r.file + '-other' } });
    events.push({ sessionId: edit.sessionId, toolUseId: edit.toolUseId, kind: 'result',
      timestamp: '2026-09-09T20:28:00.000Z', isError: false });
    expect(pick(r)).toBeNull();
  });

  test('new helper, fixture, and regression select only the existing Autoplan paid case', () => {
    for (const file of ['test/helpers/autoplan-artifact-permission.ts', 'test/autoplan-artifact-permission.test.ts',
      'test/fixtures/autoplan-artifact-permission-ad-v3.json'])
      expect(selectTests([file], E2E_TOUCHFILES).selected).toEqual(['autoplan-chain-pty']);
  });
});

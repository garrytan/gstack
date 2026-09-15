import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fixture from './fixtures/plan-count-crop-ak.json';
import { currentFilePermissionEpoch } from './helpers/plan-count-file-permission';
import { createPlanCountPermissionGuard } from './helpers/claude-pty-runner';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

function replay(change: (f: any) => void = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-crop-ak-'));
  const expected = path.join(dir, 'report.md'), record = path.join(dir, 'record.json');
  const f: any = { expected, record, screen: fixture.screen.replaceAll(path.dirname(fixture.hook.expected), dir)
    .replaceAll(path.basename(fixture.hook.expected), 'report.md'), state: { ...structuredClone(fixture.hook), expected },
    before: fixture.ownedBefore, cwd: fixture.cwd, config: fixture.config, startedAt: fixture.startedAt,
    transcript: structuredClone(fixture.transcript), fileKind: 'file' };
  try {
    change(f); fs.writeFileSync(record, JSON.stringify(f.state));
    if (f.fileKind === 'file') fs.writeFileSync(expected, f.before);
    if (f.fileKind === 'directory') fs.mkdirSync(expected);
    if (f.fileKind === 'symlink') { const other = path.join(dir, 'other.md'); fs.writeFileSync(other, f.before); fs.symlinkSync(other, expected); }
    const epoch = currentFilePermissionEpoch(record, f.expected, f.cwd, f.config, f.startedAt, f.transcript, f.screen);
    return { epoch, screen: f.screen, guard: createPlanCountPermissionGuard(), run: () => createPlanCountPermissionGuard()(f.screen, '', epoch) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('actual owned bare continuation uses the preceding original line and grants once', () => {
  const r = replay();
  expect(r.epoch?.pendingId).toBe(fixture.hook.pendingId);
  expect(r.guard(r.screen, '', r.epoch)).toBe('grant');
  expect(r.guard(r.screen, '', r.epoch)).toBe('handled');
});

test('harmless preceding line number relocation keeps the exact content binding', () => {
  const r = replay(f => {
    f.before = 'Added unchanged line\n' + f.before;
    f.screen = f.screen.replace(/^ {0,3}82 +$/m, ' 83  ');
  });
  expect(r.epoch?.pendingId).toBe(fixture.hook.pendingId);
});

const negatives: Array<[string, (f: any) => void]> = [
  ['wrong preceding line', f => { f.screen = f.screen.replace(/^ {0,3}82 +$/m, ' 83  '); }],
  ['unrelated prose continuation', f => { f.screen = f.screen.replace(/^.*\n/, '      Apply this edit now\n'); }],
  ['source quotation continuation', f => { f.screen = f.screen.replace(/^.*\n/, '      > Example: apply this edit now\n'); }],
  ['foreign continuation suffix', f => { f.screen = f.screen.replace('f2 (~7.6:1)', 'foreign (~7.6:1)'); }],
  ['five-space unnumbered gutter', f => { f.screen = f.screen.slice(1); }],
  ['seven-space unnumbered gutter', f => { f.screen = ' ' + f.screen; }],
  ['no following unchanged numbered row', f => { f.screen = f.screen.replace(/^ {0,3}82 +$/m, ' 82 +'); }],
  ['two arbitrary continuation rows', f => { f.screen = f.screen.split('\n')[0] + '\n' + f.screen; }],
  ['missing original file', f => { f.fileKind = 'missing'; }],
  ['directory in place of original file', f => { f.fileKind = 'directory'; }],
  ['oversized original file', f => { f.before += 'x'.repeat(65537); }],
  ['foreign displayed directory', f => { f.screen = f.screen.replace(path.dirname(f.expected) + ' for this session', path.join(path.dirname(f.expected), 'foreign') + ' for this session'); }],
  ['foreign hook expected path', f => { f.state.expected += '.foreign'; }],
  ['no current native request', f => { f.state.pendingId = null; }],
  ['completed native request', f => { f.state.completedId = f.state.pendingId; }],
  ['stale native timestamp', f => { f.state.timestamp = new Date(f.startedAt - 1).toISOString(); }],
  ['future native timestamp', f => { f.state.timestamp = new Date(Date.now() + 60000).toISOString(); }],
  ['foreign session transcript', f => { f.transcript.assistantMessages[0].sessionId = 'foreign'; }],
  ['unavailable native transcript', f => { f.transcript.status = 'error'; }],
  ['missing complete menu footer', f => { f.screen = f.screen.replace('Esc to cancel · Tab to amend', ''); }],
  ['selected policy change', f => { f.screen = f.screen.replace('❯ 1. Yes', '❯ 1. Yes, always allow'); }],
  ['unrelated prompt prepended', f => { f.screen = '☐ Review this example\n' + f.screen; }],
  ['historical pane is not current viewport', f => { f.screen = 'Waiting for current tool'; }],
];
test.each(negatives)('%s cannot supply an owned epoch', (_, change) => {
  const r = replay(change); expect(r.epoch).not.toBeTruthy(); expect(r.run()).not.toBe('grant');
});
test.skipIf(process.platform === 'win32')('a symlink cannot supply current original content', () => {
  expect(replay(f => { f.fileKind = 'symlink'; }).epoch).toBeNull();
});
test('new dependencies have the exact existing file-permission consumers', () => {
  for (const dependency of ['test/plan-count-crop-ak.test.ts', 'test/fixtures/plan-count-crop-ak.json']) {
    expect(selectTests([dependency], E2E_TOUCHFILES).selected.sort()).toEqual(
      selectTests(['test/helpers/plan-count-file-permission.ts'], E2E_TOUCHFILES).selected.sort());
  }
});

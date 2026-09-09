import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import captured from './fixtures/plan-count-permission-ac.json';
import { classifyPlanCountFrame, createPlanCountPermissionGuard } from './helpers/claude-pty-runner';
import { recordFilePermission, currentFilePermissionEpoch, currentFilePermissionBinding } from './helpers/plan-count-file-permission';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'count-permission-ac-'));
  const cwd = path.join(dir, 'cwd'), config = path.join(dir, '.claude');
  const expected = path.join(dir, 'report.md'), file = path.join(dir, 'state.json');
  fs.mkdirSync(cwd); const startedAt = Date.now() - 1000;
  const screen = captured.rows[0]!.screen
    .replace('../gstack-e2e-plan-design-3vPM9g/gstack-test-plan-design.md', expected)
    .replaceAll('gstack-test-plan-design.md', 'report.md');
  const transcript: any = { status: 'ready', calls: [], assistantMessages: [{ sessionId: 'main', text: 'Reviewing' }] };
  const record = (name: string, id: string, delta: object = {}) => recordFilePermission(JSON.stringify({
    hook_event_name: name, tool_name: 'Edit', session_id: 'main', tool_use_id: id, cwd,
    transcript_path: path.join(config, 'projects', 'owned', 'main.jsonl'),
    tool_input: { file_path: expected, old_string: 'PRIVATE_OLD', new_string: 'PRIVATE_NEW' }, ...delta,
  }), file, cwd, config, expected);
  const epoch = () => currentFilePermissionEpoch(file, expected, cwd, config, startedAt, transcript, screen);
  return { dir, cwd, config, expected, file, screen, record, epoch,
    close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('all five actual stalled screens already identify an edit permission', () => {
  for (const row of captured.rows) {
    expect(classifyPlanCountFrame(row.screen), row.attempt).toBe('permission');
    expect(createPlanCountPermissionGuard()(row.screen), row.attempt).toBe('grant');
    expect(row.hook.pendingId).not.toBeNull();
    expect(row.transcriptSessions).toEqual([row.hook.sessionId]);
  }
});

test('an intervening successful edit does not erase the exact previous grant completion', () => {
  const f = fixture(); try {
    const guard = createPlanCountPermissionGuard(), input = () => guard(f.screen, '', f.epoch());
    f.record('PreToolUse', 'granted'); expect(input()).toBe('grant');
    f.record('PostToolUse', 'granted'); expect(input()).toBe('handled');
    f.record('PreToolUse', 'automatic'); f.record('PostToolUse', 'automatic');
    // Old pane is still inert, even after two successful results.
    expect(input()).toBe('handled');
    f.record('PreToolUse', 'next'); expect(input()).toBe('grant'); expect(input()).toBe('handled');
    expect(fs.readFileSync(f.file, 'utf8')).not.toContain('PRIVATE_');
  } finally { f.close(); }
});

test('an unrelated success cannot substitute for failed or missing prior approval completion', () => {
  for (const outcome of ['PostToolUseFailure', 'missing', 'foreign', 'other-path', 'sidechain']) {
    const f = fixture(); try {
      const guard = createPlanCountPermissionGuard(), input = () => guard(f.screen, '', f.epoch());
      f.record('PreToolUse', 'granted'); expect(input()).toBe('grant');
      if (outcome === 'PostToolUseFailure') f.record(outcome, 'granted');
      else if (outcome !== 'missing') f.record('PostToolUse', 'granted', outcome === 'foreign'
        ? { session_id: 'foreign' } : outcome === 'sidechain' ? { agent_id: 'child' }
        : { tool_input: { file_path: path.join(f.dir, 'other.md') } });
      f.record('PreToolUse', 'automatic'); f.record('PostToolUse', 'automatic');
      f.record('PreToolUse', 'next'); expect(input(), outcome).toBe('handled');
      f.record('PreToolUse', 'granted'); expect(input(), outcome).toBe('handled');
    } finally { f.close(); }
  }
});

test('success history rejects malformed, foreign, replayed, and pending IDs', () => {
  const f = fixture(); try {
    f.record('PreToolUse', 'first'); f.record('PostToolUse', 'first'); f.record('PreToolUse', 'next');
    const original = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    for (const completedIds of [['foreign:first'], ['main:../escape'], ['main:next'],
      ['main:first', 'main:first'], Array(129).fill('main:first'), ['main:unseen'], 'main:first']) {
      fs.writeFileSync(f.file, JSON.stringify({ ...original, completedIds }));
      expect(f.epoch()).toBeNull();
    }
  } finally { f.close(); }
});

test('success history is bounded by the existing 128-request recorder limit', () => {
  const f = fixture(); try {
    for (let i = 0; i < 127; i++) { f.record('PreToolUse', `id${i}`); f.record('PostToolUse', `id${i}`); }
    f.record('PreToolUse', 'last'); expect(f.epoch()?.completedIds?.length).toBe(127);
    expect(fs.statSync(f.file).size).toBeLessThan(64 * 1024);
    f.record('PreToolUse', 'overflow'); expect(f.epoch()).toBeNull();
  } finally { f.close(); }
});

test('cropped actual panes bind their full directory and basename to the current native epoch', () => {
  const rows = captured.rows.filter(row => [4, 5].includes(row.job) && !/^ {0,3}Edit file$/m.test(row.screen));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const f = fixture(); try {
      const screen = row.screen.replaceAll(path.dirname(row.hook.expected), path.dirname(f.expected))
        .replaceAll(path.basename(row.hook.expected), path.basename(f.expected));
      const read = (value = screen) => currentFilePermissionEpoch(f.file, f.expected, f.cwd, f.config,
        0, { status: 'ready', calls: [], assistantMessages: [{ sessionId: 'main', text: 'Reviewing', timestamp: new Date().toISOString() }] }, value);
      f.record('PreToolUse', 'current');
      expect(read()?.pendingId, row.attempt).toBe('main:current');
      const guard = createPlanCountPermissionGuard();
      expect(guard(screen, '', read())).toBe('grant');
      expect(guard(screen, '', read())).toBe('handled');
      for (const [name, changed] of [
        ['foreign', screen.replace(path.dirname(f.expected), path.join(f.dir, 'foreign'))],
        ['remedy', screen.replace(/always\s+allow\s+access\s+to/, 'remove files from')],
        ['footer', screen.replace('Esc to cancel · Tab to amend', '')],
        ['yes policy', screen.replace(/❯\s*1\.\s*Yes/, '❯ 1. Yes, change policy')],
        ['AUQ', '☐ Finding\n' + screen],
        ['quoted', '> Example:\n' + screen],
        ['wrapped path', screen.replace(path.dirname(f.expected), path.dirname(f.expected) + '\n/other')],
        ['path spaces', screen.replace(path.dirname(f.expected), path.dirname(f.expected) + ' space')],
      ]) {
        expect(changed, name).not.toBe(screen);
        expect(read(changed), name).toBeNull();
      }
      expect(read(screen.replace(path.dirname(f.expected), path.join(f.dir, 'foreign')))).toBeNull();
      f.record('PostToolUse', 'current'); expect(read()).toBeNull();
      f.record('PreToolUse', 'current'); expect(read()).toBeNull();
    } finally { f.close(); }
  }
});

test('the permission regression selects every existing count caller', () => {
  for (const file of ['test/plan-count-permission-ac.test.ts', 'test/fixtures/plan-count-permission-ac.json']) {
    for (const skill of ['design', 'ceo', 'devex', 'eng'])
      expect(selectTests([file], E2E_TOUCHFILES).selected).toContain(`plan-${skill}-finding-count`);
  }
});

test('a later exact owned binding wins over an earlier same-basename block', () => {
  const f = fixture(); try {
    f.record('PreToolUse', 'current');
    const transcript: any = {status:'ready', calls:[], assistantMessages:[{sessionId:'main', text:'Reviewing'}]};
    const foreign = {file:path.join(f.dir,'foreign-state.json'), expected:path.join(f.dir,'other','report.md')};
    const owned = {file:f.file, expected:f.expected};
    for (const bindings of [[foreign, owned], [owned, foreign]]) {
      const selected = currentFilePermissionBinding(bindings, f.cwd, f.config, 0, transcript, f.screen);
      expect(selected?.binding).toBe(owned);
      expect(selected?.epoch.pendingId).toBe('main:current');
    }
    const blocked = currentFilePermissionBinding([foreign, {...foreign, expected:path.join(f.dir,'another','report.md')}],
      f.cwd, f.config, 0, transcript, f.screen);
    expect(blocked).toBeNull();
    expect(createPlanCountPermissionGuard()(f.screen, '', blocked)).toBe('handled');
    const otherScreen = f.screen.replaceAll('report.md', 'OTHER.md');
    const unrelated = currentFilePermissionBinding([foreign, owned], f.cwd, f.config, 0, transcript, otherScreen);
    expect(unrelated).toBeUndefined();
    expect(createPlanCountPermissionGuard()(otherScreen, '', unrelated)).toBe('grant');
  } finally { f.close(); }
});

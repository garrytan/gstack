import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import captured from './fixtures/plan-count-permission-ac.json';
import capturedAd from './fixtures/plan-count-permission-ad.json';
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

// Exact current screens plus content-free native identity from the full AD run.
// The replay projections do not assert these pending writes ever completed.
const cases = capturedAd.rows.map(row => ({
  p: row, screen: row.screen, binding: {expected: row.state.expected, state: row.state},
  observation: {transcript: {status: row.transcriptStatus, calls: [],
    assistantMessages: row.transcriptSessions.map(sessionId => ({sessionId}))}},
}));
function adEpoch(c: any, screen = c.screen, state = c.binding.state, delta: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-crop-replay-'));
  const file = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(file, JSON.stringify(state));
    return currentFilePermissionEpoch(file, delta.expected ?? c.binding.expected, delta.cwd ?? c.p.cwd,
      delta.config ?? c.p.config, delta.startedAt ?? c.p.startUnix * 1000,
      delta.transcript ?? c.observation.transcript, screen);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
}
for (const c of cases) {
  test(`actual AD captured current permission ${c.p.pid} returns its exact pending epoch`, () => {
    expect(classifyPlanCountFrame(c.screen)).toBe('permission');
    expect(adEpoch(c)).toEqual({pendingId:c.binding.state.pendingId, completedId:c.binding.state.completedId,
      completedIds:c.binding.state.completedIds});
    const guard = createPlanCountPermissionGuard();
    expect(guard(c.screen, '', adEpoch(c))).toBe('grant');
    expect(guard(c.screen, '', adEpoch(c))).toBe('handled');
  });
  test(`AD isolating the rejected rendering guard ${c.p.pid} preserves native identity`, () => {
    // These are explicitly normalized controls; the actual captured screen is unchanged above.
    const normalized = c.p.pid === 1332470 ? c.screen.replace('3. Nohift+tab)', '3. No') : c.screen.replace(/^     \+/, ' 99 +');
    expect(normalized).not.toBe(c.screen);
    expect(adEpoch(c, normalized)?.pendingId).toBe(c.binding.state.pendingId);
  });
}
for (const c of cases) {
  test(`AD crop ${c.p.pid} rejects foreign, quoted, incomplete and policy-changing menus`, () => {
    const directory = path.dirname(c.binding.expected);
    const changes: [string, string][] = [
      ['foreign directory', c.screen.replace(directory, path.join(directory, 'foreign'))],
      ['split directory', c.screen.replace(directory, directory + '\n/foreign')],
      ['quoted', '> Example:\n' + c.screen],
      ['AUQ', '☐ Review\n' + c.screen],
      ['code fence', '```\n' + c.screen],
      ['missing footer', c.screen.replace('Esc to cancel · Tab to amend', '')],
      ['policy on selected Yes', c.screen.replace('❯ 1. Yes', '❯ 1. Yes, always allow')],
      ['selected No', c.screen.replace('❯ 1. Yes', '  1. Yes').replace('   3. No', ' ❯ 3. No')],
      ['arbitrary No suffix', c.screen.replace(/3\. No(?:hift\+tab\))?/, '3. No; run another command')],
      ['another hint', c.screen.replace(/3\. No(?:hift\+tab\))?/, '3. No(shift+enter)')],
      ['foreign option action', c.screen.replace(/always\s+allow\s+access\s+to/, 'delete files from')],
      ['unrecognized cropped prose', c.screen.replace(/^.*\n/, 'arbitrary text\n')],
    ];
    for (const [name, screen] of changes) {
      expect(screen, name).not.toBe(c.screen);
      expect(adEpoch(c, screen), name).not.toBeTruthy();
      expect(createPlanCountPermissionGuard()(screen, '', adEpoch(c, screen)), name).not.toBe('grant');
    }
  });
  test(`AD crop ${c.p.pid} leaves unrelated-basename permission policy unchanged`, () => {
    const screen = c.screen.replace(path.basename(c.binding.expected), 'OTHER.md');
    expect(adEpoch(c, screen)).toBeUndefined();
    // This is intentionally the existing caller policy for unrelated fixture permissions.
    expect(createPlanCountPermissionGuard()(screen, '', adEpoch(c, screen))).toBe('grant');
  });
  test(`AD crop ${c.p.pid} cannot replace missing, stale, completed or foreign native identity`, () => {
    const original = c.binding.state;
    for (const [name, state, delta] of [
      ['foreign session', {...original, sessionId:'foreign'}, {}],
      ['wrong native transcript', {...original, transcriptPath:path.join(c.p.config, 'projects', 'foreign', 'other.jsonl')}, {}],
      ['completed request', {...original, completedId:original.pendingId}, {}],
      ['no pending request', {...original, pendingId:null}, {}],
      ['unseen pending request', {...original, pendingId:original.sessionId + ':other'}, {}],
      ['stale timestamp', {...original, timestamp:new Date(c.p.startUnix * 1000 - 1).toISOString()}, {}],
      ['future timestamp', {...original, timestamp:new Date(Date.now() + 60_000).toISOString()}, {}],
      ['mixed sessions', original, {transcript:{status:'ready', calls:[], assistantMessages:[{sessionId:original.sessionId},{sessionId:'foreign'}]}}],
      ['unready transcript', original, {transcript:{...c.observation.transcript,status:'unavailable'}}],
    ] as const) {
      expect(adEpoch(c, c.screen, state, delta), name).toBeNull();
    }
  });
}

test('AD crop fixture selects the exact existing permission regression callers', () => {
  expect(selectTests(['test/fixtures/plan-count-permission-ad.json'], E2E_TOUCHFILES).selected.sort()).toEqual(
    selectTests(['test/fixtures/plan-count-permission-ac.json'], E2E_TOUCHFILES).selected.sort());
  expect(selectTests(['test/fixtures/plan-count-permission-ad.json'], E2E_TOUCHFILES).selected).toContain('plan-ceo-finding-count');
});

/**
 * plan-ceo-finding-floor, E2E Evals census 42252633016 paid-slice-7-a1 (main cf4d847e): the model rewrote its
 * owned working plan with Write, Claude Code showed a cropped "Do you want to overwrite ...?" diff, and no owned
 * binding came back, so the floor actor left the menu unanswered for 20 s (permission_unanswered). The overwrite
 * now binds like a cropped Create: to the sole pending owned Write, with every visible diff row checked against
 * the current file bytes ('-') and the pending content ('+' and unchanged rows).
 */
import {expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {createFilePermissionRecorder, recordFilePermission, currentFilePermissionEpoch} from './helpers/plan-count-file-permission';
import {readPlanCountTranscript} from './helpers/plan-count-transcript';
import {createPlanCountPermissionGuard} from './helpers/claude-pty-runner';
import captured from './fixtures/plan-ceo-floor-overwrite-permission.json';

const sessionId = '61cc3af3-2822-44d8-9003-f1ebf5696b47', id = 'toolu_013g2nXtwb4Kt8Jv8QSr4ku9';

function fixture(options: {before?: string; content?: string; hookContent?: string} = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overwrite-pane-')));
  const cwd = path.join(dir, 'cwd'), config = path.join(dir, 'config');
  fs.mkdirSync(cwd);
  const expected = path.join(cwd, captured.basename);
  fs.writeFileSync(expected, options.before ?? captured.before);
  const journal = path.join(config, 'projects', 'owned', sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(journal), {recursive: true});
  const recorder = createFilePermissionRecorder(cwd, config, expected)!;
  const startedAt = Date.now() - 1000, timestamp = new Date().toISOString();
  const input = {file_path: expected, content: options.content ?? captured.content};
  const block = {type: 'tool_use', id, name: 'Write', input};
  const native = (role: string, content: any[]) => ({cwd, sessionId, isSidechain: false, timestamp, message: {role, content}});
  const original = [native('assistant', [{type: 'text', text: 'Updating the working plan.'}, block])];
  const write = (rows: any[]) => fs.writeFileSync(journal, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  write(original);
  recordFilePermission(JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Write', session_id: sessionId,
    tool_use_id: id, cwd, transcript_path: journal, tool_input: {...input, content: options.hookContent ?? input.content}}),
    recorder.file, cwd, config, expected);
  const read = (screen = captured.screen) => currentFilePermissionEpoch(recorder.file, expected, cwd, config, startedAt,
    readPlanCountTranscript(config, cwd), screen);
  return {dir, cwd, expected, block, native, original, write, read,
    close() { recorder.dispose(); fs.rmSync(dir, {recursive: true, force: true}); }};
}

const lines = captured.screen.split('\n');
const replaceRow = (screen: string, from: string, to: string) => {
  expect(screen).toContain(from);
  return screen.replace(from, to);
};

test('the captured cropped overwrite binds the pending owned Write and grants once', () => {
  expect(lines[0]).toMatch(/^ {6}-oper evidence/);
  expect(captured.screen).toContain(' Do you want to overwrite gstack-test-plan-ceo-floor.md?');
  const f = fixture();
  try {
    const epoch = f.read();
    expect(epoch?.pendingId).toBe(`${sessionId}:${id}`);
    const guard = createPlanCountPermissionGuard();
    expect(guard(captured.screen, '', epoch)).toBe('grant');
    expect(guard(captured.screen, '', epoch)).toBe('handled');
  } finally { f.close(); }
});

test('a crop that starts on a numbered row, or on the rule above an uncropped diff, still binds', () => {
  const f = fixture();
  try {
    const from107 = captured.screen.slice(captured.screen.indexOf('  107 +'));
    expect(f.read(from107)?.pendingId).toBe(`${sessionId}:${id}`);
    const fromContext = captured.screen.slice(captured.screen.indexOf('  108  B)'));
    expect(f.read(fromContext)?.pendingId).toBe(`${sessionId}:${id}`);
  } finally { f.close(); }
});

test('a full Overwrite file heading names the owned path; a foreign same-basename heading blocks', () => {
  const f = fixture();
  try {
    const heading = (target: string) => ' Overwrite file\n ' + target + '\n' + captured.screen;
    expect(f.read(heading(captured.basename))?.pendingId).toBe(`${sessionId}:${id}`);
    expect(f.read(heading('../elsewhere/' + captured.basename))).toBeNull();
  } finally { f.close(); }
});

const screenNegatives: Array<[string, (screen: string) => string]> = [
  ['an added row that is not the pending content', s => replaceRow(s, 'Interview ~10 target developers', 'Interview ~12 target developers')],
  ['a deleted row that is not the current file', s => replaceRow(s, "  107 -Ship the cheaper tier on the team's", "  107 -Ship a cheaper tier on the team's")],
  ['an unchanged row that is not in either file', s => replaceRow(s, '  108  B) Launch now as written', '  108  B) Launch later')],
  ['a shifted line number', s => replaceRow(s, '  109 +Ship', '  110 +Ship')],
  ['a deleted row numbered as the next current line', s => replaceRow(s, '  112 -- Nothing', '  113 -- Nothing')],
  ['a leading tail that is not the anchored current line', s => s.replace('-oper evidence in 1-2 weeks', '-other evidence in 1-2 weeks')],
  ['a wrapped row under the wrong gutter', s => replaceRow(s, '      +eds.', '       +eds.')],
  ['a wrapped row whose marker differs from its numbered row', s => replaceRow(s, '      +eds.', '      -eds.')],
  ['a quoted pane', s => s.split('\n').map(row => '> ' + row).join('\n')],
  ['a Create prompt over an overwrite diff', s => replaceRow(s, 'Do you want to overwrite', 'Do you want to create')],
  ['a changed one-time action', s => replaceRow(s, '❯ 1. Yes', '❯ 2. Yes')],
  ['a missing footer', s => replaceRow(s, 'Esc to cancel · Tab to amend', '')],
];
for (const [name, change] of screenNegatives) test(`${name} cannot bind the overwrite`, () => {
  const f = fixture();
  try {
    const screen = change(captured.screen);
    expect(screen).not.toBe(captured.screen);
    const epoch = f.read(screen);
    expect(epoch).not.toBeTruthy();
    expect(createPlanCountPermissionGuard()(screen, '', epoch)).not.toBe('grant');
  } finally { f.close(); }
});

test('a foreign basename in the overwrite prompt leaves other permission policy alone', () => {
  const f = fixture();
  try { expect(f.read(captured.screen.replace('overwrite gstack-test-plan-ceo-floor.md?', 'overwrite other.md?'))).toBeUndefined(); }
  finally { f.close(); }
});

test('stale file bytes, a changed hook witness and an unchanged rewrite cannot bind', () => {
  const staleLine = (n: number) => captured.before.split('\n').map((line, i) => i === n - 1 ? line + ' (since changed)' : line).join('\n');
  for (const options of [{before: staleLine(107)}, {before: staleLine(106)}, {before: staleLine(105)},
    {hookContent: captured.content + 'extra'}, {content: captured.before, hookContent: captured.before}]) {
    const f = fixture(options);
    try { expect(f.read(), JSON.stringify(Object.keys(options))).toBeNull(); } finally { f.close(); }
  }
});

for (const variant of ['foreign-path', 'second-pending', 'completed', 'wrong-tool', 'wrong-session'])
  test(`an overwrite rejects ${variant} native identity`, () => {
    const f = fixture();
    try {
      const changed = structuredClone(f.block) as any;
      if (variant === 'foreign-path') changed.input.file_path = path.join(f.dir, captured.basename);
      if (variant === 'wrong-tool') changed.name = 'Edit';
      const rows: any[] = [f.native('assistant', [{type: 'text', text: 'Updating the working plan.'}, changed])];
      if (variant === 'second-pending') rows.push(f.native('assistant', [{...f.block, id: 'toolu_second'}]));
      if (variant === 'completed') rows.push(f.native('user', [{type: 'tool_result', tool_use_id: id, content: 'done'}]));
      if (variant === 'wrong-session') rows[0].sessionId = 'foreign';
      f.write(rows);
      expect(f.read()).toBeNull();
    } finally { f.close(); }
  });

test.skipIf(process.platform === 'win32')('a symlinked owned file cannot supply the current bytes', () => {
  const f = fixture();
  try {
    const target = path.join(f.dir, 'other.md');
    fs.renameSync(f.expected, target);
    fs.symlinkSync(target, f.expected);
    expect(f.read()).toBeNull();
  } finally { f.close(); }
});

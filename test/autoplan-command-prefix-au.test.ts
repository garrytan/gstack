import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fixture from './fixtures/autoplan-command-prefix-au.json';
import * as permission from './helpers/autoplan-artifact-permission';
import { readPendingAutoplanArtifact } from './helpers/autoplan-artifact-recorder';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import { E2E_TOUCHFILES, selectTests } from './helpers/touchfiles';

function replay() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ap-command-'));
  const old = path.dirname(path.dirname(fixture.stateRoot));
  const runtime = path.join(root, path.basename(old)), cwd = path.join(root, path.basename(fixture.cwd));
  const replace = (text: string) => text.replaceAll(old, runtime).replaceAll(fixture.cwd, cwd);
  const hook = JSON.parse(replace(JSON.stringify(fixture.hook)));
  const stateRoot = replace(fixture.stateRoot), config = replace(fixture.config), file = hook.pending.file;
  const events = JSON.parse(replace(JSON.stringify(fixture.publicTools))) as NativePublicToolEvent[];
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fixture.before, { mode: fixture.targetStat.mode });
  const mtime = Number(BigInt(fixture.targetStat.mtimeNs)) / 1e9;
  fs.utimesSync(file, mtime, mtime);
  fs.mkdirSync(path.dirname(hook.pending.transcriptPath), { recursive: true });
  const records = events.map(e => ({ sessionId: e.sessionId, cwd, isSidechain: false, timestamp: e.timestamp,
    requestId: e.requestId, message: { id: e.messageId, role: e.kind === 'use' ? 'assistant' : 'user',
      content: e.kind === 'use' ? [{ type: 'tool_use', id: e.toolUseId, name: e.name, input: e.input }]
        : [{ type: 'tool_result', tool_use_id: e.toolUseId, content: e.content, is_error: e.isError }] } }));
  fs.writeFileSync(hook.pending.transcriptPath, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const hookFile = path.join(root, 'hook.json'); fs.writeFileSync(hookFile, JSON.stringify(hook));
  const publicTools: NativePublicToolEvent[] = [];
  const transcript = readPlanCountTranscript(config, cwd, e => publicTools.push(e));
  const now = Date.parse(fixture.viewportCapturedAt), commandStartedAt = Date.parse(fixture.commandTimestamp);
  const pending = readPendingAutoplanArtifact(hookFile, cwd, config, stateRoot, commandStartedAt, publicTools, now, true);
  const context = { cwd, ownedStateRoot: stateRoot, ownedNativePlansRoot: path.join(config, 'plans'),
    commandStartedAt, now, viewportCapturedAt: now, transcriptStatus: transcript.status, publicTools, pending };
  return { root, file, context, viewport: replace(fixture.viewport), dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
type Replay = ReturnType<typeof replay>;
const pick = (r: Replay, seen = new Set<string>()) => permission.pendingAutoplanArtifactPermissionInput(r.viewport, r.context, seen);
const panel = (viewport: string) => viewport.slice(viewport.search(/^[─╌]{8,}\n {0,3}Edit file/m));

// Exact AY public native prefix; only its owned archive path is relocated onto
// this existing digest fixture. The unpublished Bash body is not reconstructed.
function nativeCards(r: Replay): string {
  const relative = path.relative(r.context.ownedStateRoot, r.file).split(path.sep).join('/');
  return [
    `● Update(~/.gstack/${relative})`, ' ', '● Updated plan', ' ', '● Updated plan', ' ',
    '● Bash(mkdir -p ~/.gstack/analytics',
    `      echo '{"skill":"plan-ceo-review","via":"autoplan","ts":"'$(date -u`,
    `      +%Y-%m-%dT%H:%M:%SZ)'","iterations":3,"issues_found":56,"issues_…)`,
    '  ⎿  Waiting…', '', '', '',
  ].join('\n') + panel(r.viewport);
}

test('native plan redraws and a queued command preserve only the digest-bound pending Edit', () => {
  const r = replay(); try {
    r.viewport = nativeCards(r);
    const granted = pick(r);
    expect(granted).toEqual({ input: '1\r', signature: `${r.context.pending!.sessionId}:${r.context.pending!.toolUseId}`, file: r.file });
    expect(permission.autoplanArtifactPermissionInput(r.viewport, r.context, new Set())).toBeNull();
    expect(permission.publishedAutoplanArtifactPermissionInput(r.viewport, r.context, new Set())).toBeNull();
    expect(pick(r, new Set([granted!.signature]))).toBeNull();
    expect(pick(r, new Set([permission.autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
  } finally { r.dispose(); }
});

const nativeScreens: Array<[string, (s: string) => string]> = [
  ['foreign Update title', s => s.replace('Update(~/.gstack/', 'Update(/foreign/')],
  ['unbound redraw', s => s.replace('● Updated plan', '● Updated another file')],
  ['second Update', s => s.replace('● Updated plan', '● Update(/foreign/plan.md)')],
  ['second Bash', s => s.replace('● Updated plan', '● Bash(echo another…)')],
  ['no native redraw', s => s.replaceAll('● Updated plan', '')],
  ['completed command', s => s.replace('Waiting…', 'Done')],
  ['missing Waiting marker', s => s.replace('  ⎿  Waiting…', '')],
  ['unclosed command card', s => s.replace('"issues_…)', '"issues_…')],
  ['unindented command continuation', s => s.replace('      echo ', 'echo ')],
  ['competing permission', s => s.replace('      echo ', '      Do you want to proceed? ')],
  ['indented native action', s => s.replace('      echo ', '      ● Read ')],
  ['indented question', s => s.replace('      echo ', '      ❯ 1. ')],
  ['source prefix', s => 'Source:\n' + s],
  ['quoted pane', s => s.split('\n').map(row => '> ' + row).join('\n')],
  ['code pane', s => '```text\n' + s + '\n```'],
  ['second edit panel', s => s + '\n' + panel(s)],
  ['foreign active panel', s => s.replace('projects/gstack-autoplan-chain-zmFsqo/', 'projects/foreign/')],
  ['foreign menu', s => s.replace('edit to 2026-09-10-user-dashboard.md?', 'edit to other.md?')],
  ['persistent approval', s => s.replace('❯ 1. Yes', '❯ 2. Yes')],
  ['changed digest-bound addition', s => s.replace('zero before advancing', 'ten before advancing')],
];
for (const [name, change] of nativeScreens) test(`native batch cards cannot hide another authority: ${name}`, () => {
  const r = replay(); try { r.viewport = change(nativeCards(r)); expect(pick(r)).toBeNull(); } finally { r.dispose(); }
});

test('the exact public command display preserves only the current unpublished Edit approval', () => {
  const r = replay(); try {
    expect(r.context.transcriptStatus).toBe('ready'); expect(r.context.publicTools).toHaveLength(2);
    expect(r.context.pending?.toolUseId).toBe(fixture.hook.pending.toolUseId);
    expect(r.context.publicTools.some(e => e.toolUseId === r.context.pending?.toolUseId)).toBe(false);
    expect(createHash('sha256').update(fs.readFileSync(r.file)).digest('hex')).toBe(fixture.provenance.beforeSHA256);
    expect(Math.floor(fs.statSync(r.file).mtimeMs)).toBe(Number(BigInt(fixture.targetStat.mtimeNs) / 1_000_000n));
    expect(permission.autoplanArtifactPermissionInput(r.viewport, r.context, new Set())).toBeNull();
    expect(permission.publishedAutoplanArtifactPermissionInput(r.viewport, r.context, new Set())).toBeNull();
    const expected = { input: '1\r', signature: `${fixture.hook.sessionId}:${fixture.hook.pending.toolUseId}`, file: r.file };
    expect(pick(r)).toEqual(expected);
    expect(pick(r, new Set([expected.signature]))).toBeNull();
    expect(pick(r, new Set([permission.autoplanArtifactMenuKey(r.viewport)]))).toBeNull();
    r.viewport = panel(r.viewport); expect(pick(r)).toEqual(expected);
    expect(fixture.provenance.paidOutcomesReclassified).toBe(false);
  } finally { r.dispose(); }
});

test('a plain native command description and wrapped display supply no command authority', () => {
  for (const prefix of ['● Recording review metrics\n  ⎿  $ echo recorded\n\n',
    '⏺ Running local diagnostics\n  ⎿  $ bun test\n     echo finished\n\n']) {
    const r = replay(); try { r.viewport = prefix + panel(r.viewport); expect(pick(r)?.input).toBe('1\r'); }
    finally { r.dispose(); }
  }
});

const screens: Array<[string, (s: string) => string]> = [
  ['source introduction', s => 'Source:\n' + s], ['example introduction', s => 'Example:\n' + s],
  ['whole quotation', s => s.split('\n').map(line => '> ' + line).join('\n')],
  ['whole code block', s => '```text\n' + s + '\n```'],
  ['quoted title', s => s.replace('● Appending spec-review metrics', '● "Appending spec-review metrics"')],
  ['source title', s => s.replace('● Appending spec-review metrics', '● Source: an example command')],
  ['second native action', s => s.replace('     echo logged', '● Another tool\n  ⎿  $ echo other')],
  ['indented second action', s => s.replace('     echo logged', '     ● Another tool')],
  ['Bash confirmation', s => s.replace('     echo logged', '     Do you want to proceed?')],
  ['Bash permission', s => s.replace('     echo logged', '     Bash command requires permission')],
  ['second question', s => s.replace('     echo logged', '     ❯ 1. Approve this command')],
  ['missing command marker', s => s.replace('⎿  $', '⎿   ')],
  ['unbound command prose', s => s.replace('     echo logged', 'Unrelated current prose')],
  ['second edit panel', s => s + '\n' + panel(s)],
  ['foreign panel path', s => s.replace('projects/gstack-autoplan-chain-zmFsqo/', 'projects/another-project/')],
  ['basename-only panel', s => s.replace(/^ …[^\n]+$/m, ' 2026-09-10-user-dashboard.md')],
  ['foreign menu target', s => s.replace('edit to 2026-09-10-user-dashboard.md?', 'edit to another.md?')],
  ['session approval cursor', s => s.replace('❯ 1. Yes', '❯ 2. Yes')],
  ['extra current prompt', s => s + '\nChoose another action'],
  ['changed added rows', s => s.replace('zero before advancing', 'ten before advancing')],
  ['removed-line gap', s => s.replace('  98 -', ' 100 -')],
  ['added-line gap', s => s.replace('  98 +', ' 100 +')],
  ['different reset start', s => s.replace('  97 +', '  96 +')],
  ['duplicate removed row', s => s.replace(/(^  98 -[^\n]*\n)/m, '$1$1')],
  ['duplicate added row', s => s.replace(/(^  98 \+[^\n]*\n)/m, '$1$1')],
  ['multiple resets', s => s.replace(' 108  5.', s.slice(s.indexOf('  97 -'), s.indexOf(' 108  5.')) + ' 108  5.')],
  ['truncated removed block', s => s.replace(/^  99 -[^\n]*\n/m, '')],
  ['truncated added block', s => s.replace(/^ 107 \+[^\n]*\n/m, '')],
  ['missing panel separator', s => s.replace(/^[─]{8,}\n/m, '')],
];
for (const [name, change] of screens) test(`current panel remains unambiguous: ${name}`, () => {
  const r = replay(); try { r.viewport = change(r.viewport); expect(pick(r)).toBeNull(); } finally { r.dispose(); }
});

const bindings: Array<[string, (r: Replay) => void]> = [
  ['missing hook', r => { r.context.pending = undefined; }],
  ['wrong hook tool', r => { r.context.pending!.tool = 'Write' as 'Edit'; }],
  ['foreign hook session', r => { r.context.pending!.sessionId = 'foreign'; }],
  ['foreign hook path', r => { r.context.pending!.file += '.other'; }],
  ['missing digest', r => { delete r.context.pending!.editDigest; }],
  ['invalid digest', r => { r.context.pending!.editDigest!.beforeSHA256 = 'invalid'; }],
  ['wrong before digest', r => { r.context.pending!.editDigest!.beforeSHA256 = '0'.repeat(64); }],
  ['wrong addition commitments', r => { r.context.pending!.editDigest!.newLineHashes.fill('0'.repeat(64)); }],
  ['current file changed', r => { fs.appendFileSync(r.file, '\nchanged'); fs.utimesSync(r.file, new Date(0), new Date(0)); }],
  ['file newer than pending', r => { fs.utimesSync(r.file, new Date(r.context.now), new Date(r.context.now)); }],
  ['history is Read', r => { r.context.publicTools[0]!.name = 'Read'; }],
  ['foreign history file', r => { r.context.publicTools[0]!.input!.file_path = r.file + '.other'; }],
  ['failed history', r => { r.context.publicTools[1]!.isError = true; }],
  ['unresolved mutation', r => { r.context.publicTools.pop(); }],
  ['published pending request', r => { r.context.publicTools.push({ kind: 'use', name: 'Edit', sessionId: r.context.pending!.sessionId,
    toolUseId: r.context.pending!.toolUseId, timestamp: r.context.pending!.timestamp, input: { file_path: r.file } }); }],
  ['missing transcript', r => { r.context.transcriptStatus = 'missing'; }],
  ['future hook', r => { r.context.pending!.timestamp = new Date(r.context.now + 1).toISOString(); }],
  ['viewport predates hook', r => { r.context.viewportCapturedAt = Date.parse(r.context.pending!.timestamp) - 1; }],
  ['command after hook', r => { r.context.commandStartedAt = Date.parse(r.context.pending!.timestamp) + 1; }],
];
for (const [name, change] of bindings) test(`pending authorization is retained: ${name}`, () => {
  const r = replay(); try { change(r); expect(pick(r)).toBeNull(); } finally { r.dispose(); }
});
for (const [name, change] of bindings) test(`native cards retain pending authorization: ${name}`, () => {
  const r = replay(); try { r.viewport = nativeCards(r); change(r); expect(pick(r)).toBeNull(); } finally { r.dispose(); }
});
test('only the Autoplan workflow selects this fixture and behavioral regression', () => {
  for (const file of ['test/autoplan-command-prefix-au.test.ts', 'test/fixtures/autoplan-command-prefix-au.json'])
    expect(selectTests([file], E2E_TOUCHFILES, []).selected).toEqual(['autoplan-chain-pty']);
});

test('removed row order is bound to both the current file and pending digest', () => {
  const r = replay(); try {
    const rows = r.viewport.split('\n'), a = rows.findIndex(row => /^  97 -/.test(row)), b = rows.findIndex(row => /^  98 -/.test(row));
    expect(a).toBeGreaterThan(0); expect(b).toBe(a + 1);
    const first = rows[a]!.slice(6), second = rows[b]!.slice(6);
    rows[a] = rows[a]!.slice(0, 6) + second; rows[b] = rows[b]!.slice(0, 6) + first;
    r.viewport = rows.join('\n'); expect(pick(r)).toBeNull();
  } finally { r.dispose(); }
});

test('added row order is bound to the complete pending replacement digest', () => {
  const r = replay(); try {
    const rows = r.viewport.split('\n'), a = rows.findIndex(row => /^  97 \+/.test(row)), b = rows.findIndex(row => /^  98 \+/.test(row));
    expect(a).toBeGreaterThan(0); expect(b).toBe(a + 1);
    const first = rows[a]!.slice(6), second = rows[b]!.slice(6);
    rows[a] = rows[a]!.slice(0, 6) + second; rows[b] = rows[b]!.slice(0, 6) + first;
    r.viewport = rows.join('\n'); expect(pick(r)).toBeNull();
  } finally { r.dispose(); }
});

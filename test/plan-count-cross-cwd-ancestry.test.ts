import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPlanCountTranscript, readOwnedClaudePublicTranscript, type NativePublicToolEvent } from '../lib/claude-public-transcript';
import captured from './fixtures/plan-count-cross-cwd-ancestry-0bcd.json';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const targetAck = (events: NativePublicToolEvent[]) => events.find(e => e.kind === 'result' && e.toolUseId === captured.toolUseId);
function rows(): any[] {
  return captured.ancestry.map(([index, id, parent, type, timestamp, role, logicalParent, subtype]) => {
    const publicRecord = (captured.publicRecords as Record<string, unknown>)[id as string];
    if (publicRecord) return structuredClone(publicRecord);
    return { sessionId: captured.sessionId, cwd: captured.cwd, isSidechain: false,
      uuid: id, parentUuid: parent, type, timestamp,
      ...(role ? { message: { role, content: [] } } : {}),
      ...(logicalParent ? { logicalParentUuid: logicalParent } : {}), ...(subtype ? { subtype } : {}) };
  });
}
function read(records: any[], opts: { partial?: boolean; cwd?: string; exactParent?: boolean } = {}) {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-cwd-ancestry-')); dirs.push(config);
  const project = path.join(config, 'projects', 'owned'); fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, captured.sessionId + '.jsonl');
  const bytes = records.map(r => JSON.stringify(r)).join('\n') + (opts.partial ? '' : '\n');
  fs.writeFileSync(file, bytes);
  const events: NativePublicToolEvent[] = [];
  const transcript = readPlanCountTranscript(config, opts.cwd ?? captured.cwd, event => events.push(event),
    opts.exactParent ? file : undefined);
  expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  return { transcript, events, file };
}

for (const exactParent of [false, true]) test(`actual delayed attachments retain the first changed-cwd ACK (exact parent ${exactParent})`, () => {
  const got = read(rows(), { exactParent });
  expect(got.transcript.status).toBe('ready');
  expect(got.events.map(e => [e.kind, e.toolUseId])).toEqual([['use', captured.toolUseId], ['result', captured.toolUseId]]);
  const owned = readOwnedClaudePublicTranscript(got.file, captured.cwd, captured.sessionId);
  expect(got.events).toEqual(owned.events.filter(e => e.kind === 'use' || e.kind === 'result').map(({ order, ...event }) => event));
  expect(targetAck(got.events)?.isError).toBe(false);
});

test('metadata attachment order does not change the physical public event sequence', () => {
  const physical = rows(), byId = new Map(physical.map(r => [r.uuid, r]));
  const causal: any[] = [], seen = new Set<string>();
  const visit = (r: any) => { if (seen.has(r.uuid)) return; const p = byId.get(r.parentUuid ?? r.logicalParentUuid);
    if (p) visit(p); seen.add(r.uuid); causal.push(r); };
  for (const r of physical) visit(r);
  expect(read(physical).events).toEqual(read(causal).events);
});

const root = (r: any[]) => r.find(x => x.uuid === captured.rootUuid);
const link = (r: any[]) => r.find(x => x.uuid === '4f6d5f5c-ca8f-44a8-8b89-d62450e47d71');
const target = (r: any[]) => r.find(x => x.message?.content?.some((b: any) => b.type === 'tool_result' && b.tool_use_id === captured.toolUseId));
for (const [name, change] of Object.entries({
  'missing root': (r: any[]) => r.splice(r.findIndex(x => x.uuid === captured.rootUuid), 1),
  'foreign root cwd': (r: any[]) => root(r).cwd = '/unrelated/fixture',
  'sidechain root': (r: any[]) => root(r).isSidechain = true,
  'agent root': (r: any[]) => root(r).agentId = 'reviewer-child',
  'invalid root timestamp': (r: any[]) => root(r).timestamp = 'invalid',
  'non-root first user': (r: any[]) => root(r).parentUuid = uuid(90),
  'missing attachment': (r: any[]) => r.splice(r.indexOf(link(r)), 1),
  'foreign attachment session': (r: any[]) => link(r).sessionId = 'foreign-session',
  'sidechain attachment': (r: any[]) => link(r).isSidechain = true,
  'agent attachment': (r: any[]) => link(r).agentId = 'reviewer-child',
  'dangling attachment': (r: any[]) => link(r).parentUuid = uuid(90),
  'cyclic attachment': (r: any[]) => link(r).parentUuid = '0ae7209c-50bf-426f-83de-d60f1afdd027',
  'duplicate UUID': (r: any[]) => r.push(structuredClone(link(r))),
  'competing root': (r: any[]) => r.push({ ...root(r), uuid: uuid(91) }),
  'missing compaction parent': (r: any[]) => delete r.find(x => x.subtype === 'compact_boundary').logicalParentUuid,
  'foreign target session': (r: any[]) => target(r).sessionId = 'foreign-session',
  'sidechain target': (r: any[]) => target(r).isSidechain = true,
  'agent target': (r: any[]) => target(r).agentId = 'reviewer-child',
  'unrelated target parent': (r: any[]) => target(r).parentUuid = uuid(92),
  'invalid target UUID': (r: any[]) => target(r).uuid = 'not-native',
  'relative target cwd': (r: any[]) => target(r).cwd = 'relative',
  'invalid target timestamp': (r: any[]) => target(r).timestamp = 'invalid',
})) test(`${name} cannot supply the lost cross-cwd ACK`, () => {
  const r = rows(); change(r); expect(targetAck(read(r).events)).toBeUndefined();
});

test('an unrelated requested fixture cannot acquire the cross-cwd continuation', () => {
  expect(targetAck(read(rows(), { cwd: '/unrelated/fixture' }).events)).toBeUndefined();
});
test('a complete JSON ACK without its terminating newline remains unpublished', () => {
  expect(targetAck(read(rows(), { partial: true }).events)).toBeUndefined();
});
test('invalid strict ancestry supplies no recovery and preserves the prior ordinary projection', () => {
  const r = rows(); r.push(structuredClone(link(r))); const got = read(r);
  expect(got.transcript.status).toBe('ready'); expect(got.transcript.calls).toEqual([]);
  expect(got.transcript.assistantMessages).toEqual([]); expect(targetAck(got.events)).toBeUndefined();
  expect(got.events.map(e => e.kind)).toEqual(['use']);
});

// Controlled question records exercise existing acknowledgement semantics, not
// the captured Bash result's meaning. Only metadata membership is repaired.
function questions() {
  const record = (n: number, parent: number | null, role?: string, content: unknown[] = [], cwd = captured.cwd): any => ({
    sessionId: captured.sessionId, cwd, isSidechain: false, uuid: uuid(n), parentUuid: parent === null ? null : uuid(parent),
    timestamp: '2026-09-17T09:07:15.754Z', type: role ?? 'attachment', ...(role ? { message: { role, content } } : {}) });
  const question = { header: 'Decision', question: 'Choose the owned change?', options: [{ label: 'A' }, { label: 'B' }] };
  const use = record(4, 3, 'assistant', [{ type: 'tool_use', id: 'controlled-question', name: 'AskUserQuestion', input: { questions: [question] } }]);
  const result = { ...record(5, 4, 'user', [{ type: 'tool_result', tool_use_id: 'controlled-question', content: 'Answered.' }], '/owned/changed-directory'),
    toolUseResult: { answers: { [question.question]: 'A' } } };
  return [record(1, null, 'user'), record(3, 2), record(2, 1), use, result];
}
test('owned changed-cwd question ACK remains an actual answer to one native call', () => {
  const t = read(questions()).transcript;
  expect(t.calls).toHaveLength(1); expect(t.calls[0].answered).toBe(true); expect(t.calls[0].answers).toEqual({ 'Choose the owned change?': 'A' });
});
test('ownership recovery does not sort a physically earlier result into answer credit', () => {
  const r = questions(); [r[3], r[4]] = [r[4], r[3]];
  const got = read(r); expect(got.events.map(e => e.kind)).toEqual(['result', 'use']);
  expect(got.transcript.calls).toHaveLength(1); expect(got.transcript.calls[0].answered).toBe(false);
});
test('a failed changed-cwd native result remains failed', () => {
  const r = questions(); r[4].message.content[0].is_error = true;
  const call = read(r).transcript.calls[0]; expect(call.answered).toBe(false); expect(call.failed).toBe(true);
});
test('unrelated or child branches do not gain membership from the repaired parent', () => {
  for (const change of ['parent', 'agent', 'session', 'sidechain']) {
    const r = questions(), foreign = structuredClone(r[4]); foreign.uuid = uuid(99);
    foreign.message.content = [{ type: 'tool_use', id: 'foreign', name: 'Read', input: { file_path: '/unrelated' } }]; foreign.message.role = 'assistant';
    if (change === 'parent') foreign.parentUuid = uuid(98);
    if (change === 'agent') foreign.agentId = 'child';
    if (change === 'session') foreign.sessionId = 'foreign';
    if (change === 'sidechain') foreign.isSidechain = true;
    r.push(foreign); const got = read(r); expect(got.events.some(e => e.toolUseId === 'foreign')).toBe(false);
    expect(got.transcript.calls[0].answered).toBe(true);
  }
});
test('repeated exact-cwd legacy records with UUIDs but no ancestry retain their existing answer', () => {
  const r = questions().slice(3).map(x => { x.cwd = captured.cwd; delete x.parentUuid; return x; });
  const got = read([...r, ...r]); expect(got.transcript.status).toBe('ready');
  expect(got.transcript.calls).toHaveLength(1); expect(got.transcript.calls[0].answered).toBe(true);
});

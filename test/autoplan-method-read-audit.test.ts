import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareMethodology, createSnapshot } from '../bin/gstack-autoplan-snapshot';
import { auditAutoplanMethodReads, loadAutoplanMethodologyBinding, prematureAutoplanPhaseEntry, registerAutoplanPhaseInstructionAliases,
  type AutoplanPhaseInstruction } from './helpers/autoplan-method-read-audit';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import recorded from './fixtures/autoplan-method-read-aa-events.json';
import phaseEntry from './fixtures/autoplan-phase-entry-cf74.json';
import aliasEntry from './fixtures/autoplan-phase-entry-alias-f359.json';
import homeEntry from './fixtures/autoplan-home-phase-entry-fb10.json';
const ROOT = resolve(import.meta.dir, '..');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const events = () => clone(recorded.events) as NativePublicToolEvent[];
const binding = () => clone(recorded.binding);
function complete(): NativePublicToolEvent[] {
  const list = events();
  const last = list.pop()!;
  const common = { sessionId: last.sessionId, toolUseId: 'synthetic-tail-repair-before-dispatch' };
  list.push({ ...common, kind: 'use', timestamp: '2026-09-09T12:58:00.000Z', name: 'Read',
    input: { file_path: recorded.binding.path, offset: 2200, limit: 60 } });
  list.push({ ...common, kind: 'result', timestamp: '2026-09-09T12:58:00.020Z', isError: false,
    file: { filePath: recorded.binding.path, startLine: 2200, numLines: 60, totalLines: 2259,
      content: recorded.binding.content.split('\n').slice(2199).join('\n') } });
  list.push(last); return list;
}
const audit = (list = events()) => auditAutoplanMethodReads(list, binding)[0]!;
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('actual AA parent methodology delivery boundary', () => {
  test('actual six full-content ranges miss the tail at the actual dispatch', () => {
    const actual = audit();
    expect(actual.passed).toBe(false);
    expect(actual.ranges).toHaveLength(6);
    expect(actual.missing).toEqual([{ startLine: 2200, endLine: 2259 }]);
    expect(actual.at).toBe('2026-09-09T12:59:34.639Z');
  });
  test('explicitly synthetic final range repair before dispatch completes the same content', () => {
    const fixed = audit(complete());
    expect(fixed.passed).toBe(true);
    expect(fixed.missing).toEqual([]);
    expect(fixed.ranges.at(-1)).toMatchObject({ startLine: 2200, endLine: 2259 });
  });
  test('a later result, foreign session, wrong path, error, or unpaired result supplies no tail', () => {
    for (const change of ['later', 'foreign-session', 'wrong-path', 'error', 'unpaired']) {
      const list = complete(); const result = list.at(-2)!;
      if (change === 'later') { list.splice(list.length - 2, 1); list.push(result); }
      if (change === 'foreign-session') result.sessionId = 'different-parent';
      if (change === 'wrong-path') (result.file as any).filePath += '.other';
      if (change === 'error') result.isError = true;
      if (change === 'unpaired') result.toolUseId += '-orphan';
      expect(audit(list).passed, change).toBe(false);
    }
  });
  test('matching ranges/hash claims cannot replace exact delivered bytes or EOF accounting', () => {
    for (const change of ['content', 'missing-eof', 'total', 'start', 'limit']) {
      const list = complete(); const result = list.at(-2)!; const file = result.file as any;
      if (change === 'content') file.content = file.content.replace('MODE COMPARISON', 'METHOD COMPLETE');
      if (change === 'missing-eof') { file.content = file.content.slice(0, -1); file.numLines--; }
      if (change === 'total') file.totalLines--;
      if (change === 'start') file.startLine--;
      if (change === 'limit') list.at(-3)!.input!.limit = 59;
      expect(audit(list).passed, change).toBe(false);
    }
  });
  test('malformed dispatch identities/timestamps and empty Read IDs cannot supply coverage', () => {
    for (const change of ['timestamp', 'session', 'dispatch-id', 'read-id']) {
      const list = complete();
      if (change === 'timestamp') list.at(-1)!.timestamp = 'not-a-timestamp';
      if (change === 'session') for (const event of list) event.sessionId = '';
      if (change === 'dispatch-id') list.at(-1)!.toolUseId = ' ';
      if (change === 'read-id') list.at(-3)!.toolUseId = list.at(-2)!.toolUseId = '';
      expect(audit(list).passed, change).toBe(false);
    }
  });
  test('conflicting same-ID results fail; identical repeated records add no extra credit', () => {
    const list = complete(); list.splice(list.length - 1, 0, clone(list.at(-2)!));
    expect(audit(list).passed).toBe(true);
    (list.at(-2)!.file as any).content += 'altered';
    expect(audit(list).passed).toBe(false);
    expect(audit(list).error).toContain('Conflicting');
  });
  test('self-report, child reads and backward request/result chronology do not fill the gap', () => {
    const list = complete(); list.at(-2)!.timestamp = '2026-09-09T12:57:00.000Z';
    expect(audit(list).passed).toBe(false);
    const child = complete(); child.at(-3)!.sessionId = child.at(-2)!.sessionId = 'child';
    expect(audit(child).passed).toBe(false);
    const claim = events(); claim.splice(claim.length - 1, 0, { sessionId: recorded.events[0]!.sessionId,
      timestamp: '2026-09-09T12:59:00.000Z', toolUseId: 'claim', kind: 'result',
      content: 'Methodology read completely (lines 1-2259); sha256 ' + recorded.binding.sha256 });
    expect(audit(claim).passed).toBe(false);
  });
  test('existing owned native transcript filter projects public tool content only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gstack-method-events-')); owned.push(dir);
    const cwd = '/fixture/cwd'; const project = join(dir, 'projects', 'fixture'); mkdirSync(project, { recursive: true });
    const records = complete().map(event => ({ cwd, isSidechain: false, sessionId: event.sessionId,
      timestamp: event.timestamp, message: { role: event.kind === 'use' ? 'assistant' : 'user', content: [event.kind === 'use'
        ? { type: 'tool_use', id: event.toolUseId, name: event.name, input: event.input }
        : { type: 'tool_result', tool_use_id: event.toolUseId, is_error: event.isError, content: event.content ?? '' }] },
      toolUseResult: event.kind === 'result' ? { file: event.file } : undefined }));
    const text = records.map(row => JSON.stringify(row)).join('\n') + '\n';
    const native = join(project, `${recorded.events[0]!.sessionId}.jsonl`); writeFileSync(native, text);
    const projection: NativePublicToolEvent[] = []; const transcript = readPlanCountTranscript(dir, cwd, e => projection.push(e));
    expect(transcript.status).toBe('ready'); expect(audit(projection).passed).toBe(true);
    writeFileSync(native, records.map(row => JSON.stringify({ ...row, isSidechain: true })).join('\n') + '\n');
    const foreign: NativePublicToolEvent[] = []; readPlanCountTranscript(dir, cwd, e => foreign.push(e));
    expect(foreign).toEqual([]);
    writeFileSync(native, text.slice(0, text.lastIndexOf('\n', text.length - 2) + 1) + '{"incomplete":');
    const partial: NativePublicToolEvent[] = []; readPlanCountTranscript(dir, cwd, e => partial.push(e));
    expect(auditAutoplanMethodReads(partial, binding)).toEqual([]);
  });
});

describe('actual immutable snapshot methodology binding', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'gstack-method-binding-')); owned.push(dir);
    const restore = join(dir, 'restore.md'); const active = join(dir, 'active.md');
    writeFileSync(restore, '# Original\n'); writeFileSync(active, '## Implementation plan\n# Original\n\n## Review record\n');
    const method = prepareMethodology('ceo', join(ROOT, 'plan-ceo-review/SKILL.md'), restore);
    const snapshot = createSnapshot('ceo', active, restore, method.methodologyPath);
    return { dir, method, snapshot };
  }
  test('dispatch binds actual immutable snapshot/method bytes independent of filtered helper stdout', () => {
    const f = fixture(); const result = loadAutoplanMethodologyBinding(f.snapshot.nativeDispatchPrompt, [f.dir]);
    expect(result.sha256).toBe(f.method.sha256); expect(result.content).toBe(readFileSync(f.method.methodologyPath, 'utf8'));
    expect(result.lines).toBe(f.method.lines);
    expect(() => loadAutoplanMethodologyBinding(f.snapshot.nativeDispatchPrompt.replace('CEO', 'DESIGN'), [f.dir])).toThrow();
    const other = fixture(); expect(() => loadAutoplanMethodologyBinding(f.snapshot.nativeDispatchPrompt, [other.dir])).toThrow();
  });
  test('mutable or altered snapshot/method data cannot supply valid dispatch coverage', () => {
    for (const kind of ['mutable', 'native', 'method', 'manifest']) {
      const f = fixture(); const target = kind === 'native' ? f.snapshot.nativePromptPath : kind === 'manifest'
        ? join(f.method.methodologyPath, '..', 'methodology.json') : f.method.methodologyPath;
      chmodSync(target, 0o600);
      if (kind !== 'mutable') { writeFileSync(target, readFileSync(target, 'utf8') + 'tamper'); chmodSync(target, 0o444); }
      if (kind === 'mutable') {
        if (process.platform !== 'win32') expect(() => loadAutoplanMethodologyBinding(f.snapshot.nativeDispatchPrompt, [f.dir]), kind).toThrow();
        // Windows does not use POSIX permission bits. Exercise that policy in
        // an isolated process with observed modes, keeping actual artifact
        // paths/bytes and both the immutable control and writable rejection.
        const worker = join(f.dir, 'observed-mode.ts');
        writeFileSync(worker, `import { mock } from 'bun:test';
const real = { ...await import('node:fs') };
await import('node:path');
const input = JSON.parse(await Bun.stdin.text());
Object.defineProperty(process, 'platform', { value: 'linux' });
mock.module('node:fs', () => ({ ...real, lstatSync(file) {
  const stat = real.lstatSync(file);
  stat.mode = (stat.mode & ~0o777) | (file === input.target && input.writable ? 0o600 : 0o444);
  return stat;
} }));
const { loadAutoplanMethodologyBinding } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'test/helpers/autoplan-method-read-audit.ts')).href)});
loadAutoplanMethodologyBinding(input.prompt, input.roots);
`);
        for (const writable of [false, true]) {
          const result = spawnSync(process.execPath, [worker], { encoding: 'utf8', timeout: 10_000,
            input: JSON.stringify({ prompt: f.snapshot.nativeDispatchPrompt, roots: [f.dir], target, writable }) });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(writable ? 1 : 0);
          if (writable) expect(result.stderr).toContain('Artifact is not immutable bounded regular data');
        }
      } else {
        expect(() => loadAutoplanMethodologyBinding(f.snapshot.nativeDispatchPrompt, [f.dir]), kind).toThrow();
      }
    }
  });
});

describe('completed parent phase-instruction Reads require an earlier published report', () => {
  function entryFixture() {
    const events = clone(phaseEntry.events) as NativePublicToolEvent[];
    const transcript = { status: 'ready' as const, calls: [], assistantMessages: clone(phaseEntry.assistantMessages) };
    const file = events[1]!.file as { filePath: string; content: string };
    const instruction: AutoplanPhaseInstruction = { phase: 'design', requiredPhase: 1,
      paths: [file.filePath], content: file.content };
    const at = Date.parse(events[0]!.timestamp);
    const startedAt = Date.parse(transcript.assistantMessages[0]!.timestamp);
    const addReport = (delta: number, sessionId = events[0]!.sessionId) => transcript.assistantMessages.push({
      sessionId, timestamp: new Date(at + delta).toISOString(), text: 'Phase 1 complete.' });
    return { events, transcript, instruction, at, startedAt, addReport,
      audit: () => prematureAutoplanPhaseEntry(events, transcript, [instruction], startedAt) };
  }
  test('the exact cf74 completed Design Read fails despite successful full CEO export readback', () => {
    const f = entryFixture();
    expect(phaseEntry.originalOutcome).toContain('root cancellation, no Bun verdict invented');
    expect(phaseEntry.readback.equalsCurrentExport).toBe(true);
    expect(f.audit()).toMatchObject({ phase: 'design', requiredPhase: 1,
      readToolUseId: 'toolu_01XvX1QbuKqv1xWjpdHsFLnj', readAt: '2026-09-16T01:28:04.501Z' });
  });
  test.each([-1, 0, 1, 1000])('a report at request %+d ms preserves its actual temporal meaning', delta => {
    const f = entryFixture(); f.addReport(delta);
    // Equality is indeterminate, not evidence of ordering. Neither null result
    // nor this early abort adds a completion to the unchanged end assertions.
    expect(f.audit() === null).toBe(delta <= 0);
    if (delta > 0) expect(f.audit()!.reportAt).toBe(new Date(f.at + delta).toISOString());
  });
  test('another parent session or source/future text cannot supply the required report', () => {
    const f = entryFixture(); f.addReport(-1, 'different-session');
    expect(f.audit()).not.toBeNull();
    f.transcript.assistantMessages.push({ sessionId: f.events[0]!.sessionId,
      timestamp: new Date(f.at - 1).toISOString(), text: '```text\nPhase 1 complete.\n```\nI will publish after Design.' });
    expect(f.audit()).not.toBeNull();
  });
  test.each(['foreign-request', 'foreign-result', 'foreign-session', 'unpaired', 'missing-result', 'missing-use',
    'error', 'unknown-status', 'backward-time', 'backward-order', 'stale', 'content', 'total', 'offset', 'limit',
    'empty-id', 'invalid-time', 'conflicting-result', 'conflicting-request'] as const)
  ('%s does not establish an owned successful phase entry', change => {
    const f = entryFixture(), use = f.events[0]!, result = f.events[1]!, file = result.file as any;
    if (change === 'foreign-request') use.input!.file_path = '/foreign/autoplan/sections/design-phase.md';
    if (change === 'foreign-result') file.filePath = '/foreign/autoplan/sections/design-phase.md';
    if (change === 'foreign-session') result.sessionId = 'other';
    if (change === 'unpaired') result.toolUseId += '-other';
    if (change === 'missing-result') f.events.pop();
    if (change === 'missing-use') f.events.shift();
    if (change === 'error') result.isError = true;
    if (change === 'unknown-status') delete result.isError;
    if (change === 'backward-time') result.timestamp = new Date(f.at - 1).toISOString();
    if (change === 'backward-order') f.events.reverse();
    if (change === 'stale') use.timestamp = new Date(f.startedAt - 1).toISOString();
    if (change === 'content') file.content += 'Changed';
    if (change === 'total') file.totalLines++;
    if (change === 'offset') use.input!.offset = 2;
    if (change === 'limit') use.input!.limit = 1;
    if (change === 'empty-id') use.toolUseId = result.toolUseId = '';
    if (change === 'invalid-time') use.timestamp = 'invalid';
    if (change === 'conflicting-result') f.events.push({ ...result, isError: true });
    if (change === 'conflicting-request') f.events.unshift({ ...use, input: { file_path: '/foreign/design-phase.md' } });
    expect(f.audit()).toBeNull();
  });
  test('identical duplicate records and a successful partial source Read still establish entry', () => {
    const f = entryFixture(); f.events.push(clone(f.events[1]!));
    expect(f.audit()).not.toBeNull();
    const partial = entryFixture(), file = partial.events[1]!.file as any;
    partial.events[0]!.input!.offset = file.startLine = 2;
    partial.events[0]!.input!.limit = file.numLines = 3;
    file.content = partial.instruction.content.split('\n').slice(1, 4).join('\n');
    expect(partial.audit()).not.toBeNull();
  });
  test.each([['design', 1], ['dx', 2], ['eng', 2.5]] as const)
  ('current %s instruction is bound to required phase %s', (phase, requiredPhase) => {
    const f = entryFixture(), path = join(ROOT, 'autoplan', 'sections', `${phase}-phase.md`);
    f.instruction = { phase, requiredPhase, paths: [path], content: readFileSync(path, 'utf8') };
    f.events[0]!.input = { file_path: path };
    f.events[1]!.file = { filePath: path, content: f.instruction.content, startLine: 1,
      numLines: f.instruction.content.split('\n').length, totalLines: f.instruction.content.split('\n').length };
    expect(prematureAutoplanPhaseEntry(f.events, f.transcript, [f.instruction], f.startedAt))
      .toMatchObject({ phase, requiredPhase });
    f.transcript.assistantMessages.push({ sessionId: f.events[0]!.sessionId,
      timestamp: new Date(f.at - 1).toISOString(), text: `Phase ${requiredPhase} complete.` });
    expect(prematureAutoplanPhaseEntry(f.events, f.transcript, [f.instruction], f.startedAt)).toBeNull();
  });
  test('the existing native parent reader excludes child and foreign-cwd phase Reads', () => {
    const f = entryFixture(), dir = mkdtempSync(join(tmpdir(), 'gstack-phase-entry-')); owned.push(dir);
    const project = join(dir, 'projects', 'fixture'); mkdirSync(project, { recursive: true });
    const cwd = '/owned/fixture';
    const rows = f.events.map(event => ({ cwd, isSidechain: false, sessionId: event.sessionId,
      timestamp: event.timestamp, message: { role: event.kind === 'use' ? 'assistant' : 'user', content: [event.kind === 'use'
        ? { type: 'tool_use', id: event.toolUseId, name: event.name, input: event.input }
        : { type: 'tool_result', tool_use_id: event.toolUseId, is_error: event.isError, content: event.content }] },
      toolUseResult: event.kind === 'result' ? { file: event.file } : undefined }));
    const journal = join(project, `${f.events[0]!.sessionId}.jsonl`);
    for (const variant of ['parent', 'child', 'foreign-cwd']) {
      writeFileSync(journal, rows.map(row => JSON.stringify({ ...row,
        ...(variant === 'child' ? { isSidechain: true } : {}),
        ...(variant === 'foreign-cwd' ? { cwd: '/other/fixture' } : {}) })).join('\n') + '\n');
      const projected: NativePublicToolEvent[] = [];
      const transcript = readPlanCountTranscript(dir, cwd, event => projected.push(event));
      expect(prematureAutoplanPhaseEntry(projected, transcript, [f.instruction], f.startedAt) !== null).toBe(variant === 'parent');
    }
  });
});

describe('owned installed phase aliases use the actual chain registration', () => {
  function aliasFixture(phase: AutoplanPhaseInstruction['phase'] = 'design') {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gstack-phase-alias-'))); owned.push(dir);
    const source = join(dir, 'source', 'autoplan'), config = join(dir, '.claude');
    const canonical = join(source, 'sections', `${phase}-phase.md`);
    const content = readFileSync(join(ROOT, 'autoplan', 'sections', `${phase}-phase.md`), 'utf8');
    // Populate the owned source before installing links; never write through a registration.
    mkdirSync(join(source, 'sections'), { recursive: true }); writeFileSync(canonical, content);
    mkdirSync(join(config, 'skills', 'gstack'), { recursive: true });
    const short = join(config, 'skills', 'autoplan'), legacy = join(config, 'skills', 'gstack', 'autoplan');
    for (const alias of [short, legacy]) symlinkSync(source, alias, 'junction');
    const events = clone(aliasEntry.events) as NativePublicToolEvent[];
    const transcript = { status: 'ready' as const, calls: [], assistantMessages: clone(aliasEntry.assistantMessages) };
    const instruction: AutoplanPhaseInstruction = { phase, requiredPhase: phase === 'design' ? 1 : phase === 'dx' ? 2 : 2.5,
      paths: [canonical], content };
    const usePath = (filePath: string) => {
      events[0]!.input!.file_path = filePath;
      events[1]!.file = { ...(events[1]!.file as object), filePath, content,
        numLines: content.split('\n').length, totalLines: content.split('\n').length };
    };
    usePath(join(short, 'sections', `${phase}-phase.md`));
    const register = () => registerAutoplanPhaseInstructionAliases([instruction], config);
    const startedAt = Date.parse(transcript.assistantMessages[0]!.timestamp);
    const audit = () => prematureAutoplanPhaseEntry(events, transcript, [instruction], startedAt);
    return { dir, source, config, canonical, short, legacy, instruction, events, transcript, startedAt, register, usePath, audit };
  }
  test('the retained f359 short alias Read/ACK establishes the missed premature Design entry', () => {
    const f = aliasFixture();
    expect(createHash('sha256').update(f.instruction.content).digest('hex')).toBe(aliasEntry.sourceSha256);
    expect(f.instruction.content).toBe((aliasEntry.events[1]!.file as { content: string }).content);
    expect(f.transcript.assistantMessages).toHaveLength(34);
    expect(f.audit()).toBeNull(); // Canonical alone reproduces the actual unregistered path.
    f.register();
    expect(f.audit()).toMatchObject({ phase: 'design', requiredPhase: 1,
      sessionId: '45abf2fa-0d62-471f-9efa-9a0d5b2ec1b5', readToolUseId: 'toolu_0116k1GsR8JxowqSYBJtJbpi',
      readAt: '2026-09-16T08:26:52.230Z', resultAt: '2026-09-16T08:26:52.251Z' });
  });
  test.each(['design', 'dx', 'eng'] as const)('both supported %s aliases and the canonical source retain the same boundary', phase => {
    const f = aliasFixture(phase); f.register(); f.register();
    const paths = [f.canonical, ...[f.short, f.legacy].map(alias => join(alias, 'sections', `${phase}-phase.md`))];
    expect([...f.instruction.paths].sort()).toEqual(paths.sort());
    for (const filePath of paths) {
      f.usePath(filePath);
      expect(f.audit()).toMatchObject({ phase, requiredPhase: f.instruction.requiredPhase });
    }
  });
  test.each(['foreign-target', 'unregistered-path', 'changed-source', 'missing-alias'] as const)
  ('%s cannot register an owned-looking phase entry', change => {
    const f = aliasFixture();
    const foreign = join(f.dir, 'foreign', 'autoplan'); mkdirSync(join(foreign, 'sections'), { recursive: true });
    writeFileSync(join(foreign, 'sections', 'design-phase.md'), f.instruction.content);
    if (change === 'foreign-target' || change === 'missing-alias') {
      rmSync(f.short);
      symlinkSync(change === 'foreign-target' ? foreign : join(f.dir, 'missing'), f.short, 'junction');
    }
    if (change === 'unregistered-path') f.usePath(join(foreign, 'sections', 'design-phase.md'));
    if (change === 'changed-source') writeFileSync(f.canonical, f.instruction.content + 'Changed after binding.\n');
    f.register();
    expect(f.audit()).toBeNull();
  });
  test.each(['foreign-result', 'changed-result', 'error', 'unknown-status', 'unpaired', 'missing-ack', 'backward-ack'] as const)
  ('a registered alias with %s cannot establish a successful entry', change => {
    const f = aliasFixture(); f.register(); const result = f.events[1]!, file = result.file as any;
    if (change === 'foreign-result') file.filePath = join(f.dir, 'foreign', 'design-phase.md');
    if (change === 'changed-result') file.content += 'Changed';
    if (change === 'error') result.isError = true;
    if (change === 'unknown-status') delete result.isError;
    if (change === 'unpaired') result.toolUseId += '-orphan';
    if (change === 'missing-ack') f.events.pop();
    if (change === 'backward-ack') result.timestamp = new Date(Date.parse(f.events[0]!.timestamp) - 1).toISOString();
    expect(f.audit()).toBeNull();
  });
  test.each([-1, 0, 1, 30_000])('publication at alias request %+d ms keeps request-time ordering even with a later ACK', delta => {
    const f = aliasFixture(); f.register(); const at = Date.parse(f.events[0]!.timestamp);
    f.events[1]!.timestamp = new Date(at + 60_000).toISOString();
    f.transcript.assistantMessages.push({ sessionId: f.events[0]!.sessionId,
      timestamp: new Date(at + delta).toISOString(), text: 'Phase 1 complete.' });
    expect(f.audit() === null).toBe(delta <= 0);
  });
  test.each(['parent', 'child', 'foreign-cwd', 'pending-ack'] as const)
  ('the owned native reader preserves %s semantics for the captured short alias', variant => {
    const f = aliasFixture(); f.register();
    const project = join(f.config, 'projects', 'fixture'); mkdirSync(project, { recursive: true });
    const rows = f.events.slice(0, variant === 'pending-ack' ? 1 : 2).map(event => ({
      cwd: variant === 'foreign-cwd' ? join(f.dir, 'foreign-cwd') : f.dir, isSidechain: variant === 'child',
      sessionId: event.sessionId, timestamp: event.timestamp,
      message: { role: event.kind === 'use' ? 'assistant' : 'user', content: [event.kind === 'use'
        ? { type: 'tool_use', id: event.toolUseId, name: event.name, input: event.input }
        : { type: 'tool_result', tool_use_id: event.toolUseId, is_error: event.isError, content: event.content }] },
      toolUseResult: event.kind === 'result' ? { file: event.file } : undefined,
    }));
    writeFileSync(join(project, `${f.events[0]!.sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const projected: NativePublicToolEvent[] = [];
    const transcript = readPlanCountTranscript(f.config, f.dir, event => projected.push(event));
    expect(prematureAutoplanPhaseEntry(projected, transcript, [f.instruction], f.startedAt) !== null).toBe(variant === 'parent');
  });
});

describe('the seeded launcher HOME registry preserves the phase publication boundary', () => {
  function fixture(phase: AutoplanPhaseInstruction['phase'] = 'design') {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gstack-phase-home-'))); owned.push(dir);
    const runRoot = join(dir, 'run'), config = join(runRoot, 'with-skills', '.claude');
    const home = join(runRoot, 'skill-home-owned'), stateRoot = join(home, '.gstack');
    const registry = join(home, '.claude', 'skills'), source = join(dir, 'source');
    const canonical = join(source, 'autoplan', 'sections', `${phase}-phase.md`);
    const content = readFileSync(join(ROOT, 'autoplan', 'sections', `${phase}-phase.md`), 'utf8');
    // Populate canonical files before creating links. All fixture writes stay in dir.
    for (const path of [config, stateRoot, registry, join(source, 'autoplan', 'sections')]) mkdirSync(path, { recursive: true });
    writeFileSync(canonical, content);
    symlinkSync(source, join(registry, 'gstack'), 'junction');
    symlinkSync(join(source, 'autoplan'), join(registry, 'autoplan'), 'junction');
    const installed = join(registry, 'gstack', 'autoplan', 'sections', `${phase}-phase.md`);
    const instruction: AutoplanPhaseInstruction = { phase, requiredPhase: phase === 'design' ? 1 : phase === 'dx' ? 2 : 2.5,
      paths: [canonical], content };
    // Preserve the literal native packet and all parent messages; only map the
    // captured file path to this isolated install for executable ownership checks.
    const events = clone(homeEntry.events) as NativePublicToolEvent[];
    const transcript = { status: 'ready' as const, calls: [], assistantMessages: clone(homeEntry.assistantMessages) };
    const usePath = (filePath: string) => {
      events[0]!.input!.file_path = filePath;
      events[1]!.file = { ...(events[1]!.file as object), filePath, content,
        numLines: content.split('\n').length, totalLines: content.split('\n').length };
    };
    usePath(installed);
    const register = (state = stateRoot) => registerAutoplanPhaseInstructionAliases([instruction], config, state);
    const startedAt = Date.parse(transcript.assistantMessages[0]!.timestamp);
    const audit = () => prematureAutoplanPhaseEntry(events, transcript, [instruction], startedAt);
    return { dir, runRoot, config, home, stateRoot, registry, source, canonical, installed, instruction,
      events, transcript, usePath, register, audit };
  }
  test('actual fb10 HOME Read was missed despite exact canonical bytes and no parent publication', () => {
    const f = fixture();
    expect(homeEntry.observedPrematurePhaseEntry).toBeNull();
    expect(homeEntry.events[1]!.file!.content).toBe(f.instruction.content);
    expect(homeEntry.assistantMessages).toHaveLength(35);
    expect(homeEntry.events[0]!.input!.file_path).toBe(join(homeEntry.ownedSkillStateRoot, '..', '.claude', 'skills', 'gstack', 'autoplan', 'sections', 'design-phase.md'));
    registerAutoplanPhaseInstructionAliases([f.instruction], f.config);
    expect(f.audit()).toBeNull(); // Original registration reproduces the missing alias.
    f.register();
    expect(f.audit()).toEqual({ phase: 'design', requiredPhase: 1,
      sessionId: 'd3dddf71-ec90-4aa3-a510-f0eb9d85ad5d', readToolUseId: 'toolu_01CvVuWnRgxP6wn1iFM31wnt',
      readAt: '2026-09-17T01:18:58.990Z', resultAt: '2026-09-17T01:18:59.007Z' });
    const caller = readFileSync(join(ROOT, 'test', 'skill-e2e-autoplan-chain.test.ts'), 'utf8');
    expect(caller).toMatch(/registerAutoplanPhaseInstructionAliases\(phaseInstructions, session\.hermeticConfigDir,\s*session\.hermeticSkillStateRoot\)/);
  });
  test.each(['design', 'dx', 'eng'] as const)('the same owned root binds both %s HOME aliases once', phase => {
    const f = fixture(phase); f.register(); f.register();
    const paths = [f.canonical, ...[['autoplan'], ['gstack', 'autoplan']].map(parts => join(f.registry, ...parts, 'sections', `${phase}-phase.md`))];
    expect([...f.instruction.paths].sort()).toEqual(paths.sort());
    for (const path of paths) { f.usePath(path); expect(f.audit()).toMatchObject({ phase, requiredPhase: f.instruction.requiredPhase }); }
  });
  test.each(['missing-state', 'foreign-state', 'wrong-state-name', 'non-seeded-home', 'state-symlink', 'home-symlink',
    'config-symlink', 'registry-symlink', 'foreign-target', 'missing-target', 'stale-source'] as const)
  ('%s establishes no installed alias', change => {
    const f = fixture(); let state = f.stateRoot;
    const foreign = join(f.dir, 'foreign'); mkdirSync(foreign);
    if (change === 'missing-state') rmSync(f.stateRoot, { recursive: true });
    if (change === 'foreign-state') { state = join(foreign, 'skill-home-other', '.gstack'); mkdirSync(state, { recursive: true }); }
    if (change === 'wrong-state-name') { state = join(f.home, 'other'); mkdirSync(state); }
    if (change === 'non-seeded-home') { state = join(f.runRoot, 'other', '.gstack'); mkdirSync(state, { recursive: true }); }
    const replaced = change === 'state-symlink' ? f.stateRoot : change === 'home-symlink' ? f.home
      : change === 'config-symlink' ? f.config : change === 'registry-symlink' ? f.registry : null;
    if (replaced) { renameSync(replaced, replaced + '-saved'); symlinkSync(replaced + '-saved', replaced, 'junction'); }
    if (change === 'foreign-target' || change === 'missing-target') {
      mkdirSync(join(foreign, 'autoplan', 'sections'), { recursive: true });
      writeFileSync(join(foreign, 'autoplan', 'sections', 'design-phase.md'), f.instruction.content);
      rmSync(join(f.registry, 'gstack'));
      symlinkSync(change === 'foreign-target' ? foreign : join(f.dir, 'missing'), join(f.registry, 'gstack'), 'junction');
    }
    if (change === 'stale-source') writeFileSync(f.canonical, f.instruction.content + 'Changed after binding.\n');
    f.register(state); expect(f.audit()).toBeNull();
  });
  test.each(['missing-ack', 'failed-ack', 'changed-content', 'foreign-result'] as const)
  ('a registered HOME alias with %s cannot establish entry', change => {
    const f = fixture(); f.register(); const result = f.events[1]!;
    if (change === 'missing-ack') f.events.pop();
    if (change === 'failed-ack') result.isError = true;
    if (change === 'changed-content') (result.file as any).content += 'Changed';
    if (change === 'foreign-result') (result.file as any).filePath = join(f.dir, 'foreign.md');
    expect(f.audit()).toBeNull();
  });
  test.each([-1, 0, 1])('only actual parent publication by request time %+d ms avoids early rejection', delta => {
    const f = fixture(); f.register();
    f.transcript.assistantMessages.push({ sessionId: f.events[0]!.sessionId,
      timestamp: new Date(Date.parse(f.events[0]!.timestamp) + delta).toISOString(), text: 'Phase 1 complete.' });
    expect(f.audit() === null).toBe(delta <= 0);
  });
});

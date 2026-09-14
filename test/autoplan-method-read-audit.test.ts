import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareMethodology, createSnapshot } from '../bin/gstack-autoplan-snapshot';
import { auditAutoplanMethodReads, loadAutoplanMethodologyBinding } from './helpers/autoplan-method-read-audit';
import { readPlanCountTranscript, type NativePublicToolEvent } from './helpers/plan-count-transcript';
import recorded from './fixtures/autoplan-method-read-aa-events.json';
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

/**
 * A2 / CEO-2: the guard's bounded, append-tolerant owned read. Through the
 * shrink seam the journals here are larger than both the record bound and the
 * retained-data bound, so no multi-MiB fixture is committed. Decisions are the
 * hook's own; ENG-4 and ENG-5 refine what pass two reloads.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { guardFixture, section, denial, codeOf, ROOT, type GuardFixture } from './helpers/autoplan-guard-fixture';
import { ownedRead } from '../autoplan/bin/phase-publication-hook.ts';
import { DEDUP_REPLY } from '../autoplan/bin/guard-journal';
import { readOwnedClaudePublicTranscript, ownedRetainedLimit, OWNED_RETAINED_MAX_BYTES, type OwnedReadMeasure } from '../lib/claude-owned-journal';

const RECORD = 32 * 1024, RETAINED = 64 * 1024;
const fixtures: GuardFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const make = (...args: Parameters<typeof guardFixture>) => { const f = guardFixture(...args); fixtures.push(f); return f; };
async function bounded<T>(run: () => T | Promise<T>, record = RECORD, retained = RETAINED): Promise<T> {
  const prior = { record: process.env.GSTACK_TRANSCRIPT_TEST_MAX_BYTES, retained: process.env.GSTACK_TRANSCRIPT_TEST_RETAINED_BYTES };
  process.env.GSTACK_TRANSCRIPT_TEST_MAX_BYTES = String(record); process.env.GSTACK_TRANSCRIPT_TEST_RETAINED_BYTES = String(retained);
  try { return await run(); } finally {
    for (const [key, value] of [['GSTACK_TRANSCRIPT_TEST_MAX_BYTES', prior.record], ['GSTACK_TRANSCRIPT_TEST_RETAINED_BYTES', prior.retained]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
type Row = { type: string; message?: Record<string, unknown>; extra?: Record<string, unknown> };
let padId = 0;
/** Ordinary session work the evaluation never reads in full: large Read and Bash results, assistant text. */
const work = (count: number): Row[] => Array.from({ length: count }, (_, i): Row => {
  const id = `toolu_work${++padId}`, body = `${'work '.repeat(4000)}${i}`;
  return i % 3 === 0 ? { type: 'assistant', message: { role: 'assistant', id: `msg_work${padId}`, content: [{ type: 'text', text: body.slice(0, 2000) }] } }
    : i % 3 === 1 ? { type: 'assistant', message: { role: 'assistant', id: `msg_work${padId}`, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/repo/src/app.ts' } }] } }
    : { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_work${padId - 1}`, content: body }] },
      extra: { toolUseResult: { file: { filePath: '/repo/src/app.ts', content: body.slice(0, 8000), numLines: 1, startLine: 1, totalLines: 1 } } } };
});
/** An earlier typed conversation that ended its turn, before this /autoplan run. */
const earlier = (count: number): Row[] => [{ type: 'user', message: { role: 'user', content: 'Look at the retry change first.' },
  extra: { origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID() } }, ...work(count),
  { type: 'assistant', message: { role: 'assistant', id: 'msg_earlier_end', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } }];
const initResult = (f: GuardFixture) => f.steps.findIndex(s => s.kind === 'result' && s.id === 'init');
/** A long session: earlier work before /autoplan and phase work after init, both over the shrunk bounds. */
function long(f: GuardFixture, head = 30, window = 30) {
  f.journal(f.steps.length, at => at === -1 ? earlier(head) : at === initResult(f) ? work(window) : []);
  const size = fs.statSync(f.transcript).size, largest = Math.max(...fs.readFileSync(f.transcript, 'utf8').split('\n').map(l => Buffer.byteLength(l)));
  expect(size).toBeGreaterThan(RETAINED * 8);
  expect(largest).toBeLessThan(RECORD);
  return size;
}
const next = (f: GuardFixture) => { f.use('next', 'Read', { file_path: section('design-phase.md') }); return f.input('next', 'Read', { file_path: section('design-phase.md') }); };

describe('A2: the guard decides on a journal larger than its shrunk bounds', () => {
  test('a published Phase 1 enters Phase 2; the same journal without the report is denied', async () => {
    const allowed = make(); allowed.publish(); const input = next(allowed); long(allowed);
    expect(await bounded(() => allowed.hook(input))).toEqual({});
    expect(allowed.log().at(-1)).toMatchObject({ decision: 'allow', disposition: 'allow', path: 'journal' });
    const unpublished = make(); const blocked = next(unpublished); long(unpublished);
    const output = await bounded(() => unpublished.hook(blocked));
    expect(codeOf(output)).toBe('publication_missing');
  });

  test('ENG-5: the index keeps no content, and pass two reloads only what the evaluation reads', async () => {
    const f = make(); f.publish(); const input = next(f); const size = long(f, 60, 60);
    const measure: OwnedReadMeasure = { indexBytes: 0 };
    const read = await bounded(() => ownedRead(f.transcript, [f.cwd], input, ROOT, undefined, measure));
    expect(read.transcript.status).toBe('ready');
    expect(measure.indexBytes!).toBeLessThan(size / 20);
    expect(measure.retainedBytes!).toBeLessThan(RETAINED);
    expect(JSON.stringify(read.events)).not.toContain('work work');
    // The guarded Read results it evaluates are reloaded in full.
    expect(read.events.find(e => e.kind === 'result' && e.toolUseId === 'close')).toMatchObject({ file: { filePath: f.packet.closePacketPath } });
  });

  test('ENG-5: retained data over its bound is a hard denial naming the oversized invocation and the fallback', async () => {
    const f = make(); f.publish(); const input = next(f); long(f);
    const output = await bounded(() => f.hook(input), RECORD, 4 * 1024);
    expect(codeOf(output)).toBe('oversized_invocation');
    expect(denial(output)).toContain('retained-data bound');
    expect(denial(output)).toContain('/plan-ceo-review, then /plan-devex-review, then /plan-eng-review');
    expect(f.log().at(-1)).toMatchObject({ decision: 'deny', disposition: 'fallback', code: 'oversized_invocation' });
    await bounded(() => expect(ownedRetainedLimit()).toBe(OWNED_RETAINED_MAX_BYTES), RECORD, OWNED_RETAINED_MAX_BYTES * 4);
  });

  test('a run started by a typed request and the Skill tool (no /autoplan slash turn) binds its init', async () => {
    const f = make('ceo', { opening: 'skill' }); f.publish(); const input = next(f); long(f);
    expect(await bounded(() => f.hook(input))).toEqual({});
    const unpublished = make('ceo', { opening: 'skill' }); const blocked = next(unpublished); long(unpublished);
    expect(codeOf(await bounded(() => unpublished.hook(blocked)))).toBe('publication_missing');
  });

  test('ENG-4: a dedup reply in the second /autoplan run of a session cites a Read from the first run', async () => {
    for (const forged of [false, true]) {
      const f = make();
      const entry = f.steps.findIndex(s => s.kind === 'result' && s.id === 'entry'), full = f.steps[entry]!;
      // Run 2's driver Read is Claude Code's dedup reply; run 1 returned the file in full. Without the
      // close Read, only that driver Read can establish Phase 1 for the Phase 2 entry below.
      f.steps[entry] = { ...full, content: DEDUP_REPLY, file: { filePath: section('ceo-phase.md') } };
      f.steps.splice(0, f.steps.length, ...f.steps.filter(s => s.id !== 'close'));
      const input = next(f);
      const init = f.steps[0]!, initReply = f.steps[1]!, entryUse = f.steps[entry - 1]!;
      const file = forged ? { ...(full.file as object), content: `${(full.file as { content: string }).content}\nForged.` } : full.file;
      const firstRun: Row[] = [
        { type: 'user', message: { role: 'user', content: '<command-message>autoplan</command-message>\n<command-name>/autoplan</command-name>' },
          extra: { origin: { kind: 'human' }, promptId: randomUUID() } },
        { type: 'assistant', message: { role: 'assistant', id: 'msg_run1_init', content: [{ type: 'tool_use', id: 'run1-init', name: 'Bash', input: init.input }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'run1-init', content: initReply.content, is_error: false }] } },
        { type: 'assistant', message: { role: 'assistant', id: 'msg_run1_entry', content: [{ type: 'tool_use', id: 'run1-entry', name: 'Read', input: entryUse.input }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'run1-entry', content: 'Read complete.', is_error: false }] },
          extra: { toolUseResult: { file } } },
        ...work(30),
        { type: 'assistant', message: { role: 'assistant', id: 'msg_run1_end', content: [{ type: 'text', text: 'Stopping here.' }], stop_reason: 'end_turn' } },
      ];
      f.journal(f.steps.length, at => at === -1 ? firstRun : at === initResult(f) ? work(30) : []);
      // The witness is reloaded and checked: an exact earlier Read establishes Phase 1 (whose close is then
      // required); a forged one establishes nothing.
      expect({ forged, code: codeOf(await bounded(() => f.hook(input))) }).toEqual({ forged, code: forged ? 'phase_order' : 'close_required' });
    }
  });
});

describe('A2: append-tolerant reads with prefix identity', () => {
  test('Claude Code appending throughout the read never fails it', async () => {
    const f = make(); f.publish(); const input = next(f); long(f, 600, 600);
    const appender = Bun.spawn([process.execPath, '-e', `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(f.transcript)},'a');
      const pause=new Int32Array(new SharedArrayBuffer(4));
      for(;;){fs.writeSync(fd,JSON.stringify({type:'progress',sessionId:${JSON.stringify(f.sessionId)},data:'x'.repeat(200)})+'\\n');Atomics.wait(pause,0,0,0.02);}`],
      { stdout: 'ignore', stderr: 'ignore' });
    try {
      const grown = fs.statSync(f.transcript).size;
      for (let i = 0; i < 50 && fs.statSync(f.transcript).size === grown; i++) await Bun.sleep(10);
      expect(fs.statSync(f.transcript).size).toBeGreaterThan(grown);
      expect(await f.hook(input)).toEqual({});
    } finally { appender.kill(); await appender.exited; }
  });

  /** A lagging journal makes the hook read twice in one invocation; `change` runs between the reads. */
  async function twoReads(change: (file: string) => void) {
    const f = make(); f.use('lagging', 'Bash', { command: 'sleep 5' }); f.say('Still working.');
    const input = f.input('next', 'Read', { file_path: f.method, offset: 1, limit: 1 });
    f.journal();
    setTimeout(() => change(f.transcript), 20);
    return { f, output: await f.hook(input) };
  }

  test('a prefix rewritten between two reads in one hook invocation is the unverified `rewritten` allow', async () => {
    const { f, output } = await twoReads(file => {
      const fd = fs.openSync(file, 'r+');
      try { const first = Buffer.alloc(1); fs.readSync(fd, first, 0, 1, 2); fs.writeSync(fd, Buffer.from(first[0] === 0x61 ? 'b' : 'a'), 0, 1, 2); }
      finally { fs.closeSync(fd); }
    });
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(codeOf(output)).toBe('rewritten');
    expect(f.log().at(-1)).toMatchObject({ decision: 'allow', disposition: 'unverified', code: 'rewritten' });
  });

  test('a journal that shrinks between two reads is an identity denial', async () => {
    const { output } = await twoReads(file => fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2)));
    expect(codeOf(output)).toBe('identity');
    expect(denial(output)).toContain('/plan-ceo-review, then /plan-devex-review, then /plan-eng-review');
  });

  test('the reader itself: a changed prefix is rewritten, fewer bytes than the prefix is identity', () => {
    const f = make(); f.journal();
    const measure: OwnedReadMeasure = {};
    expect(readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId, { measure }).transcript.status).toBe('ready');
    const prefix = measure.prefix!;
    fs.appendFileSync(f.transcript, JSON.stringify({ type: 'progress', sessionId: f.sessionId }) + '\n');
    expect(readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId, { prior: prefix }).transcript.status).toBe('ready');
    expect(readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId, { prior: { ...prefix, sha256: '0'.repeat(64) } }).transcript.reason)
      .toBe('rewritten');
    expect(readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId, { prior: { ...prefix, size: prefix.size * 4 } }).transcript.reason)
      .toBe('identity');
  });

  test('only a single record over the record bound is too_large, and an unfinished record is not read', async () => {
    const f = make(); f.publish(); const input = next(f); long(f);
    fs.appendFileSync(f.transcript, JSON.stringify({ type: 'progress', sessionId: f.sessionId, data: 'y'.repeat(RECORD) }) + '\n');
    const measure: OwnedReadMeasure = {};
    const read = await bounded(() => readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId, { measure }));
    expect(read.transcript.reason).toBe('too_large');
    expect(measure.recordBytes!).toBeGreaterThan(RECORD);
    const output = await bounded(() => f.hook(input));
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(codeOf(output)).toBe('too_large');
    // A record still being written (no newline yet) is not evidence: the read ends at the last complete line.
    const partial = make(); partial.publish(); const current = next(partial); long(partial);
    fs.appendFileSync(partial.transcript, JSON.stringify({ type: 'assistant', sessionId: partial.sessionId }).slice(0, -2));
    expect(await bounded(() => partial.hook(current))).toEqual({});
  });
});

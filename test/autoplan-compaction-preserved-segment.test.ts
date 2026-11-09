/**
 * Claude Code 2.1.300 auto-compaction no longer copies the kept conversation
 * (#3107's 2.1.293 shape). It keeps the last records in place and names them in
 * `compactMetadata.preservedSegment` / `preservedMessages`. The boundary's
 * logicalParentUuid is the segment's tail, but the tail is written after the
 * boundary, relinked under the compact summary (the segment's anchor):
 *
 *   ... -> head -> ... -> last kept record          (pre-boundary, in place)
 *   boundary(parentUuid null, logicalParentUuid tail) -> attachments -> summary -> tail -> ...
 *
 * Followed literally, the parent links form a cycle (boundary -> tail -> summary
 * -> boundary) that never reaches the session root, so every record after the
 * compaction was dropped from ownership. The guard then answered each later
 * phase entry with `close_incomplete` (the full close packet Read was invisible)
 * and retrying could not help.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { guardFixture, section, codeOf, denial, type GuardFixture } from './helpers/autoplan-guard-fixture';
import { readOwnedClaudePublicTranscript } from '../lib/claude-public-transcript';
import { OWNED_READ_APPROVAL } from '../autoplan/bin/owned-read';

type Row = Record<string, any>;
const fixtures: GuardFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

const rowsOf = (f: GuardFixture): Row[] => fs.readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const write = (f: GuardFixture, rows: Row[]) => fs.writeFileSync(f.transcript, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const usesTool = (r: Row, id: string) => Array.isArray(r.message?.content) && r.message.content.some((b: Row) => b.type === 'tool_use' && b.id === id);

/**
 * A Phase 1 run whose close packet is read once in part (line 1) before an
 * auto-compaction and in full after it, then published: the order a long
 * session produced on Claude Code 2.1.300.
 */
function fixture(history?: Row[]): GuardFixture {
  const f = guardFixture(); fixtures.push(f);
  const at = f.steps.findIndex(s => s.kind === 'use' && s.id === 'close');
  f.read('close-head', f.packet.closePacketPath, 1, 1);
  f.steps.splice(at, 0, ...f.steps.splice(-2));
  f.publish(); f.journal(f.steps.length, at => at === -1 && history ? history as any : []);
  return f;
}

/**
 * Insert a 2.1.300-shaped compaction before the record that uses `splitAt`:
 * the kept segment is the last `keep` records before it, in place; the tail is
 * a new attachment written after the summary; records from `splitAt` on hang
 * under the post-compaction attachments.
 */
function compact300(f: GuardFixture, opts: { splitAt?: string; keep?: number; shape?: (boundary: Row) => void } = {}) {
  const rows = rowsOf(f), split = rows.findIndex(r => usesTool(r, opts.splitAt ?? 'close'));
  const before = rows.slice(0, split), after = rows.slice(split), last = before.at(-1)!;
  const stamp = (ms: number) => new Date(Date.parse(last.timestamp) + ms).toISOString();
  const base = { isSidechain: false, cwd: last.cwd, sessionId: last.sessionId, version: '2.1.300', userType: 'external', entrypoint: 'cli' };
  const keep = opts.keep ?? 4, kept = (keep ? before.slice(-keep) : []).map(r => r.uuid);
  const tail = randomUUID(), summary = randomUUID(), boundary = randomUUID();
  const attachment = (uuid: string, parentUuid: string, type: string, ms: number) =>
    ({ ...base, parentUuid, uuid, timestamp: stamp(ms), type: 'attachment', attachment: { type } });
  const boundaryRow: Row = { ...base, parentUuid: null, logicalParentUuid: tail, type: 'system', subtype: 'compact_boundary',
    content: 'Conversation compacted', level: 'info', uuid: boundary, timestamp: stamp(2000),
    compactMetadata: { trigger: 'auto', preTokens: 964539, postTokens: 21605,
      preservedSegment: { headUuid: kept[0] ?? tail, anchorUuid: summary, tailUuid: tail },
      preservedMessages: { anchorUuid: summary, uuids: [...kept, tail], allUuids: [...kept, tail] } } };
  opts.shape?.(boundaryRow);
  const instructions = randomUUID(), files = randomUUID();
  const compacted = [
    boundaryRow,
    attachment(instructions, boundary, 'instructions', 2000),
    { ...base, parentUuid: instructions, uuid: summary, timestamp: stamp(1900), type: 'user', isCompactSummary: true,
      isVisibleInTranscriptOnly: true, promptId: randomUUID(),
      message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } },
    // The tail keeps its pre-compaction timestamp but is first written here, under the summary.
    attachment(tail, summary, 'total_tokens_reminder', 50),
    attachment(files, tail, 'compact_file_reference', 2000),
  ];
  after[0] = { ...after[0], parentUuid: files };
  write(f, [...before, ...compacted, ...after]);
  return { boundary, tail, summary };
}

const nextPhase = (f: GuardFixture) => f.input('next', 'Read', { file_path: section('design-phase.md') });
const toolIds = (f: GuardFixture) => readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId).events
  .filter(e => e.kind === 'use').map(e => (e as any).toolUseId);

describe('Claude Code 2.1.300 compaction with a preserved segment', () => {
  test('without the compaction the fixture passes (control)', async () => {
    const f = fixture();
    expect(await f.hook(nextPhase(f))).toEqual(OWNED_READ_APPROVAL);
  });

  test('records written after the boundary stay owned', () => {
    const f = fixture(); compact300(f);
    expect(toolIds(f)).toEqual(['init', 'entry', 'close-head', 'close', expect.stringMatching(/^noop-/)]);
  });

  test('the next phase entry passes once the close packet is read in full after the compaction', async () => {
    const f = fixture(); compact300(f);
    expect(await f.hook(nextPhase(f))).toEqual(OWNED_READ_APPROVAL);
  });

  // Claude Code 2.1.317: the boundary's logical parent was never written to the
  // file, the segment's tail is the last kept record in place. Every later record
  // was dropped, so the latest "message" was a phase's methodology Read and the
  // next phase entry was refused as cross_phase_batch on every retry.
  const absentLogicalParent = (boundary: Row) => {
    const { preservedSegment, preservedMessages } = boundary.compactMetadata;
    boundary.logicalParentUuid = randomUUID();
    preservedMessages.uuids.pop(); preservedMessages.allUuids.pop();
    preservedSegment.tailUuid = preservedMessages.uuids.at(-1);
  };

  test('a boundary whose logical parent was never written continues from the preserved tail', () => {
    const f = fixture(); compact300(f, { shape: absentLogicalParent });
    expect(toolIds(f)).toEqual(['init', 'entry', 'close-head', 'close', expect.stringMatching(/^noop-/)]);
  });

  test('the next phase entry passes after a compaction whose logical parent was never written', async () => {
    const f = fixture(); compact300(f, { shape: absentLogicalParent });
    expect(await f.hook(nextPhase(f))).toEqual(OWNED_READ_APPROVAL);
  });

  test('a logical parent that is the unflushed tail itself still supplies no ownership yet', () => {
    const f = fixture(); compact300(f, { shape: b => { b.logicalParentUuid = b.compactMetadata.preservedSegment.tailUuid = randomUUID();
      b.compactMetadata.preservedMessages.uuids.push(b.logicalParentUuid); } });
    expect(toolIds(f)).not.toContain('close');
  });

  test('a preserved segment of only the tail (nothing kept in place) names no anchor and is reported as an unrecognized shape', async () => {
    const f = fixture(); compact300(f, { keep: 0 });
    expect(toolIds(f)).not.toContain('close');
    expectUnrecognizedCompaction(f, await f.hook(nextPhase(f)));
  });

  test('a boundary without compactMetadata whose logical parent cycles back is reported, not silently cut', async () => {
    const f = fixture(); compact300(f, { shape: b => { delete b.compactMetadata; } });
    expect(readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId).transcript)
      .toMatchObject({ status: 'missing', reason: 'unrecognized_shape:compaction_unreachable' });
    expectUnrecognizedCompaction(f, await f.hook(nextPhase(f)));
  });

  test('a boundary whose logical parent cycles back without a matching preserved tail is reported as an unrecognized shape', async () => {
    const f = fixture();
    compact300(f, { shape: b => { delete b.compactMetadata.preservedSegment; delete b.compactMetadata.preservedMessages; } });
    expect(toolIds(f)).not.toContain('close');
    expectUnrecognizedCompaction(f, await f.hook(nextPhase(f)));
  });

  test('a preserved list naming a record outside this session does not anchor the boundary', async () => {
    const f = fixture();
    compact300(f, { shape: b => { b.compactMetadata.preservedMessages.uuids = [randomUUID(), b.logicalParentUuid]; } });
    expect(toolIds(f)).not.toContain('close');
    expectUnrecognizedCompaction(f, await f.hook(nextPhase(f)));
  });

  test('a compaction whose boundary is not flushed yet still drops what follows and denies (negative control)', async () => {
    const f = fixture();
    const { boundary } = compact300(f);
    write(f, rowsOf(f).filter(r => r.uuid !== boundary));
    expect(toolIds(f)).not.toContain('close');
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('close_incomplete');
  });

  test('three compactions in one session stay owned and the next phase entry passes', async () => {
    const f = fixture();
    for (const splitAt of ['entry', 'close-head', 'close']) compact300(f, { splitAt });
    expect(rowsOf(f).filter(r => r.subtype === 'compact_boundary')).toHaveLength(3);
    expect(toolIds(f)).toEqual(['init', 'entry', 'close-head', 'close', expect.stringMatching(/^noop-/)]);
    expect(await f.hook(nextPhase(f))).toEqual(OWNED_READ_APPROVAL);
  });

  test('a 50k-record history with three compactions is decided inside the hook budget', async () => {
    const history: Row[] = [{ type: 'user', message: { role: 'user', content: 'Review the retry change first.' },
      extra: { origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID() } }];
    for (let i = 0; i < 50_000; i++) history.push({ type: 'assistant', message: { role: 'assistant', id: `msg_pad${i}`, content: [{ type: 'text', text: 'ok' }] } });
    history.push({ type: 'assistant', message: { role: 'assistant', id: 'msg_earlier_end', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } });
    const f = fixture(history);
    for (const splitAt of ['entry', 'close-head', 'close']) compact300(f, { splitAt });
    const started = performance.now();
    const output = await f.hook(nextPhase(f));
    const elapsed = performance.now() - started;
    expect(output).toEqual(OWNED_READ_APPROVAL);
    expect(elapsed).toBeLessThan(1000);
  });
});

/** The guard allows the call with a visible warning and logs the unverified decision; it never denies with close_incomplete. */
function expectUnrecognizedCompaction(f: GuardFixture, output: any) {
  expect(denial(output)).toBeUndefined();
  expect(codeOf(output)).toBe('unrecognized_shape:compaction_unreachable');
  expect(output.systemMessage).toContain('phase publication was NOT verified');
  expect(f.log().at(-1)).toMatchObject({ decision: 'allow', disposition: 'unverified', code: 'unrecognized_shape:compaction_unreachable' });
}

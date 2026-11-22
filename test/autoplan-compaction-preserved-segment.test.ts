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
import { ownedCausalOrder, recordMeta } from '../lib/claude-journal-records';

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

/**
 * Claude Code 2.1.317 (#4200): the boundary's logicalParentUuid names a record the
 * file never receives, and the preserved list ends with the segment's tail, the last
 * record kept in place before the boundary. Followed literally, the boundary is an
 * orphan, every later record was dropped, and each phase entry was refused on every
 * retry. Such a boundary continues from that tail.
 */
const shape317 = (boundary: Row) => {
  const { preservedSegment, preservedMessages } = boundary.compactMetadata;
  boundary.version = '2.1.317';
  boundary.logicalParentUuid = randomUUID();
  preservedMessages.uuids.pop(); preservedMessages.allUuids.pop();
  preservedSegment.tailUuid = preservedMessages.uuids.at(-1);
};
const transcriptOf = (f: GuardFixture) => readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId).transcript;

describe('Claude Code 2.1.317 compaction whose logical parent is never written', () => {
  test('records written after the boundary stay owned', () => {
    const f = fixture(); compact300(f, { shape: shape317 });
    expect(toolIds(f)).toEqual(['init', 'entry', 'close-head', 'close', expect.stringMatching(/^noop-/)]);
  });

  test('the next phase entry passes once the close packet is read in full after the compaction', async () => {
    const f = fixture(); compact300(f, { shape: shape317 });
    expect(await f.hook(nextPhase(f))).toEqual(OWNED_READ_APPROVAL);
  });

  test('three such compactions in one session stay owned and the next phase entry passes', async () => {
    const f = fixture();
    for (const splitAt of ['entry', 'close-head', 'close']) compact300(f, { splitAt, shape: shape317 });
    expect(toolIds(f)).toEqual(['init', 'entry', 'close-head', 'close', expect.stringMatching(/^noop-/)]);
    expect(await f.hook(nextPhase(f))).toEqual(OWNED_READ_APPROVAL);
  });

  // Holds: each shape below is refused or reported today and must stay so.
  test('a 2.1.300 tail that is the logical parent and not flushed yet still supplies no ownership', async () => {
    const f = fixture();
    const { tail } = compact300(f);
    write(f, rowsOf(f).filter(r => r.uuid !== tail));
    expect(toolIds(f)).not.toContain('close');
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('close_incomplete');
  });

  test('a preserved list whose last entry is not the segment tail does not continue the boundary', async () => {
    const f = fixture(); compact300(f, { shape: b => { shape317(b); b.compactMetadata.preservedSegment.tailUuid = randomUUID(); } });
    expect(toolIds(f)).not.toContain('close');
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('close_incomplete');
  });

  test('a preserved list naming no record of this file does not continue the boundary', async () => {
    const f = fixture(); compact300(f, { shape: b => { shape317(b);
      const ids = [randomUUID(), randomUUID()]; b.compactMetadata.preservedMessages.uuids = ids; b.compactMetadata.preservedSegment.tailUuid = ids[1]; } });
    expect(toolIds(f)).not.toContain('close');
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('close_incomplete');
  });

  test('a preserved tail that is a subagent record does not continue the boundary', async () => {
    const f = fixture();
    const agentRecord = randomUUID();
    compact300(f, { shape: b => { shape317(b);
      b.compactMetadata.preservedMessages.uuids = [agentRecord]; b.compactMetadata.preservedSegment.tailUuid = agentRecord; } });
    const rows = rowsOf(f), at = rows.findIndex(r => r.subtype === 'compact_boundary'), last = rows[at - 1]!;
    rows.splice(at, 0, { ...last, uuid: agentRecord, parentUuid: last.uuid, isSidechain: true, agentId: 'a1',
      type: 'attachment', attachment: { type: 'reminder' }, message: undefined });
    write(f, rows);
    expect(toolIds(f)).not.toContain('close');
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('close_incomplete');
  });

  test('a boundary with an absent logical parent and no compactMetadata still drops what follows', async () => {
    const f = fixture(); compact300(f, { shape: b => { b.logicalParentUuid = randomUUID(); delete b.compactMetadata; } });
    expect(toolIds(f)).not.toContain('close');
    expect(codeOf(await f.hook(nextPhase(f)))).toBe('close_incomplete');
  });

  test('a 2.1.300 boundary that cycles back but whose list omits its logical parent is still reported as an unrecognized shape', async () => {
    const f = fixture(); compact300(f, { shape: b => { const { preservedSegment, preservedMessages } = b.compactMetadata;
      preservedMessages.uuids.pop(); preservedSegment.tailUuid = preservedMessages.uuids.at(-1); } });
    expect(toolIds(f)).not.toContain('close');
    expect(transcriptOf(f)).toMatchObject({ status: 'missing', reason: 'unrecognized_shape:compaction_unreachable' });
    expectUnrecognizedCompaction(f, await f.hook(nextPhase(f)));
  });

  test('a resumed fork that opens with such a boundary stays a genesis root', () => {
    const kept = randomUUID(), boundary = randomUUID();
    const row = (uuid: string, parentUuid: string | null, extra: Row) =>
      ({ uuid, parentUuid, isSidechain: false, cwd: '/w', timestamp: '2026-11-09T00:00:00.000Z', ...extra });
    const shaped = [
      row(boundary, null, { type: 'system', subtype: 'compact_boundary', logicalParentUuid: randomUUID(),
        compactMetadata: { preservedSegment: { tailUuid: kept }, preservedMessages: { uuids: [kept] } } }),
      row(kept, randomUUID(), { type: 'attachment', attachment: { type: 'reminder' } }),
      row(randomUUID(), boundary, { type: 'user', message: { role: 'user', content: 'continued' } }),
    ];
    const orderOf = (rows: Row[]) => ownedCausalOrder(rows.map((r, i) => recordMeta(r, i)), '/w');
    const control = orderOf(shaped.map(r => r.uuid === boundary ? { ...r, compactMetadata: undefined } : r));
    expect(control).toEqual({ order: [0, 2], root: boundary });
    expect(orderOf(shaped)).toEqual(control);
  });
});

/** The guard allows the call with a visible warning and logs the unverified decision; it never denies with close_incomplete. */
function expectUnrecognizedCompaction(f: GuardFixture, output: any) {
  expect(denial(output)).toBeUndefined();
  expect(codeOf(output)).toBe('unrecognized_shape:compaction_unreachable');
  expect(output.systemMessage).toContain('phase publication was NOT verified');
  expect(f.log().at(-1)).toMatchObject({ decision: 'allow', disposition: 'unverified', code: 'unrecognized_shape:compaction_unreachable' });
}

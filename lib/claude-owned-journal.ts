/**
 * The publication guard's bounded, append-tolerant read of one parent session
 * journal (CEO-2). Pass one streams the bytes present at open, up to the last
 * complete line, and keeps a small index per record: ownership metadata, byte
 * range, and the record's public events with their content stripped. Ownership,
 * ancestry and causal order are decided on that index. Pass two (the policy's
 * `select`) reloads in full only the records the evaluation reads, under a named
 * retained-data bound. Batch readers keep `readPlanCountTranscript`'s whole-file
 * read and its cap.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { object, recordEvents, recordMeta, ownedCausalOrder, nativePathSpelling, ownedNativePath, sameNativePath,
  type ClaudeParentPublicEvent, type OwnedTranscriptReason, type RecordMeta } from './claude-journal-records';
import type { PlanCountTranscript } from './claude-public-transcript';

/** The largest single journal record the guard verifies; any record over it is `too_large` (docs/autoplan-guard-troubleshooting.md). */
export const OWNED_RECORD_MAX_BYTES = 32 * 1024 * 1024;
/** The most record bytes pass two may reload in full for one evaluation; over it is `oversized_invocation`. */
export const OWNED_RETAINED_MAX_BYTES = 32 * 1024 * 1024;
const lowered = (name: string, max: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 && value < max ? value : max;
};
/** Test seam: GSTACK_TRANSCRIPT_TEST_MAX_BYTES can only LOWER the record bound, never raise it. */
export const ownedRecordLimit = () => lowered('GSTACK_TRANSCRIPT_TEST_MAX_BYTES', OWNED_RECORD_MAX_BYTES);
/** Test seam: GSTACK_TRANSCRIPT_TEST_RETAINED_BYTES can only LOWER the retained bound, never raise it. */
export const ownedRetainedLimit = () => lowered('GSTACK_TRANSCRIPT_TEST_RETAINED_BYTES', OWNED_RETAINED_MAX_BYTES);
const CHUNK_BYTES = 1024 * 1024;
/** Parsed records are garbage once indexed; collecting every 32 MiB keeps a 120 MiB journal's peak RSS under budget (CEO-2). */
const COLLECT_EVERY_BYTES = 32 * 1024 * 1024;

/** The bytes [0, size) one read saw; a later read in the same hook invocation must see the same prefix. */
export interface JournalPrefix { size: number; sha256: string }

/** One owned record in causal order: where it is, and its events (stripped until pass two loads it). */
export interface IndexedRecord {
  readonly offset: number;
  readonly length: number;
  readonly uuid?: string;
  /** The first event order this record owns; pass two keeps it. */
  readonly base: number;
  readonly slots: number;
  /** Tool ids whose result text is a JSON object, so a selector can load structured output without every result. */
  readonly jsonResults?: readonly string[];
  events: ClaudeParentPublicEvent[];
  full: boolean;
}

/** How the hook bounds a read: what the index keeps of a tool input, and which records pass two loads. */
export interface OwnedReadPolicy {
  /** The part of a tool_use input pass one keeps (small by construction); undefined keeps none. */
  indexInput(name: string, input: Record<string, unknown>): Record<string, unknown> | undefined;
  /** Load the records the evaluation reads, in any number of rounds; `load` enforces the retained bound. */
  select(records: readonly IndexedRecord[], load: (records: readonly IndexedRecord[]) => void): void;
}

/** What a refused owned read can report without content: inputs to the hook's guidance and advisory. */
export interface OwnedTranscriptDiagnostic {
  /** Claude Code version recorded in the journal's own records, when present. */
  claudeVersion?: string;
  /** Record types from the journal head down to its first turn; never content. */
  rootShape: string[];
  /** Parent assistant tool_use ids present in complete records. */
  toolUseIds: string[];
  /** sha256 of the bytes present at open, so a second read can prove the same prefix. */
  sha256: string;
  /** The journal ended at a record boundary when it was opened. */
  complete: boolean;
}

export interface OwnedRead {
  transcript: PlanCountTranscript;
  events: ClaudeParentPublicEvent[];
  diagnostic?: OwnedTranscriptDiagnostic;
  claudeVersion?: string;
}

/** What one read measured, filled in for a caller that passes it (kept out of the result so equal journals read equal). */
export interface OwnedReadMeasure {
  /** The prefix this read hashed; pass it as `prior` to the next read in the same hook invocation. */
  prefix?: JournalPrefix;
  /** too_large only: the oversized record's length in bytes. */
  recordBytes?: number;
  /** Bytes of the pass-one index (stripped events); set it to 0 to request the measurement. */
  indexBytes?: number;
  /** Bytes of the records pass two reloaded. */
  retainedBytes?: number;
}

class OwnedReadError extends Error {
  constructor(readonly reason: OwnedTranscriptReason, readonly bytes?: number) { super(reason); }
}

/** Strip, in place, content the index never keeps: tool input beyond the policy's part, result bodies, message text. */
function strip(events: ClaudeParentPublicEvent[], policy: OwnedReadPolicy): ClaudeParentPublicEvent[] {
  for (const e of events) {
    if (e.kind === 'use') e.input = e.input && policy.indexInput(e.name ?? '', e.input);
    else if (e.kind === 'result') { e.content = undefined; e.file = undefined; }
    else if (e.kind === 'message') e.text = '';
  }
  return events;
}

/** One record's index entry: its ownership metadata, byte range and (stripped) events. */
interface Entry extends RecordMeta {
  offset: number;
  length: number;
  events?: ClaudeParentPublicEvent[];
  slots: number;
  /** The message content is an array (the record can make a journal ready). */
  array: boolean;
  jsonResults?: string[];
}

interface Scanned {
  entries: Entry[];
  toolUseIds: string[];
  claudeVersion?: string;
  prefix: JournalPrefix;
  complete: boolean;
}

const resultText = (b: Record<string, any>): string => typeof b.content === 'string' ? b.content
  : Array.isArray(b.content) && b.content.length === 1 && typeof b.content[0]?.text === 'string' ? b.content[0].text : '';

/** Pass one: stream [0, size) to the last complete line; per-record bound; prefix hash; content-free index. */
function scan(fd: number, size: number, sessionId: string, prior: JournalPrefix | undefined,
  policy: OwnedReadPolicy | undefined): Scanned {
  const limit = ownedRecordLimit(), hash = createHash('sha256'), filename = `${sessionId}.jsonl`;
  const out: Scanned = { entries: [], toolUseIds: [], prefix: { size, sha256: '' }, complete: true };
  const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(size, 1)));
  // The unfinished line carried into the next chunk; past the record bound only its length is kept.
  let carry: Buffer[] = [], carryBytes = 0, carryOffset = 0;
  const record = (line: string, offset: number, length: number) => {
    if (!line.length || (line.charCodeAt(0) <= 32 && !line.trim())) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new OwnedReadError('malformed'); }
    if (!object(value) || value.sessionId !== sessionId || filename !== `${value.sessionId}.jsonl`) return;
    const entry = recordMeta(value, out.entries.length) as Entry;
    entry.offset = offset; entry.length = length; entry.slots = 0; entry.array = false;
    out.entries.push(entry);
    if (!entry.agent && !entry.sidechain) {
      out.claudeVersion ??= entry.version;
      if (entry.role === 'assistant' && Array.isArray(value.message.content)) for (const block of value.message.content)
        if (object(block) && block.type === 'tool_use' && typeof block.id === 'string') out.toolUseIds.push(block.id);
    }
    if (!entry.message) return;
    const full = recordEvents(value, true, entry.timestampValid);
    entry.events = policy ? strip(full.events, policy) : full.events;
    entry.slots = full.slots;
    entry.array = Array.isArray(value.message.content);
    if (entry.array) for (const b of value.message.content)
      if (object(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && /^\s*\{/.test(resultText(b)))
        (entry.jsonResults ??= []).push(b.tool_use_id);
  };
  const lines = (region: Buffer, start: number) => {
    if (!isUtf8(region)) throw new OwnedReadError('malformed');
    const text = region.toString('utf8'), ascii = text.length === region.length;
    let offset = start;
    for (const line of text.split('\n')) {
      const length = ascii ? line.length : Buffer.byteLength(line);
      if (length > limit) throw new OwnedReadError('too_large', length);
      record(line, offset, length);
      offset += length + 1;
    }
  };
  for (let pos = 0; pos < size;) {
    const got = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
    if (got <= 0) throw new OwnedReadError('identity');
    const view = chunk.subarray(0, got);
    if (prior && prior.size > 0 && pos < prior.size && pos + got >= prior.size) {
      hash.update(view.subarray(0, prior.size - pos));
      if (hash.copy().digest('hex') !== prior.sha256) throw new OwnedReadError('rewritten');
      hash.update(view.subarray(prior.size - pos));
    } else hash.update(view);
    const last = view.lastIndexOf(10);
    if (last >= 0) {
      const first = view.indexOf(10);
      if (carryBytes + first > limit) throw new OwnedReadError('too_large', carryBytes + first);
      // The carried line joins its end in a small copy; the rest of the chunk decodes in place.
      if (carry.length) lines(Buffer.concat([...carry, view.subarray(0, first)]), carryOffset);
      if (carry.length ? last > first : true) lines(view.subarray(carry.length ? first + 1 : 0, last), carry.length ? pos + first + 1 : pos);
      carry = []; carryBytes = 0; carryOffset = pos + last + 1;
    }
    const rest = view.subarray(last + 1);
    // An oversized unfinished record keeps counting without retaining its bytes.
    if (rest.length && carryBytes + rest.length <= limit) carry.push(Buffer.from(rest));
    carryBytes += rest.length;
    pos += got;
    if (pos % COLLECT_EVERY_BYTES < got && typeof Bun !== 'undefined') Bun.gc(true);
  }
  if (carryBytes > limit) throw new OwnedReadError('too_large', carryBytes);
  // A record still being written (no newline yet) is not evidence and is not read.
  out.complete = carryBytes === 0;
  out.prefix.sha256 = hash.digest('hex');
  return out;
}

/** Ownership on the index, for each accepted owner directory; the first ready owner wins. */
function owned(scanned: Scanned, owners: readonly string[]) {
  const results = owners.map(cwd => {
    const causal = ownedCausalOrder(scanned.entries, cwd);
    if ('reason' in causal) return { status: causal.reason === 'competing_root' || causal.reason === 'cycle' ? 'error' as const : 'missing' as const,
      reason: causal.reason, shape: causal.shape };
    return { status: causal.order.some(i => scanned.entries[i]!.array) ? 'ready' as const : 'missing' as const,
      order: causal.order, reason: undefined, shape: [] as string[] };
  });
  return results.find(r => r.status === 'ready') ?? results.find(r => r.reason !== 'foreign_cwd') ?? results[0]!;
}

/**
 * Read exactly the native hook's parent file; never scan another session.
 * Appends after open never fail the read; the same device and inode and no
 * shrink are required. Without a policy every owned record is kept in full.
 */
export function readOwnedClaudePublicTranscript(file: string, owners: string | readonly string[], sessionId: string,
  options: { prior?: JournalPrefix; policy?: OwnedReadPolicy; measure?: OwnedReadMeasure } = {}): OwnedRead {
  const cwds = typeof owners === 'string' ? [owners] : owners, measure = options.measure ?? {};
  let fd: number | undefined, scanned: Scanned | undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId) || !cwds.length || !cwds.every(cwd => path.isAbsolute(cwd)) || !ownedNativePath(file) ||
        path.basename(nativePathSpelling(file)) !== `${sessionId}.jsonl`) throw new OwnedReadError('identity');
    file = nativePathSpelling(file);
    const project = path.dirname(file), projects = path.dirname(project), config = path.dirname(projects);
    if (path.basename(projects) !== 'projects' ||
        [config, projects, project].some(dir => !fs.lstatSync(dir).isDirectory() || !sameNativePath(fs.realpathSync(dir), dir)))
      throw new OwnedReadError('identity');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new OwnedReadError('identity');
    const size = Number(before.size);
    if (options.prior && size < options.prior.size) throw new OwnedReadError('identity');
    scanned = scan(fd, size, sessionId, options.prior, options.policy);
    measure.prefix = scanned.prefix;
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    // Claude only appends: a different file or fewer bytes than at open is not this journal.
    if (!current.isFile() || before.dev !== current.dev || before.ino !== current.ino ||
        after.size < before.size || current.size < before.size) throw new OwnedReadError('identity');
    const ownership = owned(scanned, cwds);
    if (ownership.reason || ownership.status !== 'ready')
      return { transcript: { status: ownership.status, calls: [], assistantMessages: [], ...(ownership.reason ? { reason: ownership.reason } : {}) },
        events: [], diagnostic: { ...(scanned.claudeVersion ? { claudeVersion: scanned.claudeVersion } : {}), rootShape: ownership.shape,
          toolUseIds: scanned.toolUseIds, sha256: scanned.prefix.sha256, complete: scanned.complete } };
    const records: IndexedRecord[] = [];
    let base = 0, claudeVersion: string | undefined;
    for (const i of ownership.order!) {
      const entry = scanned.entries[i]!;
      if (!entry.events) continue;
      claudeVersion = entry.version ?? claudeVersion;
      for (const e of entry.events) e.order += base;
      records.push({ offset: entry.offset, length: entry.length, uuid: entry.uuid, base, slots: entry.slots,
        jsonResults: entry.jsonResults, events: entry.events, full: !options.policy });
      base += entry.slots;
    }
    // Measured only on request (tests, the benchmark): serializing the index costs as much as building it.
    if (measure.indexBytes !== undefined) measure.indexBytes = records.reduce((sum, r) => sum + JSON.stringify(r.events).length + 64, 0);
    if (options.policy) {
      const reader = fd, limit = ownedRetainedLimit();
      let retained = 0;
      options.policy.select(records, wanted => {
        for (const r of wanted) {
          if (r.full) continue;
          retained += r.length; measure.retainedBytes = retained;
          if (retained > limit) throw new OwnedReadError('oversized_invocation', retained);
          const bytes = Buffer.alloc(r.length);
          if (fs.readSync(reader, bytes, 0, r.length, r.offset) !== r.length || !isUtf8(bytes)) throw new OwnedReadError('rewritten');
          let value: any;
          try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new OwnedReadError('rewritten'); }
          // Pass two must find the record pass one indexed at the same bytes.
          if (!object(value) || value.uuid !== r.uuid || !object(value.message)) throw new OwnedReadError('rewritten');
          const full = recordEvents(value, true);
          if (full.slots !== r.slots || full.events.length !== r.events.length) throw new OwnedReadError('rewritten');
          for (const e of full.events) e.order += r.base;
          r.events = full.events;
          r.full = true;
        }
      });
    }
    return { transcript: { status: 'ready', calls: [], assistantMessages: [] }, events: records.flatMap(r => r.events),
      ...(claudeVersion ? { claudeVersion } : {}) };
  } catch (error) {
    if (error instanceof OwnedReadError && error.reason === 'too_large') measure.recordBytes = error.bytes;
    // A journal Claude has not created yet is unflushed, not an identity failure.
    const reason = error instanceof OwnedReadError ? error.reason :
      (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? undefined : 'identity';
    return { transcript: { status: 'error', calls: [], assistantMessages: [], ...(reason ? { reason } : {}),
      error: `Owned native public transcript is unavailable (${reason ?? 'not created yet'})` }, events: [],
      ...(scanned ? { diagnostic: { ...(scanned.claudeVersion ? { claudeVersion: scanned.claudeVersion } : {}),
        rootShape: [], toolUseIds: scanned.toolUseIds, sha256: scanned.prefix.sha256, complete: scanned.complete } } : {}) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

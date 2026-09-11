/**
 * jsonl-store — shared plumbing for gstack's append-only JSONL stores in
 * lib/ and bin/. (browse/src keeps its own appenders by design — the
 * compiled-binary surface has different logging semantics and its own
 * secure-append helper.)
 *
 * The three things a JSONL store must get right:
 *   1. Injection screening — SEE THE CONTRACT BELOW: appendJsonl does NOT
 *      screen; callers that store free text MUST pre-check with
 *      hasInjection()/firstInjectionMatch() and reject. Enforcing callers
 *      today: bin/gstack-learnings-log, bin/gstack-decision-log (via
 *      lib/gstack-decision.ts), bin/gstack-question-log.
 *   2. Atomic single-line append (concurrent agents must not corrupt the file).
 *   3. Tolerant read (a partially-written tail or one corrupt line must not
 *      take down the whole read).
 *
 * Extracted from `bin/gstack-learnings-log` (D2A) so the learnings/decision/
 * question stores share ONE audited path — a new injection pattern or a
 * write-atomicity fix lands in all at once.
 */

import { appendFileSync, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync, constants } from "fs";
import { dirname } from "path";
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';

/**
 * Prompt-injection patterns. If any matches a free-text field (insight, rationale,
 * decision), the record is REJECTED at write time — these strings could otherwise
 * be replayed into a future agent's context as instructions when the record is
 * resurfaced. Keep this list the ONLY copy (callers import it; do not re-declare).
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous\s+(instructions|context|rules)/i,
  /you\s+are\s+now\s+/i,
  /always\s+output\s+no\s+findings/i,
  /skip\s+(all\s+)?(security|review|checks)/i,
  /\boverride\s+(all\s+)?(previous|prior|above|the\s+(rules|instructions|system\s+prompt))/i,
  /\bsystem\s*:/i,
  /\bassistant\s*:/i,
  /\buser\s*:/i,
  /\bhuman\s*:/i, // Claude's native turn prefix — bypassed the denylist AND datamark
  /disregard\s+(all\s+)?(previous|above|prior)/i,
  /from\s+now\s+on\b/i,
  /do\s+not\s+(report|flag|mention)/i,
  /approve\s+(all|every|this)/i,
];

/** True if `text` contains an instruction-like injection pattern. */
export function hasInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}

/** Returns the first injection pattern that matches, or null. For actionable errors. */
export function firstInjectionMatch(text: string): RegExp | null {
  return INJECTION_PATTERNS.find((p) => p.test(text)) ?? null;
}

function jsonlLine(obj: unknown): string {
  const line = JSON.stringify(obj);
  if (line.includes("\n")) {
    throw new Error("jsonl-store: record serialized to multiple lines (embedded newline)");
  }
  return line + "\n";
}

/**
 * Atomic single-line append of `obj` as one JSON line.
 *
 * Concurrency and durability: all shared callers serialize on one owner-validated
 * per-ledger lock, append in one write, fsync the file, and fsync the directory when
 * the ledger is first created. Records MUST serialize to a single line (no embedded
 * newline), preserving the tolerant reader's one-record-per-line invariant.
 */
export function appendJsonl(path: string, obj: unknown, opts: { mode?: number } = {}): void {
  const line = jsonlLine(obj);
  const owned = acquireDurableOwnerLock(`${path}.jsonl-append`, 'jsonl_store_busy', 20_000);
  let fd: number | undefined;
  try {
    const existed = existsSync(path); const mode = opts.mode ?? 0o666;
    fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), mode);
    const info = fstatSync(fd); const uid = process.geteuid?.();
    if (!info.isFile() || info.nlink !== 1 || uid === undefined || info.uid !== uid || (opts.mode !== undefined && (info.mode & 0o777) !== opts.mode)) throw new Error('jsonl-store: target invalid');
    if (!existed && opts.mode !== undefined) fchmodSync(fd, opts.mode);
    writeFileSync(fd, line, { encoding: 'utf8' }); fsyncSync(fd); closeSync(fd); fd = undefined;
    if (!existed) { const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); } }
  } finally { if (fd !== undefined) closeSync(fd); releaseDurableOwnerLock(owned); }
}

/**
 * Append non-authority operational memory on native Windows.
 *
 * ECPE authority ledgers must use appendJsonl and fail closed because their
 * owner/mode contract has no native-Windows attestation yet. These legacy logs
 * are never grants, receipts, release state, or provider-effect evidence; on
 * Windows they retain the pre-ECPE single O_APPEND write behavior.
 */
export function appendNonAuthorityJsonl(path: string, obj: unknown, opts: { mode?: number } = {}): void {
  if (process.platform !== 'win32') {
    appendJsonl(path, obj, opts);
    return;
  }
  const line = jsonlLine(obj);
  if (opts.mode !== undefined) appendFileSync(path, line, { encoding: 'utf8', mode: opts.mode });
  else appendFileSync(path, line, { encoding: 'utf8' });
}

/**
 * Tolerant reader: parse each line, SKIP malformed ones (partial-write tail, a
 * corrupt line, a non-JSON line) rather than throwing. A broken line never takes
 * down the whole read. Missing file → empty array. Unknown fields are preserved
 * (forward-compatible: a schema bump on the writer doesn't break older readers).
 */
export function readJsonl<T = unknown>(path: string): T[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Malformed line (partial tail / corruption) — skip, keep reading.
    }
  }
  return out;
}

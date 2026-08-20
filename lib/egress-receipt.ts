/**
 * egress-receipt — hash-chained, content-free receipts for every
 * gstack-initiated off-machine send (`~/.gstack/security/egress.jsonl`, 0600).
 *
 * THREAT MODEL: the egress ledger is forensic observability — it records
 * ATTEMPTED egress so accidents are auditable; it is not an exfiltration
 * control. Receipts are written before send, outcomes are best-effort, and
 * fail-open sinks can send unrecorded with a warning.
 *
 * Semantics:
 *   - Receipt-before-send: the receipt line is appended BEFORE the network
 *     call. Fail-closed sinks MUST refuse the send with the typed code
 *     EGRESS_RECEIPT_FAILED when it cannot be written; fail-open sinks warn
 *     on stderr and proceed.
 *   - Content-free: never payload text, never credentials — a sha256 of the
 *     exact bytes sent plus a byte count only (semantic-reviews.jsonl
 *     precedent). Sinks where a subprocess/SDK owns the bytes record
 *     sha256: null.
 *   - Tamper-evident: each line carries `prev` = sha256 of the previous raw
 *     line ("" for line 1). `verifyLedger` recomputes the chain.
 *
 * Node builtins only, so bun TS binaries and the compiled browse binary can
 * both import it (same constraint as browse/src/security.ts: no native
 * modules).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EGRESS_RECEIPT_FAILED = 'EGRESS_RECEIPT_FAILED';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * WARN-at-size threshold. Above this the ledger still appends (never blocks
 * on size), but writeReceipt emits one stderr warning per process so the
 * user learns the file exists and how to inspect it before it gets silly.
 */
export const LEDGER_WARN_BYTES = 25 * 1024 * 1024;

/**
 * Tail window for reading the last raw line. Receipt lines are ~300 bytes;
 * 4KB covers any legal line with an order of magnitude to spare.
 */
const TAIL_READ_BYTES = 4096;

// TODO(rotation): ledger rotation. Chain-genesis sketch: when the ledger
// exceeds the size threshold, rename it to egress.jsonl.1 and start a new
// generation whose FIRST record embeds `genesis: sha256(<tail raw line of
// the prior file>)`, so verifyLedger can walk generations end-to-end
// (verify each file's internal chain, then check each genesis hash against
// the previous generation's last line). Until then we warn at 25MB.

type Env = Record<string, string | undefined>;

export interface WriteReceiptOptions {
  /** gstack home; resolved from env when omitted */
  home?: string;
  /** env for home resolution (tests) */
  env?: Env;
  /** which gstack component is sending */
  sink: string;
  /** destination host[:port] */
  host: string;
  /** content-free payload description */
  payloadClass: string;
  /** exact byte count sent (0 for bodyless requests) */
  bytes?: number;
  /** sha256 hex of the exact bytes sent; null when a subprocess/SDK owns the bytes */
  sha256?: string | null;
  /** the consent key+value that authorizes this send */
  consent: string;
}

export interface WriteOutcomeOptions {
  home?: string;
  env?: Env;
  /** receipt id returned by writeReceipt */
  receipt: string;
  status?: string | number;
}

export interface LedgerLine {
  lineNo: number;
  raw: string;
  record: Record<string, unknown> | null;
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  brokenLine: number | null;
  reason: string | null;
  /** present when the ledger file exceeds LEDGER_WARN_BYTES */
  sizeWarning: string | null;
}

/**
 * Same resolution order as the rest of gstack (shell sinks, selection code):
 * GSTACK_HOME, legacy GSTACK_STATE_DIR, then $HOME/.gstack.
 */
export function resolveEgressHome(env: Env = process.env): string {
  const configured = env.GSTACK_HOME || env.GSTACK_STATE_DIR;
  if (configured) return path.resolve(configured);
  return path.join(env.HOME || os.homedir(), '.gstack');
}

export function egressLedgerPath(home: string): string {
  return path.join(home, 'security', 'egress.jsonl');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function receiptError(message: string, cause?: unknown): Error & { code: string } {
  const error = (cause === undefined ? new Error(message) : new Error(message, { cause })) as Error & { code: string };
  error.code = EGRESS_RECEIPT_FAILED;
  return error;
}

// A serialized receipt line must stay under TAIL_READ_BYTES so the O(1)
// tail-read always captures the FULL previous line before hashing it into the
// chain. A caller-controlled field (sink/host/payloadClass/consent — e.g.
// context-bill builds payloadClass dynamically) long enough to push the line
// past the tail window would make the next append hash a truncated prior line,
// and verifyLedger would then report a permanent false TAMPER. Cap each field
// well under the window so the invariant holds by construction.
const MAX_FIELD_BYTES = 512;

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw receiptError(`Egress receipt requires a non-empty ${name}`);
  if (Buffer.byteLength(value) > MAX_FIELD_BYTES) {
    throw receiptError(`Egress receipt ${name} exceeds ${MAX_FIELD_BYTES} bytes (${Buffer.byteLength(value)})`);
  }
  return value;
}

/**
 * mkdir spin lock, ~2.5s budget. Egress events are rare (minutes apart); the
 * lock only protects the read-last-line → append window.
 *
 * Stale-lock reclaim: a crashed writer strands the lock dir. Once the spin
 * budget is exhausted, a lock dir whose mtime is >10s old is stale by
 * definition (appends take milliseconds), so the waiter removes it and
 * retries instead of failing. The rmdir/stat races with a concurrent
 * reclaimer or the owner's own cleanup are harmless — losers just loop.
 */
function withLedgerLock<T>(ledger: string, callback: () => T): T {
  const lock = `${ledger}.lock`;
  const deadline = Date.now() + 2500;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) {
        try {
          const age = Date.now() - fs.statSync(lock).mtimeMs;
          if (age > 10_000) { fs.rmdirSync(lock); continue; }
        } catch { /* raced with the owner's cleanup — retry */ }
        throw receiptError(`Egress ledger is locked: ${lock}`);
      }
      // Sync sleep (node + bun): the API is sync on purpose so shell, bun,
      // and node callers all share one implementation.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return callback();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* best-effort unlock */ }
  }
}

/**
 * Last raw line via a tail read: open the file, read the final
 * TAIL_READ_BYTES, take the last newline-terminated chunk. Never loads the
 * whole ledger, so appends stay O(1) as the file grows.
 */
function lastRawLine(ledger: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(ledger, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const length = Math.min(size, TAIL_READ_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const tail = buffer.toString('utf8');
    const lines = tail.split('\n').filter((line) => line.length > 0);
    return lines.length ? lines[lines.length - 1] : null;
  } finally {
    fs.closeSync(fd);
  }
}

let warnedLedgerSize = false;

/** Test-only: re-arm the once-per-process size warning. */
export function resetLedgerSizeWarningForTests(): void {
  warnedLedgerSize = false;
}

function warnLedgerSizeOnce(ledger: string): void {
  // Short-circuit BEFORE the stat: the warning fires at most once per process,
  // so after it has fired there is no reason to stat the ledger on every
  // subsequent writeReceipt (this runs on the append hot path).
  if (warnedLedgerSize) return;
  let size: number;
  try {
    size = fs.statSync(ledger).size;
  } catch {
    return; // no file yet — nothing to warn about
  }
  if (size <= LEDGER_WARN_BYTES) return;
  warnedLedgerSize = true;
  process.stderr.write(ledgerSizeWarning(ledger, size) + '\n');
}

/**
 * Self-explanatory size warning: says what the ledger is (records what
 * gstack ATTEMPTS to send off-machine), how to inspect it, and that
 * trimming arrives with rotation.
 */
export function ledgerSizeWarning(ledger: string, size: number): string {
  const mb = (size / (1024 * 1024)).toFixed(1);
  return (
    `gstack: egress ledger is large (${mb}MB): ${ledger}. ` +
    `This file records what gstack ATTEMPTS to send off-machine (content-free receipts, for auditing). ` +
    `Inspect it with 'gstack-egress list'. Trimming arrives with ledger rotation (TODO); until then it only grows.`
  );
}

function appendChained(
  homeOrNull: string | null,
  record: Record<string, unknown>,
  env?: Env,
): { id: string; path: string } {
  const home = homeOrNull ?? resolveEgressHome(env);
  const ledger = egressLedgerPath(home);
  try {
    fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
    return withLedgerLock(ledger, () => {
      const previous = lastRawLine(ledger);
      const line = JSON.stringify({ ...record, prev: previous == null ? '' : sha256Hex(previous) });
      const existed = fs.existsSync(ledger);
      fs.appendFileSync(ledger, `${line}\n`, { mode: 0o600 });
      if (!existed) fs.chmodSync(ledger, 0o600); // umask must not weaken the ledger
      return { id: sha256Hex(line), path: ledger };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === EGRESS_RECEIPT_FAILED) throw error;
    throw receiptError(
      `Egress receipt could not be written to ${ledger}: ${(error as Error)?.message ?? error}`,
      error,
    );
  }
}

/**
 * Append one content-free receipt BEFORE a network send.
 *
 * @returns id = sha256 of the written line (for writeOutcome)
 * @throws Error with code EGRESS_RECEIPT_FAILED — fail-closed callers must
 *   refuse the send; fail-open callers warn and proceed
 */
export function writeReceipt(opts: WriteReceiptOptions): { id: string; path: string } {
  const sink = requireString(opts.sink, 'sink');
  const host = requireString(opts.host, 'host');
  const payloadClass = requireString(opts.payloadClass, 'payloadClass');
  const consent = requireString(opts.consent, 'consent');
  const bytes = opts.bytes ?? 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw receiptError('Egress receipt bytes must be a non-negative integer');
  const sha256 = opts.sha256 ?? null;
  if (sha256 !== null && !SHA256_HEX.test(String(sha256))) throw receiptError('Egress receipt sha256 must be 64 lowercase hex chars or null');
  const home = opts.home ?? resolveEgressHome(opts.env);
  warnLedgerSizeOnce(egressLedgerPath(home));
  return appendChained(home, {
    ts: new Date().toISOString(),
    type: 'egress',
    sink,
    host,
    payload_class: payloadClass,
    bytes,
    sha256,
    consent,
  }, opts.env);
}

/**
 * Append the response status for an earlier receipt (best-effort companion
 * record — the pre-send receipt is the invariant, the outcome is
 * bookkeeping). Chained like every other line.
 */
export function writeOutcome(opts: WriteOutcomeOptions): { id: string; path: string } {
  const receipt = requireString(opts.receipt, 'receipt id');
  return appendChained(opts.home ?? null, {
    ts: new Date().toISOString(),
    type: 'outcome',
    receipt,
    status: String(opts.status ?? 'unknown'),
  }, opts.env);
}

/** Raw parsed lines: [{lineNo, raw, record|null}]. Missing ledger → []. */
export function readLedger(home: string): LedgerLine[] {
  const ledger = egressLedgerPath(home);
  let content: string;
  try {
    content = fs.readFileSync(ledger, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  return content.split('\n').filter((line) => line.length > 0).map((raw, index) => {
    let record: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') record = parsed;
    } catch { /* malformed line — verifyLedger reports it */ }
    return { lineNo: index + 1, raw, record };
  });
}

export interface Receipt {
  ts: string;
  type: 'egress';
  sink: string;
  host: string;
  payload_class: string;
  bytes: number;
  sha256: string | null;
  consent: string;
  prev: string;
  id: string;
  status: string | null;
}

/** Receipts with their joined outcome status (`status: null` = none recorded). */
export function listReceipts(home: string): Receipt[] {
  const lines = readLedger(home);
  const receipts: Receipt[] = [];
  const byId = new Map<string, Receipt>();
  for (const { raw, record } of lines) {
    if (!record) continue;
    if (record.type === 'egress') {
      const entry = { ...(record as unknown as Omit<Receipt, 'id' | 'status'>), id: sha256Hex(raw), status: null };
      receipts.push(entry);
      byId.set(entry.id, entry);
    } else if (record.type === 'outcome' && byId.has(record.receipt as string)) {
      byId.get(record.receipt as string)!.status = String(record.status);
    }
  }
  return receipts;
}

/**
 * Recompute the hash chain. `brokenLine` is the 1-indexed first line whose
 * `prev` no longer matches the sha256 of the previous raw line (or that
 * fails to parse). `sizeWarning` is set when the ledger exceeds
 * LEDGER_WARN_BYTES.
 */
export function verifyLedger(home: string): VerifyResult {
  const ledger = egressLedgerPath(home);
  let sizeWarning: string | null = null;
  try {
    const size = fs.statSync(ledger).size;
    if (size > LEDGER_WARN_BYTES) sizeWarning = ledgerSizeWarning(ledger, size);
  } catch { /* missing ledger — verify of an empty chain below */ }
  const lines = readLedger(home);
  let previousRaw: string | null = null;
  for (const { lineNo, raw, record } of lines) {
    if (!record || typeof record.prev !== 'string') {
      return { ok: false, count: lines.length, brokenLine: lineNo, reason: 'unparseable or missing prev', sizeWarning };
    }
    const expected = previousRaw == null ? '' : sha256Hex(previousRaw);
    if (record.prev !== expected) {
      return { ok: false, count: lines.length, brokenLine: lineNo, reason: 'prev hash does not match previous line', sizeWarning };
    }
    previousRaw = raw;
  }
  return { ok: true, count: lines.length, brokenLine: null, reason: null, sizeWarning };
}

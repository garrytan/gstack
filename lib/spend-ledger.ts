/**
 * spend-ledger — the minimal shared spend ledger (plan B2; E1 extends it).
 * One JSON file per run (`<out>/spend.json`), mutated only under a file lock
 * so concurrent workers never admit past the cap: `reserve` admits an attempt
 * only when `spent + reserved + next_estimate <= cap`; `settle` moves a
 * reservation to `spent` (or to `unknown`, kept at its reservation, when the
 * host dispatched the work and no price is known: host-subagent spend is
 * `unknown`, never zero); `release` drops a reservation that never ran.
 * Reservations are plain rows in the file, so a crash between reserve and
 * settle leaves the attempt reserved until someone settles or releases it;
 * nothing is forgotten on restart. Admission is an estimate: the price table
 * is incomplete and actual cost reconciles at settle time, which is why the
 * summary shows `worst_case` (spent + reserved + unknown) beside `spent`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Reservation { attempt: string; estimate_usd: number; at: string; label?: string }
export interface Settlement { attempt: string; usd: number | 'unknown'; reserved_usd: number; at: string; label?: string }
export interface SpendLedger {
  schema_version: 1;
  cap_usd: number | null;
  spent_usd: number;
  reserved: Reservation[];
  settled: Settlement[];
  released: Array<{ attempt: string; estimate_usd: number; at: string }>;
}
export interface SpendSummary {
  cap_usd: number | null; spent_usd: number; reserved_usd: number; unknown_usd: number; unknown_count: number;
  worst_case_usd: number; headroom_usd: number | null; open_attempts: string[];
}

export class SpendCapExceeded extends Error {
  code = 'SPEND_CAP_EXCEEDED' as const;
  constructor(public readonly detail: { cap_usd: number; spent_usd: number; reserved_usd: number; estimate_usd: number }) {
    super(`spent ${detail.spent_usd} + reserved ${detail.reserved_usd} + estimate ${detail.estimate_usd} > cap ${detail.cap_usd}`);
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function emptyLedger(cap: number | null): SpendLedger {
  return { schema_version: 1, cap_usd: cap, spent_usd: 0, reserved: [], settled: [], released: [] };
}

export function readLedger(file: string, cap: number | null = null): SpendLedger {
  if (!fs.existsSync(file)) return emptyLedger(cap);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SpendLedger;
  if (parsed.schema_version !== 1) throw new Error(`${file}: schema_version ${parsed.schema_version} is not 1`);
  return parsed;
}

function writeLedger(file: string, ledger: SpendLedger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Exclusive-create lock with a stale-owner check; the lock holds for one mutation only. */
export function withFileLock<T>(file: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lock = `${file}.lock`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: number; host?: string; at?: string };
        const age = Date.now() - Date.parse(owner.at ?? '');
        const sameHost = owner.host === os.hostname();
        let alive = true;
        if (sameHost && typeof owner.pid === 'number') {
          try { process.kill(owner.pid, 0); } catch (k: any) { alive = k.code === 'EPERM'; }
        }
        stale = (sameHost && !alive) || (Number.isFinite(age) && age > staleMs);
      } catch { stale = true; }
      if (stale) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 20));
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}

export function summarize(ledger: SpendLedger): SpendSummary {
  const reserved = round(ledger.reserved.reduce((s, r) => s + r.estimate_usd, 0));
  const unknown = ledger.settled.filter(s => s.usd === 'unknown');
  const unknownUsd = round(unknown.reduce((s, r) => s + r.reserved_usd, 0));
  const worst = round(ledger.spent_usd + reserved + unknownUsd);
  return {
    cap_usd: ledger.cap_usd, spent_usd: round(ledger.spent_usd), reserved_usd: reserved, unknown_usd: unknownUsd,
    unknown_count: unknown.length, worst_case_usd: worst,
    headroom_usd: ledger.cap_usd === null ? null : round(ledger.cap_usd - worst),
    open_attempts: ledger.reserved.map(r => r.attempt),
  };
}

/** Admit one attempt: `spent + reserved + unknown + estimate <= cap`, atomically under the lock. */
export function reserve(file: string, attempt: string, estimateUsd: number, opts: { cap?: number | null; label?: string; now?: Date } = {}): SpendLedger {
  if (!Number.isFinite(estimateUsd) || estimateUsd < 0) throw new Error(`estimate must be a non-negative number, got ${estimateUsd}`);
  return withFileLock(file, () => {
    const ledger = readLedger(file, opts.cap ?? null);
    if (opts.cap !== undefined) ledger.cap_usd = opts.cap;
    if (ledger.reserved.some(r => r.attempt === attempt)) return ledger;
    if (ledger.settled.some(s => s.attempt === attempt)) throw new Error(`attempt ${attempt} is already settled`);
    const summary = summarize(ledger);
    if (ledger.cap_usd !== null && round(summary.worst_case_usd + estimateUsd) > ledger.cap_usd) {
      throw new SpendCapExceeded({ cap_usd: ledger.cap_usd, spent_usd: summary.spent_usd, reserved_usd: round(summary.reserved_usd + summary.unknown_usd), estimate_usd: estimateUsd });
    }
    ledger.reserved.push({ attempt, estimate_usd: round(estimateUsd), at: (opts.now ?? new Date()).toISOString(), ...(opts.label ? { label: opts.label } : {}) });
    writeLedger(file, ledger);
    return ledger;
  });
}

/** Move a reservation to spent (actual cost) or to unknown (kept at its reservation). Idempotent per attempt. */
export function settle(file: string, attempt: string, usd: number | 'unknown', opts: { now?: Date } = {}): SpendLedger {
  if (usd !== 'unknown' && (!Number.isFinite(usd) || usd < 0)) throw new Error(`usd must be 'unknown' or a non-negative number, got ${usd}`);
  return withFileLock(file, () => {
    const ledger = readLedger(file);
    if (ledger.settled.some(s => s.attempt === attempt)) return ledger;
    const i = ledger.reserved.findIndex(r => r.attempt === attempt);
    const reservation = i >= 0 ? ledger.reserved.splice(i, 1)[0]! : { attempt, estimate_usd: 0, at: '' };
    if (usd !== 'unknown') ledger.spent_usd = round(ledger.spent_usd + usd);
    ledger.settled.push({ attempt, usd: usd === 'unknown' ? 'unknown' : round(usd), reserved_usd: reservation.estimate_usd, at: (opts.now ?? new Date()).toISOString(), ...(reservation.label ? { label: reservation.label } : {}) });
    writeLedger(file, ledger);
    return ledger;
  });
}

/** Drop a reservation for an attempt that never ran (cancelled before dispatch). */
export function release(file: string, attempt: string, opts: { now?: Date } = {}): SpendLedger {
  return withFileLock(file, () => {
    const ledger = readLedger(file);
    const i = ledger.reserved.findIndex(r => r.attempt === attempt);
    if (i < 0) return ledger;
    const [row] = ledger.reserved.splice(i, 1);
    ledger.released.push({ attempt, estimate_usd: row!.estimate_usd, at: (opts.now ?? new Date()).toISOString() });
    writeLedger(file, ledger);
    return ledger;
  });
}

export function renderSpend(summary: SpendSummary): string {
  const cap = summary.cap_usd === null ? 'none' : summary.cap_usd.toFixed(2);
  return `SPEND: spent=${summary.spent_usd.toFixed(2)} reserved=${summary.reserved_usd.toFixed(2)} unknown=${summary.unknown_count}(${summary.unknown_usd.toFixed(2)}) worst_case=${summary.worst_case_usd.toFixed(2)} cap=${cap}`;
}

/** One content-free line per guarded /autoplan decision, so denials have a denominator. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveStateRoot } from '../../lib/state-root';

export const GUARD_LOG_SCHEMA = 1;
export const GUARD_LOG_KEEP_LINES = 1_000;
export const GUARD_LOG_TRIM_BYTES = 256 * 1024;

export interface GuardLogEntry {
  decision: 'allow' | 'deny';
  /** allow, unverified, or the denial's fallback/corrective/transient class. */
  disposition: 'allow' | 'unverified' | 'fallback' | 'corrective' | 'transient';
  code?: string;
  path: 'journal' | 'payload' | 'none';
  claudeVersion?: string;
  /** Names only (never values) of Agent keys outside the allowlist. */
  unknownKeys?: string[];
  recordTypes?: string[];
}

export const guardLogPath = () => path.join(resolveStateRoot(), 'analytics', 'autoplan-guard.jsonl');

/** Append-only; past the byte bound keep the newest lines via temp file + rename. A logging failure never changes a decision. */
export function logGuardDecision(entry: GuardLogEntry, now = new Date()): void {
  try {
    const file = guardLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ schema: GUARD_LOG_SCHEMA, ts: now.toISOString(), decision: entry.decision,
      disposition: entry.disposition, code: entry.code ?? null, path: entry.path, claude_code_version: entry.claudeVersion ?? null,
      ...(entry.unknownKeys?.length ? { unknown_keys: entry.unknownKeys } : {}),
      ...(entry.recordTypes?.length ? { record_types: entry.recordTypes } : {}) }) + '\n');
    if (fs.statSync(file).size <= GUARD_LOG_TRIM_BYTES) return;
    const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-GUARD_LOG_KEEP_LINES);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, kept.join('\n') + '\n');
    // A concurrent trim may win; losing that race only keeps a few more lines.
    try { fs.renameSync(temp, file); } catch { fs.rmSync(temp, { force: true }); }
  } catch { /* A logging failure never changes the verdict. */ }
}

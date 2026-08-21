/**
 * Persistent command audit log — forensic trail for all browse server commands.
 *
 * Writes append-only JSONL to .gstack/browse-audit.jsonl. Unlike the in-memory
 * ring buffers (console, network, dialog), the audit log persists across server
 * restarts and is never truncated by the server. Each entry records:
 *
 *   - timestamp, command, args (truncated), page origin
 *   - duration, status (ok/error), error message if any
 *   - whether cookies were imported (elevated security context)
 *   - connection mode (headless/headed)
 *
 * All writes are best-effort — audit failures never cause command failures. They
 * are NOT silent, though: a broken forensic trail is itself a finding, so the
 * first failure warns on stderr (see warnOnce) and writeAuditEntry reports
 * whether the record landed.
 */

import * as fs from 'fs';
import { warnOnce } from './error-handling';

export interface AuditEntry {
  ts: string;
  cmd: string;
  /** If the agent typed an alias (e.g. 'setcontent'), the raw input is preserved here
   *  while `cmd` holds the canonical name ('load-html'). Omitted when cmd === rawCmd. */
  aliasOf?: string;
  args: string;
  origin: string;
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
  hasCookies: boolean;
  mode: 'launched' | 'headed';
}

const MAX_ARGS_LENGTH = 200;
const MAX_ERROR_LENGTH = 300;

let auditPath: string | null = null;

export function initAuditLog(logPath: string): void {
  auditPath = logPath;
}

/** Append one entry. Returns false when the record was not persisted. */
export function writeAuditEntry(entry: AuditEntry): boolean {
  if (!auditPath) return false;
  try {
    const truncatedArgs = entry.args.length > MAX_ARGS_LENGTH
      ? entry.args.slice(0, MAX_ARGS_LENGTH) + '…'
      : entry.args;
    const truncatedError = entry.error && entry.error.length > MAX_ERROR_LENGTH
      ? entry.error.slice(0, MAX_ERROR_LENGTH) + '…'
      : entry.error;

    const record: Record<string, unknown> = {
      ts: entry.ts,
      cmd: entry.cmd,
      args: truncatedArgs,
      origin: entry.origin,
      durationMs: entry.durationMs,
      status: entry.status,
      hasCookies: entry.hasCookies,
      mode: entry.mode,
    };
    if (entry.aliasOf) record.aliasOf = entry.aliasOf;
    if (truncatedError) record.error = truncatedError;

    fs.appendFileSync(auditPath, JSON.stringify(record) + '\n');
    return true;
  } catch (err) {
    // Never block command execution — but don't lose the trail silently either.
    warnOnce('audit-write', `[audit] write to ${auditPath} failed; command audit trail is incomplete`, err);
    return false;
  }
}

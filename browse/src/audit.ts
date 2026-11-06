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
 * All writes are best-effort — audit failures never cause command failures.
 */

import { appendSecureFile } from './file-permissions';

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

/*
 * Value redaction. The args reach this module as one string (server.ts joins
 * them) and the log is plain JSONL on disk, so a `fill #password <value>`,
 * `type <value>`, `cookie name=<value>` or `header Authorization: <value>`
 * would otherwise persist the credential verbatim. The value is redacted here,
 * before truncation and before the line exists, for every command that carries
 * a typed value: fill (the selector stays), type, js, dialog-accept (all of
 * it), cookie and header (the name stays), storage set (the key stays). The
 * rest of the string after the kept part is treated as the value, so a
 * selector that contains spaces loses its tail too: more is hidden, never
 * less. A cookie/header with no separator is redacted whole. The error text is
 * scrubbed of the same value (whole, and each whitespace-separated piece of 4+
 * characters), because a page or Playwright error can echo it back.
 */
export const REDACTED = '<redacted>';
const REDACT_WHOLE = new Set(['type', 'js', 'dialog-accept']);

export function redactArgs(cmd: string, args: string): { args: string; secret: string | null } {
  if (!args) return { args, secret: null };
  if (REDACT_WHOLE.has(cmd)) return { args: REDACTED, secret: args };
  if (cmd === 'fill') {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(args);
    return m ? { args: `${m[1]} ${REDACTED}`, secret: m[2] } : { args, secret: null };
  }
  if (cmd === 'cookie' || cmd === 'header') {
    const sep = cmd === 'cookie' ? '=' : ':';
    const at = args.indexOf(sep);
    if (at <= 0) return { args: REDACTED, secret: args };
    return { args: `${args.slice(0, at + 1)}${REDACTED}`, secret: args.slice(at + 1) };
  }
  if (cmd === 'storage') {
    const m = /^(set\s+\S+)\s+([\s\S]+)$/.exec(args);
    return m ? { args: `${m[1]} ${REDACTED}`, secret: m[2] } : { args, secret: null };
  }
  return { args, secret: null };
}

export function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  let out = text.split(secret).join(REDACTED);
  for (const piece of secret.split(/\s+/)) {
    if (piece.length >= 4) out = out.split(piece).join(REDACTED);
  }
  return out;
}
const MAX_ERROR_LENGTH = 300;

let auditPath: string | null = null;

export function initAuditLog(logPath: string): void {
  auditPath = logPath;
}

export function writeAuditEntry(entry: AuditEntry): void {
  if (!auditPath) return;
  try {
    const { args: safeArgs, secret } = redactArgs(entry.cmd, entry.args);
    const safeError = entry.error ? scrubSecret(entry.error, secret) : entry.error;
    const truncatedArgs = safeArgs.length > MAX_ARGS_LENGTH
      ? safeArgs.slice(0, MAX_ARGS_LENGTH) + '…'
      : safeArgs;
    const truncatedError = safeError && safeError.length > MAX_ERROR_LENGTH
      ? safeError.slice(0, MAX_ERROR_LENGTH) + '…'
      : safeError;

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

    appendSecureFile(auditPath, JSON.stringify(record) + '\n');
  } catch {
    // Audit write failures are silent — never block command execution
  }
}

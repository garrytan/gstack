/**
 * Persistent command audit log — forensic trail for all browse server commands.
 *
 * Writes append-only JSONL to .gstack/browse-audit.jsonl. Unlike the in-memory
 * ring buffers (console, network, dialog), the audit log persists across server
 * restarts and is never truncated by the server. Each entry records:
 *
 *   - timestamp, command, args (typed values redacted, then truncated), page
 *     origin (scheme, host and path, with every query value redacted)
 *   - duration, status (ok/error), error message if any
 *   - whether cookies were imported (elevated security context)
 *   - connection mode (headless/headed)
 *
 * The log is plain text on disk, so every value a command types (a fill
 * value, typed text, a js expression, a prompt answer, a cookie, header,
 * storage or skill-arg value) is replaced with [REDACTED] before truncation,
 * and the error text is scrubbed of the same values. Navigation and click
 * args are kept as typed. The page origin keeps its query parameter names but
 * not their values, since a GET form puts whatever the user typed there.
 *
 * All writes are best-effort — audit failures never cause command failures.
 */

import { ALL_COMMANDS, canonicalizeCommand } from './commands';
import { appendSecureFile } from './file-permissions';

export interface AuditEntry {
  ts: string;
  cmd: string;
  /** If the agent typed an alias (e.g. 'setcontent'), the raw input is preserved here
   *  while `cmd` holds the canonical name ('load-html'). Omitted when cmd === rawCmd. */
  aliasOf?: string;
  args: string[];
  origin: string;
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
  hasCookies: boolean;
  mode: 'launched' | 'headed';
}

const MAX_ARGS_LENGTH = 200;
const MAX_ERROR_LENGTH = 300;

const REDACTED = '[REDACTED]';

let auditPath: string | null = null;

interface RedactedArgs {
  args: string[];
  secrets: string[];
}

function redactAfterSeparator(args: string[], sep: string): RedactedArgs {
  const joined = args.join(' ');
  const at = joined.indexOf(sep);
  if (at <= 0) return { args: [REDACTED], secrets: [joined] };
  return { args: [joined.slice(0, at + 1) + REDACTED], secrets: [joined.slice(at + 1).trim()] };
}

/**
 * A chain line keeps only the step names that are real commands, never their
 * args: every step writes its own audit line with its exact args redacted per
 * command, and a second parse of the flow text here could differ from chain's.
 */
function redactChain(flow: string): RedactedArgs {
  let steps: string[][];
  try {
    const parsed = JSON.parse(flow);
    if (!Array.isArray(parsed) || !parsed.every(step => Array.isArray(step))) return { args: [REDACTED], secrets: [flow] };
    steps = parsed.map(step => step.map(String));
  } catch {
    steps = flow.split(' | ').map(seg => seg.trim().split(/\s+/));
  }
  const names = steps.map(([name = '']) => (ALL_COMMANDS.has(canonicalizeCommand(name)) ? name : REDACTED));
  const secrets = steps.map((step, i) => (names[i] === REDACTED ? step : step.slice(1)).join(' '));
  return { args: [names.join(' | ')], secrets };
}

/** Replace the typed value of every value-carrying command with [REDACTED]. */
export function redactCommandArgs(rawCmd: string, args: string[]): RedactedArgs {
  if (args.length === 0) return { args, secrets: [] };
  const cmd = canonicalizeCommand(rawCmd);
  switch (cmd) {
    case 'fill':
      if (args.length < 2) return { args: [REDACTED], secrets: [args.join(' ')] };
      return { args: [args[0], REDACTED], secrets: [args.slice(1).join(' ')] };
    case 'type': {
      const kept: string[] = [];
      let i = 0;
      if (args[i] === '--selector') { kept.push(...args.slice(i, i + 2)); i += 2; }
      if (args[i] === '--') { kept.push('--'); i += 1; }
      const text = args.slice(i);
      if (text.length === 0) return { args: [REDACTED], secrets: [args.join(' ')] };
      return { args: [...kept, REDACTED], secrets: [text.join(' ')] };
    }
    case 'js': {
      const kept: string[] = [];
      const expr: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--out' && i + 1 < args.length) { kept.push('--out', args[++i]); continue; }
        if (args[i] === '--raw') { kept.push('--raw'); continue; }
        expr.push(args[i]);
      }
      if (expr.length === 0) return { args, secrets: [] };
      return { args: [REDACTED, ...kept], secrets: [expr.join(' ')] };
    }
    case 'dialog-accept':
      return { args: [REDACTED], secrets: [args.join(' ')] };
    case 'cookie':
      return redactAfterSeparator(args, '=');
    case 'header':
      return redactAfterSeparator(args, ':');
    case 'storage':
      if (args[0] !== 'set' || args.length < 2) return { args, secrets: [] };
      if (args.length < 3) return { args: [args[0], REDACTED], secrets: [args[1]] };
      return { args: [args[0], args[1], REDACTED], secrets: [args.slice(2).join(' ')] };
    case 'skill': {
      if (args[0] !== 'run' || args.length < 3) return { args, secrets: [] };
      const out = args.slice(0, 2);
      const secrets: string[] = [];
      for (const a of args.slice(2)) {
        if (a === '--arg' || a.startsWith('--timeout=')) { out.push(a); continue; }
        const eq = a.indexOf('=');
        out.push(eq > 0 ? a.slice(0, eq + 1) + REDACTED : REDACTED);
        secrets.push(eq > 0 ? a.slice(eq + 1) : a);
      }
      return { args: out, secrets };
    }
    case 'tab-each': {
      if (!ALL_COMMANDS.has(canonicalizeCommand(args[0]))) return { args: [REDACTED], secrets: [args.join(' ')] };
      const inner = redactCommandArgs(args[0], args.slice(1));
      return { args: [args[0], ...inner.args], secrets: inner.secrets };
    }
    case 'chain':
      return redactChain(args[0]);
    default:
      return { args, secrets: [] };
  }
}

/**
 * Keep a URL's scheme, host and path and its query parameter names. Userinfo
 * and the fragment are dropped and every query value becomes [REDACTED]: page
 * and request URLs carry GET form fields and tokens under names no list covers.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.split(/[?#]/)[0];
  }
  const query = url.search.slice(1).split('&').filter(Boolean).map(piece => {
    const eq = piece.indexOf('=');
    return eq > 0 && /[^=]/.test(piece.slice(eq + 1)) ? piece.slice(0, eq + 1) + REDACTED : REDACTED;
  });
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return query.length ? `${url.href}?${query.join('&')}` : url.href;
}

/**
 * Remove every redacted value, its JSON-escaped form and each piece of it (split
 * on whitespace and on punctuation, since a js error echoes a bare identifier)
 * from text. A piece counts when it has 4+ chars, or 2-3 chars with a digit (a
 * CVV, an expiry month); shorter word pieces like "a" or "is" would shred
 * ordinary error prose. Needles under 6 chars match only as whole tokens, so a
 * short value neither shreds the error nor shows through the text around it.
 */
export function scrubSecrets(text: string, secrets: string[]): string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    needles.add(secret);
    needles.add(JSON.stringify(secret).slice(1, -1));
    for (const piece of [...secret.split(/\s+/), ...secret.split(/[^A-Za-z0-9_$.-]+/)]) {
      if (piece.length >= 4 || (piece.length >= 2 && /\d/.test(piece))) {
        needles.add(piece);
        needles.add(JSON.stringify(piece).slice(1, -1));
      }
    }
  }
  let out = text;
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    if (!needle) continue;
    if (needle.length >= 6) { out = out.split(needle).join(REDACTED); continue; }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'), REDACTED);
  }
  return out;
}

export function initAuditLog(logPath: string): void {
  auditPath = logPath;
}

export function writeAuditEntry(entry: AuditEntry): void {
  if (!auditPath) return;
  try {
    const redacted = redactCommandArgs(entry.cmd, entry.args);
    const args = redacted.args.join(' ');
    const error = entry.error ? scrubSecrets(entry.error, redacted.secrets) : entry.error;
    const truncatedArgs = args.length > MAX_ARGS_LENGTH
      ? args.slice(0, MAX_ARGS_LENGTH) + '…'
      : args;
    const truncatedError = error && error.length > MAX_ERROR_LENGTH
      ? error.slice(0, MAX_ERROR_LENGTH) + '…'
      : error;

    const record: Record<string, unknown> = {
      ts: entry.ts,
      cmd: entry.cmd,
      args: truncatedArgs,
      origin: redactUrl(entry.origin),
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

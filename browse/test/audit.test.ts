/**
 * Unit tests for browse/src/audit.ts — the persistent command audit log.
 *
 * Audit writes stay non-fatal, but a failure must be reported (return value +
 * one stderr line) rather than swallowed: a silently truncated forensic trail
 * is indistinguishable from "no commands ran".
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initAuditLog, writeAuditEntry, type AuditEntry } from '../src/audit';
import { _resetWarnOnce } from '../src/error-handling';

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-04-19T12:34:56Z',
    cmd: 'goto',
    args: 'https://example.com',
    origin: 'https://example.com',
    durationMs: 12,
    status: 'ok',
    hasCookies: false,
    mode: 'launched',
    ...over,
  };
}

function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

describe('writeAuditEntry', () => {
  test('appends one JSONL record and reports success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-audit-'));
    const logPath = path.join(dir, 'browse-audit.jsonl');
    initAuditLog(logPath);
    expect(writeAuditEntry(entry())).toBe(true);
    expect(writeAuditEntry(entry({ cmd: 'click', status: 'error', error: 'no such element' }))).toBe(true);

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).cmd).toBe('goto');
    expect(JSON.parse(lines[1]).error).toBe('no such element');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reports a write failure instead of swallowing it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-audit-'));
    // A directory where the log file should be: appendFileSync throws EISDIR.
    const logPath = path.join(dir, 'as-a-directory');
    fs.mkdirSync(logPath);
    initAuditLog(logPath);
    _resetWarnOnce();

    let ok: boolean | undefined;
    const lines = captureStderr(() => { ok = writeAuditEntry(entry()); });
    expect(ok).toBe(false);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('audit trail is incomplete');

    // Deduped: a failing audit path must not flood the log on every command.
    const again = captureStderr(() => { writeAuditEntry(entry()); });
    expect(again.length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns false when no audit path has been initialized', () => {
    initAuditLog('');
    expect(writeAuditEntry(entry())).toBe(false);
  });
});

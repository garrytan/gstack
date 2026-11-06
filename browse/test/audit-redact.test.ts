import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { REDACTED, initAuditLog, redactArgs, scrubSecret, writeAuditEntry } from '../src/audit';

// ─── redactArgs: the typed value never reaches the audit line ─────────
//
// server.ts joins the command's args into ONE string before writeAuditEntry
// sees them, so the redaction has to work on the string form: a scrub that
// only matched an array form missed `fill #password hunter2` entirely.

describe('redactArgs', () => {
  it('keeps the fill selector and hides the value', () => {
    expect(redactArgs('fill', '#password hunter2')).toEqual({ args: `#password ${REDACTED}`, secret: 'hunter2' });
  });

  it('hides everything after the selector, so a value with spaces is whole-hidden', () => {
    const r = redactArgs('fill', 'input[name=pw] correct horse battery');
    expect(r.args).toBe(`input[name=pw] ${REDACTED}`);
    expect(r.secret).toBe('correct horse battery');
  });

  it('redacts type, js and dialog-accept whole', () => {
    for (const cmd of ['type', 'js', 'dialog-accept']) {
      expect(redactArgs(cmd, 'secret text')).toEqual({ args: REDACTED, secret: 'secret text' });
    }
  });

  it('keeps the cookie and header name, hides the value', () => {
    expect(redactArgs('cookie', 'session=abc123')).toEqual({ args: `session=${REDACTED}`, secret: 'abc123' });
    expect(redactArgs('header', 'Authorization: Bearer tok')).toEqual({ args: `Authorization:${REDACTED}`, secret: ' Bearer tok' });
  });

  it('redacts a cookie or header with no separator whole', () => {
    expect(redactArgs('cookie', 'abc123')).toEqual({ args: REDACTED, secret: 'abc123' });
    expect(redactArgs('header', '=leading')).toEqual({ args: REDACTED, secret: '=leading' });
  });

  it('keeps the storage key on set and leaves other storage subcommands alone', () => {
    expect(redactArgs('storage', 'set token xyz')).toEqual({ args: `set token ${REDACTED}`, secret: 'xyz' });
    expect(redactArgs('storage', 'get token')).toEqual({ args: 'get token', secret: null });
  });

  it('leaves commands without a typed value untouched', () => {
    expect(redactArgs('goto', 'https://example.com/login')).toEqual({ args: 'https://example.com/login', secret: null });
    expect(redactArgs('click', '@e3')).toEqual({ args: '@e3', secret: null });
    expect(redactArgs('fill', '')).toEqual({ args: '', secret: null });
  });
});

describe('scrubSecret', () => {
  it('removes the whole secret and each 4+ character piece from an error', () => {
    const out = scrubSecret('Timeout filling "correct horse" with value correct horse battery', 'correct horse battery');
    expect(out).not.toContain('correct');
    expect(out).not.toContain('horse');
    expect(out).not.toContain('battery');
    expect(out).toContain(REDACTED);
  });

  it('is a no-op without a secret', () => {
    expect(scrubSecret('plain error', null)).toBe('plain error');
  });
});

// ─── writeAuditEntry: the on-disk line carries the redaction ───────────

describe('writeAuditEntry redaction', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-audit-'));
    logPath = path.join(dir, 'browse-audit.jsonl');
    initAuditLog(logPath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function entry(cmd: string, args: string, error?: string) {
    return {
      ts: '2026-01-01T00:00:00.000Z',
      cmd,
      args,
      origin: 'https://example.com',
      durationMs: 1,
      status: error ? ('error' as const) : ('ok' as const),
      error,
      hasCookies: false,
      mode: 'launched' as const,
    };
  }

  it('never writes a fill value, even when the page error echoes it', () => {
    writeAuditEntry(entry('fill', '#password hunter2', 'could not fill "#password" with "hunter2"'));
    const raw = fs.readFileSync(logPath, 'utf8');
    expect(raw).not.toContain('hunter2');
    const line = JSON.parse(raw.trim());
    expect(line.args).toBe(`#password ${REDACTED}`);
    expect(line.error).toBe(`could not fill "#password" with "${REDACTED}"`);
  });

  it('redacts before truncation, so a long value cannot leak its head', () => {
    const long = 'x'.repeat(500);
    writeAuditEntry(entry('type', long));
    const line = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    expect(line.args).toBe(REDACTED);
  });

  it('keeps a navigation line readable', () => {
    writeAuditEntry(entry('goto', 'https://example.com/login'));
    const line = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    expect(line.args).toBe('https://example.com/login');
  });
});

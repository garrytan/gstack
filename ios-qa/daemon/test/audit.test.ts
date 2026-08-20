// Audit + attempts logging tests. Codex-flagged: identity must be hashed in
// attempts.jsonl (no raw identity leak), rotation works, sanitize-replacer
// strips lone surrogates.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeAudit, writeAttempt, sanitizeReplacer } from '../src/audit';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ios-qa-audit-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeAudit', () => {
  test('appends a JSONL row', async () => {
    const path = join(tmpDir, 'audit.jsonl');
    await writeAudit({
      ts: '2026-05-18T00:00:00Z',
      identity: 'u@e.com',
      device_udid: 'UDID-1',
      endpoint: 'POST /tap',
      session_id: 'S1',
      capability: 'interact',
      request_id: 'req-1',
      status: 200,
    }, path);
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).identity).toBe('u@e.com');
  });
});

describe('writeAttempt', () => {
  test('hashes raw identity with the device salt (no raw leak)', async () => {
    const auditPath = join(tmpDir, 'attempts.jsonl');
    await writeAttempt({
      rawIdentity: 'attacker@evil.com',
      endpoint: 'POST /auth/mint',
      reason: 'identity_not_allowed',
      path: auditPath,
    });
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row.reason).toBe('identity_not_allowed');
    expect(row.identity_canon).not.toBe('attacker@evil.com');
    expect(row.identity_canon).toMatch(/^[a-f0-9]{16}$/); // 16-char hex
  });

  test('does NOT log the raw identity anywhere in the row', async () => {
    const path = join(tmpDir, 'attempts.jsonl');
    await writeAttempt({
      rawIdentity: 'secret@example.com',
      endpoint: 'POST /auth/mint',
      reason: 'identity_not_allowed',
      path,
    });
    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toContain('secret@example.com');
  });
});

describe('sanitizeReplacer', () => {
  // Helper: check every UTF-16 code unit in a string. Returns true iff any
  // unpaired surrogate is present. More reliable than .toContain('\uD800')
  // since Bun's matcher does UTF-8 byte comparison for non-ASCII.
  const hasUnpairedSurrogate = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = s.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
        i++; // skip the valid pair
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        return true;
      }
    }
    return false;
  };

  test('replaces lone high surrogates with U+FFFD', () => {
    const out = JSON.stringify({ s: 'before\uD800after' }, sanitizeReplacer);
    expect(hasUnpairedSurrogate(out)).toBe(false);
    expect(out.includes('�')).toBe(true);
  });

  test('replaces lone low surrogates with U+FFFD', () => {
    const out = JSON.stringify({ s: 'before\uDC00after' }, sanitizeReplacer);
    expect(hasUnpairedSurrogate(out)).toBe(false);
    expect(out.includes('�')).toBe(true);
  });

  test('preserves valid surrogate pairs', () => {
    // 😀 = U+1F600 = surrogate pair D83D DE00. Must stay intact.
    const out = JSON.stringify({ s: '😀' }, sanitizeReplacer);
    expect(out.includes('😀')).toBe(true);
    expect(hasUnpairedSurrogate(out)).toBe(false);
    expect(out.includes('�')).toBe(false);
  });

  test('passes through non-string values', () => {
    expect(JSON.stringify({ n: 42, b: true, x: null }, sanitizeReplacer)).toBe('{"n":42,"b":true,"x":null}');
  });
});

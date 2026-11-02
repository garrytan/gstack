/**
 * #3659: gstack-jsonl-merge read its inputs as UTF-8 but wrote them with
 * print(), so a redirected stdout on a legacy code page (cp1250 on the
 * reporter's Windows) raised UnicodeEncodeError on a Cyrillic line, and any
 * Windows Python rewrote LF as CRLF. The driver must write UTF-8 with LF
 * whatever the platform and code page. PYTHONIOENCODING=cp1252 reproduces the
 * legacy code page on every OS.
 *
 * Windows-safe by construction: the driver launches through
 * lib/script-invocation.ts (Git Bash on win32), files live under os.tmpdir().
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
let tmp = '';

beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-jsonl-enc-'))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a line the stdout code page cannot encode merges as UTF-8 with LF endings (#3659)', () => {
  const base = '{"ts":"2026-01-01T00:00:00Z","note":"base"}\n';
  const ours = base + '{"ts":"2026-01-02T00:00:00Z","note":"ours"}\n';
  const theirsLine = '{"ts":"2026-01-03T00:00:00Z","note":"привет"}';
  const p = (n: string) => path.join(tmp, n);
  fs.writeFileSync(p('base'), base);
  fs.writeFileSync(p('ours'), ours);
  fs.writeFileSync(p('theirs'), base + theirsLine + '\n');
  const posix = (f: string) => f.replace(/\\/g, '/');
  const r = runScriptSync(path.join(ROOT, 'bin', 'gstack-jsonl-merge'), [posix(p('base')), posix(p('ours')), posix(p('theirs'))], {
    env: { ...process.env, PYTHONIOENCODING: 'cp1252', PYTHONUTF8: '0' }, encoding: 'utf8', timeout: 60_000,
  });
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  const bytes = fs.readFileSync(p('ours'));
  expect(bytes.includes(0x0d)).toBe(false);
  expect(bytes.toString('utf8')).toBe(ours + theirsLine + '\n');
});

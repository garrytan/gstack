/**
 * WS1 flake-ledger unit tests: the free runner's FLAKY-PASS events become a
 * durable JSONL series (single writer: the parent runner). Fail-open is the
 * contract — a broken ledger warns loudly but must never turn a real verdict
 * into a failure on the only required lane.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendFlakeLedger, flakeLedgerPath, type FlakeLedgerEntry } from '../scripts/test-free-shards';

const entry = (file: string): FlakeLedgerEntry => ({
  ts: '2026-08-31T00:00:00.000Z',
  runner: 'free',
  kind: 'flaky-pass',
  file,
  shard: 2,
});

describe('flake ledger', () => {
  test('appends one JSONL line per entry, creating parent dirs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-ledger-'));
    const ledger = path.join(dir, 'nested', 'ledger.jsonl');
    expect(appendFlakeLedger([entry('test/a.test.ts')], ledger)).toBe(true);
    expect(appendFlakeLedger([entry('test/b.test.ts'), entry('test/c.test.ts')], ledger)).toBe(true);
    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ runner: 'free', kind: 'flaky-pass', file: 'test/a.test.ts', shard: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('empty entry list is a no-op success (no file created)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-ledger-'));
    const ledger = path.join(dir, 'ledger.jsonl');
    expect(appendFlakeLedger([], ledger)).toBe(true);
    expect(fs.existsSync(ledger)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('FAIL-OPEN: an unwritable path warns and returns false, never throws', () => {
    const warnings: string[] = [];
    // A path whose parent is a FILE cannot be mkdir'd — deterministic EEXIST/ENOTDIR.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flake-ledger-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a dir');
    const ledger = path.join(blocker, 'ledger.jsonl');
    const ok = appendFlakeLedger([entry('test/a.test.ts')], ledger, (l) => warnings.push(l));
    expect(ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('verdict unaffected');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('env override wins; local default is project-scoped, never machine-global', () => {
    expect(flakeLedgerPath({ GSTACK_FLAKE_LEDGER: '/x/y.jsonl' } as NodeJS.ProcessEnv)).toBe('/x/y.jsonl');
    // Without the env override, the default lives under the PROJECT dir
    // (sibling worktrees of different repos must not interleave one series);
    // tmpdir is only the last-resort fallback when slug detection fails.
    const local = flakeLedgerPath({} as NodeJS.ProcessEnv);
    expect(local).toMatch(/flake-ledger\.jsonl$/);
    expect(local.includes(path.join('.gstack', 'projects')) || local.startsWith(os.tmpdir())).toBe(true);
  });
});

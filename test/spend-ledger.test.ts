/**
 * lib/spend-ledger.ts (plan B2): admission is `spent + reserved + unknown +
 * estimate <= cap` under a file lock; reservations survive a crash; unknown
 * settlements count at their reservation; concurrent writers never admit past
 * the cap. Pins the wire contract (file shape, codes, counts), not prose.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SpendCapExceeded, readLedger, release, renderSpend, reserve, settle, summarize } from '../lib/spend-ledger';

const ROOT = path.resolve(import.meta.dir, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-ledger-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const ledgerFile = () => path.join(TMP, `run-${++n}`, 'spend.json');

describe('spend ledger admission', () => {
  test('reserve admits up to the cap and refuses the attempt that would cross it, leaving the file unchanged', () => {
    const file = ledgerFile();
    reserve(file, 'a1', 0.4, { cap: 1 });
    reserve(file, 'a2', 0.5, { cap: 1 });
    expect(() => reserve(file, 'a3', 0.2)).toThrow(SpendCapExceeded);
    const ledger = readLedger(file);
    expect(ledger.reserved.map(r => r.attempt)).toEqual(['a1', 'a2']);
    expect(summarize(ledger)).toMatchObject({ cap_usd: 1, spent_usd: 0, reserved_usd: 0.9, worst_case_usd: 0.9, headroom_usd: 0.1 });
    try { reserve(file, 'a3', 0.2); } catch (e: any) { expect(e.code).toBe('SPEND_CAP_EXCEEDED'); expect(e.detail).toEqual({ cap_usd: 1, spent_usd: 0, reserved_usd: 0.9, estimate_usd: 0.2 }); }
  });

  test('settle moves a reservation to spent; an unknown settlement keeps its reservation in worst_case, never zero', () => {
    const file = ledgerFile();
    reserve(file, 'native-1', 0.3, { cap: 2 });
    reserve(file, 'outside-1', 0.5);
    settle(file, 'outside-1', 0.42);
    settle(file, 'native-1', 'unknown');
    const s = summarize(readLedger(file));
    expect(s).toMatchObject({ spent_usd: 0.42, reserved_usd: 0, unknown_usd: 0.3, unknown_count: 1, worst_case_usd: 0.72, open_attempts: [] });
    expect(renderSpend(s)).toBe('SPEND: spent=0.42 reserved=0.00 unknown=1(0.30) worst_case=0.72 cap=2.00');
    // a later reservation is admitted against worst_case, so the unknown charge still counts
    expect(() => reserve(file, 'outside-2', 1.3)).toThrow(SpendCapExceeded);
    reserve(file, 'outside-2', 1.28);
  });

  test('reserve, settle and release are idempotent per attempt', () => {
    const file = ledgerFile();
    reserve(file, 'x', 0.1, { cap: 1 });
    reserve(file, 'x', 0.9);
    expect(readLedger(file).reserved).toHaveLength(1);
    settle(file, 'x', 0.05);
    settle(file, 'x', 0.05);
    expect(readLedger(file).spent_usd).toBe(0.05);
    expect(() => reserve(file, 'x', 0.1)).toThrow(/already settled/);
    reserve(file, 'y', 0.2);
    release(file, 'y');
    release(file, 'y');
    const ledger = readLedger(file);
    expect(ledger.reserved).toEqual([]);
    expect(ledger.released).toHaveLength(1);
  });

  test('a reservation written before a crash is still held by the next process', () => {
    const file = ledgerFile();
    const crash = spawnSync('bun', ['-e', `
      const { reserve } = await import(${JSON.stringify(path.join(ROOT, 'lib/spend-ledger.ts'))});
      reserve(process.argv[1], 'crashed', 0.6, { cap: 1 });
      process.kill(process.pid, 'SIGKILL');
    `, file], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    // POSIX reports the signal; Windows reports a non-zero status for a killed process.
    expect(crash.signal === 'SIGKILL' || (crash.signal === null && crash.status !== 0), JSON.stringify({ signal: crash.signal, status: crash.status })).toBe(true);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    const ledger = readLedger(file);
    expect(ledger.reserved.map(r => r.attempt)).toEqual(['crashed']);
    expect(() => reserve(file, 'next', 0.5)).toThrow(SpendCapExceeded);
    reserve(file, 'next', 0.4);
  });

  test('a stale lock left by a dead pid is reclaimed', () => {
    const file = ledgerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, host: os.hostname(), at: new Date().toISOString() }));
    reserve(file, 'after-stale', 0.1, { cap: 1 });
    expect(readLedger(file).reserved).toHaveLength(1);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  test('eight concurrent writers never admit past the cap', () => {
    const file = ledgerFile();
    const script = `
      const { reserve } = await import(${JSON.stringify(path.join(ROOT, 'lib/spend-ledger.ts'))});
      let ok = 0;
      for (let i = 0; i < 5; i++) {
        try { reserve(process.argv[1], process.argv[2] + '-' + i, 0.25, { cap: 2 }); ok++; } catch (e) { if (e.code !== 'SPEND_CAP_EXCEEDED') throw e; }
      }
      console.log(ok);
    `;
    const procs = Array.from({ length: 8 }, (_, i) => Bun.spawn(['bun', '-e', script, file, `w${i}`], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }));
    const results = procs.map(p => ({ code: p.exited, out: new Response(p.stdout).text(), err: new Response(p.stderr).text() }));
    return Promise.all(results.map(async r => ({ code: await r.code, out: await r.out, err: await r.err }))).then(all => {
      for (const r of all) expect(r.code, r.err).toBe(0);
      const admitted = all.reduce((s, r) => s + Number(r.out.trim()), 0);
      expect(admitted).toBe(8);
      const ledger = readLedger(file);
      expect(ledger.reserved).toHaveLength(8);
      expect(summarize(ledger).worst_case_usd).toBe(2);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });
  });
});

/**
 * Egress receipts — chain, fail-closed, verify, shell bridge. Free tier, no network.
 *
 * THREAT MODEL: the egress ledger is forensic observability — it records
 * ATTEMPTED egress so accidents are auditable; it is not an exfiltration
 * control.
 *
 * Pins the auditor contract:
 *   - receipt-before-send fail-closed (EGRESS_RECEIPT_FAILED, no ledger = no send)
 *   - content-free lines chained by prev = sha256(previous raw line)
 *   - tail-read correctness (last line found without loading the whole file)
 *   - abandoned-lock reclaim (stale lock dir >10s old is removed, not fatal)
 *   - WARN-at-size (one self-explanatory stderr warning per process >25MB)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { canRevokeWrites } from './helpers/fs-caps';
import {
  EGRESS_RECEIPT_FAILED,
  LEDGER_WARN_BYTES,
  egressLedgerPath,
  ledgerSizeWarning,
  listReceipts,
  resetLedgerSizeWarningForTests,
  sha256Hex,
  verifyLedger,
  writeOutcome,
  writeReceipt,
} from '../lib/egress-receipt';

const ROOT = path.resolve(import.meta.path, '..', '..');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-egress-'));
});

afterEach(() => {
  try { fs.chmodSync(path.join(home, 'security'), 0o700); } catch {} // undo fail-closed fixtures
  fs.rmSync(home, { recursive: true, force: true });
});

describe('egress receipt library', () => {
  test('receipts chain: prev = sha256 of the previous raw line, "" for line 1', () => {
    writeReceipt({ home, sink: 'a', host: 'h1', payloadClass: 'c', bytes: 3, sha256: sha256Hex('abc'), consent: 'k=v' });
    writeReceipt({ home, sink: 'b', host: 'h2', payloadClass: 'c', bytes: 0, sha256: null, consent: 'k=v' });
    const lines = fs.readFileSync(egressLedgerPath(home), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.prev).toBe('');
    expect(second.prev).toBe(sha256Hex(lines[0]));
    expect(first.sha256).toBe(sha256Hex('abc'));
    expect(second.sha256).toBeNull();
    expect(verifyLedger(home)).toMatchObject({ ok: true, count: 2 });
  });

  test('ledger is 0600 and the security dir 0700', () => {
    writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' });
    const ledger = egressLedgerPath(home);
    expect(fs.statSync(ledger).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(ledger)).mode & 0o777).toBe(0o700);
  });

  test('fail-closed: unwritable security dir throws typed EGRESS_RECEIPT_FAILED', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' });
    fs.chmodSync(path.join(home, 'security'), 0o500);
    try {
      expect(() =>
        writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' }),
      ).toThrow();
      try {
        writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' });
      } catch (err: any) {
        expect(err.code).toBe(EGRESS_RECEIPT_FAILED);
      }
    } finally {
      fs.chmodSync(path.join(home, 'security'), 0o700);
    }
  });

  test('outcome records join back onto their receipt in listReceipts', () => {
    const { id } = writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' });
    writeOutcome({ home, receipt: id, status: 204 });
    const receipts = listReceipts(home);
    expect(receipts.length).toBe(1);
    expect(receipts[0].status).toBe('204');
    expect(verifyLedger(home)).toMatchObject({ ok: true, count: 2 });
  });

  test('tampering with a middle line breaks verification at that line', () => {
    for (let i = 0; i < 3; i += 1) {
      writeReceipt({ home, sink: `s${i}`, host: 'h', payloadClass: 'c', consent: 'telemetry=community' });
    }
    const ledger = egressLedgerPath(home);
    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n');
    lines[1] = lines[1].replace('community', 'communitX');
    fs.writeFileSync(ledger, `${lines.join('\n')}\n`);
    // Line 2's edited bytes no longer hash to line 3's recorded prev.
    expect(verifyLedger(home)).toMatchObject({ ok: false, brokenLine: 3 });
  });

  test('validation rejects garbage before touching the ledger', () => {
    expect(() => writeReceipt({ home, sink: '', host: 'h', payloadClass: 'c', consent: 'k' } as any)).toThrow();
    expect(() => writeReceipt({ home, sink: 's', host: 'h', payloadClass: 'c', consent: 'k', bytes: -1 })).toThrow();
    expect(() => writeReceipt({ home, sink: 's', host: 'h', payloadClass: 'c', consent: 'k', sha256: 'nothex' })).toThrow();
    expect(fs.existsSync(egressLedgerPath(home))).toBe(false);
  });

  test('abandoned lock: a stale lock dir (>10s-old mtime) is reclaimed by the next writer', () => {
    // First write creates the security dir so the lock path's parent exists.
    writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' });
    const lock = `${egressLedgerPath(home)}.lock`;
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const started = Date.now();
    const { id } = writeReceipt({ home, sink: 'b', host: 'h', payloadClass: 'c', consent: 'k=v' });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    // Spin budget is 2.5s; reclaim happens right after budget exhaustion.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fs.existsSync(lock)).toBe(false);
    expect(verifyLedger(home)).toMatchObject({ ok: true, count: 2 });
  });

  test('a fresh (recent-mtime) lock held past the budget fails closed instead of being stolen', () => {
    writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' });
    const lock = `${egressLedgerPath(home)}.lock`;
    fs.mkdirSync(lock);
    // Keep the mtime fresh so the reclaim path never fires: refresh it in the
    // background while the writer spins out its 2.5s budget.
    const refresher = setInterval(() => {
      const now = new Date();
      try { fs.utimesSync(lock, now, now); } catch { /* test teardown race */ }
    }, 1000);
    try {
      expect(() =>
        writeReceipt({ home, sink: 'b', host: 'h', payloadClass: 'c', consent: 'k=v' }),
      ).toThrow(/locked/);
    } finally {
      clearInterval(refresher);
      fs.rmdirSync(lock);
    }
  }, 15_000);

  test('tail-read: last line is found correctly on a multi-record ledger larger than the tail window', () => {
    // 30 records ≈ 9KB > the 4KB tail window, so the append path must find
    // the true last line from a partial read.
    for (let i = 0; i < 30; i += 1) {
      writeReceipt({
        home,
        sink: `sink-${i}`,
        host: 'h',
        payloadClass: `class-${'x'.repeat(200)}-${i}`,
        consent: 'k=v',
      });
    }
    const ledger = egressLedgerPath(home);
    expect(fs.statSync(ledger).size).toBeGreaterThan(4096);
    const result = verifyLedger(home);
    expect(result).toMatchObject({ ok: true, count: 30 });
  });

  test('chain verify stays intact across 100+ records', () => {
    for (let i = 0; i < 120; i += 1) {
      writeReceipt({ home, sink: `s${i}`, host: 'h', payloadClass: 'c', consent: 'k=v' });
      if (i % 10 === 0) writeOutcome({ home, receipt: 'f'.repeat(64), status: 200 });
    }
    const result = verifyLedger(home);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(132);
    expect(listReceipts(home).length).toBe(120);
  });

  test('WARN-at-size: >25MB ledger emits one self-explanatory stderr warning per process', () => {
    const ledger = egressLedgerPath(home);
    fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
    // Grow the file past the threshold with valid-looking filler; the warning
    // keys off file size only.
    const filler = `${JSON.stringify({ type: 'egress', pad: 'x'.repeat(1024) })}\n`;
    const chunk = filler.repeat(1024); // ~1MB
    const writes = Math.ceil(LEDGER_WARN_BYTES / chunk.length) + 1;
    for (let i = 0; i < writes; i += 1) fs.appendFileSync(ledger, chunk);
    expect(fs.statSync(ledger).size).toBeGreaterThan(LEDGER_WARN_BYTES);

    resetLedgerSizeWarningForTests();
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string) => { captured.push(String(chunk)); return true; };
    try {
      writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' });
      writeReceipt({ home, sink: 'b', host: 'h', payloadClass: 'c', consent: 'k=v' });
    } finally {
      (process.stderr as any).write = originalWrite;
    }
    const warnings = captured.filter((c) => c.includes('egress ledger is large'));
    expect(warnings.length).toBe(1); // once per process, not per write
    // Self-explanatory shape: what the ledger is, how to inspect, what's coming.
    expect(warnings[0]).toContain('ATTEMPTS to send off-machine');
    expect(warnings[0]).toContain('gstack-egress list');
    expect(warnings[0]).toContain('rotation');
    expect(warnings[0]).toContain(ledger);

    // verifyLedger surfaces the same warning as data.
    const message = ledgerSizeWarning(ledger, fs.statSync(ledger).size);
    expect(message).toContain('MB');
    expect(verifyLedger(home).sizeWarning).toBe(message);
  });
});

describe('gstack-egress-receipt shell bridge', () => {
  const bin = path.join(ROOT, 'bin', 'gstack-egress-receipt');

  test('write hashes the exact payload file, prints the receipt id; outcome joins', () => {
    const payload = path.join(home, 'payload.json');
    fs.writeFileSync(payload, '[{"v":1}]');
    const write = spawnSync(bin, ['write', '--sink', 'telemetry-sync', '--host', '127.0.0.1:8399',
      '--class', 'telemetry-events', '--payload-file', payload, '--consent', 'telemetry=community'],
      { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_HOME: home } });
    expect(write.status).toBe(0);
    const id = write.stdout.trim();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const outcome = spawnSync(bin, ['outcome', id, '204'],
      { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_HOME: home } });
    expect(outcome.status).toBe(0);
    const receipts = listReceipts(home);
    expect(receipts.length).toBe(1);
    expect(receipts[0].bytes).toBe(9);
    expect(receipts[0].sha256).toBe(sha256Hex('[{"v":1}]'));
    expect(receipts[0].status).toBe('204');
  });

  test('--no-payload records sha256:null (git-class: a subprocess owns the bytes)', () => {
    const write = spawnSync(bin, ['write', '--sink', 'brain-sync', '--host', 'github.com',
      '--class', 'git-push', '--no-payload', '--consent', 'artifacts_sync_mode=auto'],
      { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_HOME: home } });
    expect(write.status).toBe(0);
    const receipts = listReceipts(home);
    expect(receipts.length).toBe(1);
    expect(receipts[0].sha256).toBeNull();
    expect(receipts[0].bytes).toBe(0);
  });

  test('write exits 3 with EGRESS_RECEIPT_FAILED when the ledger is unwritable', () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    fs.mkdirSync(path.join(home, 'security'), { recursive: true, mode: 0o500 });
    const write = spawnSync(bin, ['write', '--sink', 's', '--host', 'h', '--class', 'c', '--no-payload'],
      { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GSTACK_HOME: home } });
    expect(write.status).toBe(3);
    expect(write.stderr).toContain('EGRESS_RECEIPT_FAILED');
    fs.chmodSync(path.join(home, 'security'), 0o700);
  });
});

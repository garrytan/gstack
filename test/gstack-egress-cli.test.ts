/**
 * gstack-egress CLI — list | verify | grants smoke tests. Free tier.
 *
 * Spawns the real bin against a temp GSTACK_HOME: list filters, verify
 * exit-3-on-tamper (naming the first broken line), sizeWarning surfacing,
 * and grants against the upstream config keys (telemetry,
 * artifacts_sync_mode, redact_repo_visibility, redact_prepush_hook).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  LEDGER_WARN_BYTES,
  egressLedgerPath,
  sha256Hex,
  writeReceipt,
} from '../lib/egress-receipt';

const ROOT = path.resolve(import.meta.path, '..', '..');
const BIN = path.join(ROOT, 'bin', 'gstack-egress');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-egress-cli-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(args: string[]) {
  const result = spawnSync(BIN, args, {
    encoding: 'utf-8',
    env: { ...process.env, GSTACK_HOME: home },
  });
  return { code: result.status ?? -1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('gstack-egress list', () => {
  test('fresh home prints "no receipts" and the ledger path, exit 0', () => {
    const r = run(['list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no receipts');
    expect(r.stdout).toContain(egressLedgerPath(home));
  });

  test('--json returns receipts and honors --sink/--host/--since filters', () => {
    writeReceipt({ home, sink: 'telemetry-sync', host: '10.0.0.1:8399', payloadClass: 'telemetry-events', bytes: 2, sha256: sha256Hex('[]'), consent: 'telemetry=community' });
    writeReceipt({ home, sink: 'design-openai', host: 'api.openai.com', payloadClass: 'generate-image-request', consent: 'user ran design command' });
    const all = run(['list', '--json']);
    expect(all.code).toBe(0);
    expect(JSON.parse(all.stdout).length).toBe(2);
    const filtered = run(['list', '--json', '--sink', 'telemetry-sync']);
    const rows = JSON.parse(filtered.stdout);
    expect(rows.length).toBe(1);
    expect(rows[0].host).toBe('10.0.0.1:8399');
    expect(rows[0].sha256).toBe(sha256Hex('[]'));
    const none = run(['list', '--json', '--since', '2999-01-01T00:00:00Z']);
    expect(JSON.parse(none.stdout).length).toBe(0);
  });

  test('unknown option exits 2 with usage', () => {
    const r = run(['list', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage');
  });
});

describe('gstack-egress verify', () => {
  test('exits 0 on an intact chain and 3 naming the first broken line on tamper', () => {
    writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'telemetry=community' });
    writeReceipt({ home, sink: 'b', host: 'h', payloadClass: 'c', consent: 'telemetry=community' });
    const ok = run(['verify']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('chain intact: 2');

    const ledger = egressLedgerPath(home);
    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n');
    lines[0] = lines[0].replace('community', 'communitX');
    fs.writeFileSync(ledger, `${lines.join('\n')}\n`);
    const tampered = run(['verify']);
    expect(tampered.code).toBe(3);
    expect(tampered.stdout).toContain('line 2');
  });

  test('prints the sizeWarning when the ledger exceeds the threshold', () => {
    writeReceipt({ home, sink: 'a', host: 'h', payloadClass: 'c', consent: 'k=v' });
    const ledger = egressLedgerPath(home);
    // verify keys the warning off file size only — pad with a trailing
    // comment-free blank region by appending to a side channel is not
    // possible in JSONL, so grow via many valid-shaped junk lines and
    // assert on sizeWarning presence (chain will break; both surface).
    const filler = `${JSON.stringify({ type: 'junk', pad: 'x'.repeat(1024) })}\n`.repeat(1024);
    while (fs.statSync(ledger).size <= LEDGER_WARN_BYTES) fs.appendFileSync(ledger, filler);
    const r = run(['verify', '--json']);
    expect(r.code).toBe(3); // filler breaks the chain — expected
    const parsed = JSON.parse(r.stdout);
    expect(parsed.sizeWarning).toContain('egress ledger is large');
    expect(parsed.sizeWarning).toContain('gstack-egress list');
    const human = run(['verify']);
    expect(human.stdout).toContain('egress ledger is large');
  });
});

describe('gstack-egress grants', () => {
  test('fresh home shows the four upstream grants off, each naming file and revoke command', () => {
    const r = run(['grants']);
    expect(r.code).toBe(0);
    for (const grant of ['telemetry', 'brain-sync', 'redact_repo_visibility', 'redact_prepush_hook']) {
      expect(r.stdout).toContain(grant);
    }
    expect(r.stdout).not.toContain('[GRANTED]');
    expect(r.stdout).toContain(path.join(home, 'config.yaml'));
    expect(r.stdout).toContain('revoke:');
  });

  test('--json flips granted=true when telemetry and sync mode are enabled', () => {
    const config = spawnSync(path.join(ROOT, 'bin', 'gstack-config'), ['set', 'telemetry', 'community'], {
      encoding: 'utf-8',
      env: { ...process.env, GSTACK_HOME: home },
    });
    expect(config.status).toBe(0);
    spawnSync(path.join(ROOT, 'bin', 'gstack-config'), ['set', 'artifacts_sync_mode', 'full'], {
      encoding: 'utf-8',
      env: { ...process.env, GSTACK_HOME: home },
    });
    const r = run(['grants', '--json']);
    expect(r.code).toBe(0);
    const grants = JSON.parse(r.stdout);
    const telemetry = grants.find((g: any) => g.grant === 'telemetry');
    expect(telemetry.granted).toBe(true);
    expect(telemetry.revoke).toContain('telemetry off');
    const sync = grants.find((g: any) => g.grant === 'brain-sync');
    expect(sync.granted).toBe(true);
    expect(sync.value).toBe('full');
    const hook = grants.find((g: any) => g.grant === 'redact_prepush_hook');
    expect(hook.granted).toBe(false);
  });
});

describe('gstack-egress usage', () => {
  test('no subcommand exits 2 with usage', () => {
    const r = run([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage');
  });
});

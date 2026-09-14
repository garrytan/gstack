/**
 * gstack-egress-lib.sh — shared shell receipt helpers, tested end-to-end
 * against a local listener. Free tier, loopback only.
 *
 * Pins the shell-sink contract:
 *   - receipt sha256 == sha256 of the exact bytes the listener received
 *     (same file is hashed and handed to curl via --data-binary @file)
 *   - fail-closed refusal never touches the network and its stderr carries
 *     problem + cause + fix in plain language
 *   - fail-open warns on stderr and proceeds unrecorded
 *   - payload temp files are consumed immediately (no EXIT traps)
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { canRevokeWrites } from './helpers/fs-caps';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listReceipts, sha256Hex } from '../lib/egress-receipt';

const ROOT = path.resolve(import.meta.path, '..', '..');
const LIB = path.join(ROOT, 'bin', 'gstack-egress-lib.sh');

const received: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    received.push(await req.text());
    return new Response('ok');
  },
});
const URL_BASE = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-egress-lib-'));
  received.length = 0;
});

afterEach(() => {
  try { fs.chmodSync(path.join(home, 'security'), 0o700); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
});

// Async spawn: spawnSync would block Bun's event loop, deadlocking the
// in-process listener the script curls against.
async function runBash(script: string) {
  const proc = Bun.spawn(['bash', '-c', script], {
    env: { ...process.env, GSTACK_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

describe('_receipted_curl', () => {
  test('receipt sha256 equals sha256 of the body the listener received; payload file consumed', async () => {
    const body = '[{"event":"lib-test","v":1}]';
    const result = await runBash(`
      set -uo pipefail
      . "${LIB}"
      payload="$(mktemp)"
      printf '%s' '${body}' > "$payload"
      echo "PAYLOAD_PATH=$payload"
      _receipted_curl closed lib-test 127.0.0.1:${server.port} test-events "telemetry=community" "$payload" \\
        curl -s --max-time 5 -X POST "${URL_BASE}/ingest"
      echo "CURL_EXIT=$?"
      [ -e "$payload" ] && echo "PAYLOAD_STILL_EXISTS" || echo "PAYLOAD_GONE"
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CURL_EXIT=0');
    expect(result.stdout).toContain('PAYLOAD_GONE');
    expect(received.length).toBe(1);
    expect(received[0]).toBe(body);
    const receipts = listReceipts(home);
    expect(receipts.length).toBe(1);
    expect(receipts[0].sha256).toBe(sha256Hex(received[0]));
    expect(receipts[0].bytes).toBe(Buffer.byteLength(body));
    expect(receipts[0].sink).toBe('lib-test');
    expect(receipts[0].status).toBe('exit:0'); // best-effort outcome joined
  });

  test('fail-closed refusal never hits the network; stderr is problem + cause + fix', async () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    fs.mkdirSync(path.join(home, 'security'), { recursive: true, mode: 0o500 });
    const result = await runBash(`
      set -uo pipefail
      . "${LIB}"
      payload="$(mktemp)"
      printf '%s' 'secret payload' > "$payload"
      _receipted_curl closed lib-test 127.0.0.1:${server.port} test-events "telemetry=community" "$payload" \\
        curl -s --max-time 5 -X POST "${URL_BASE}/ingest"
      status=$?
      [ -e "$payload" ] && echo "PAYLOAD_STILL_EXISTS" || echo "PAYLOAD_GONE"
      exit $status
    `);
    expect(result.status).toBe(3);
    expect(received.length).toBe(0); // the send was refused, not attempted
    expect(result.stdout).toContain('PAYLOAD_GONE'); // cleaned up on refusal too
    // Problem: what did not happen.
    expect(result.stderr).toContain('lib-test NOT sent');
    // Cause: the bridge's typed error is quoted.
    expect(result.stderr).toContain('EGRESS_RECEIPT_FAILED');
    // Fix: an actionable command.
    expect(result.stderr).toContain('Fix: chmod -R u+w');
    // What this is: the ledger explained.
    expect(result.stderr).toContain('ATTEMPTS to send off-machine');
    expect(result.stderr).toContain('gstack-egress');
  });

  test('fail-open warns and proceeds when the receipt cannot be written', async () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    fs.mkdirSync(path.join(home, 'security'), { recursive: true, mode: 0o500 });
    const result = await runBash(`
      set -uo pipefail
      . "${LIB}"
      _receipted_curl open lib-open 127.0.0.1:${server.port} version-fetch "user ran --force" --no-payload \\
        curl -s --max-time 5 "${URL_BASE}/VERSION"
    `);
    expect(result.status).toBe(0);
    expect(received.length).toBe(1); // the send proceeded unrecorded
    expect(result.stderr).toContain('sending anyway');
    expect(result.stderr).toContain('lib-open');
  });

  test('--no-payload records sha256:null and does not append --data-binary', async () => {
    const result = await runBash(`
      set -uo pipefail
      . "${LIB}"
      _receipted_curl closed lib-get 127.0.0.1:${server.port} version-fetch "user ran --force" --no-payload \\
        curl -s --max-time 5 "${URL_BASE}/VERSION"
    `);
    expect(result.status).toBe(0);
    expect(received.length).toBe(1);
    expect(received[0]).toBe(''); // GET, no body
    const receipts = listReceipts(home);
    expect(receipts.length).toBe(1);
    expect(receipts[0].sha256).toBeNull();
    expect(receipts[0].bytes).toBe(0);
  });
});

describe('_receipted_git', () => {
  test('writes a git-class sha256:null receipt then runs the command unmodified', async () => {
    const result = await runBash(`
      set -uo pipefail
      . "${LIB}"
      _receipted_git closed brain-sync github.com curated-memory-git-push "artifacts_sync_mode!=off" \\
        bash -c 'echo GIT_RAN "$@"' _
    `);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GIT_RAN');
    expect(result.stdout).not.toContain('--data-binary');
    const receipts = listReceipts(home);
    expect(receipts.length).toBe(1);
    expect(receipts[0].sha256).toBeNull();
    expect(receipts[0].payload_class).toBe('curated-memory-git-push');
    expect(receipts[0].status).toBe('exit:0');
  });

  test('fail-closed git refusal returns 3 without running the command', async () => {
    if (!canRevokeWrites()) return; // chmod is advisory here (win32, root, DAC-override containers)
    fs.mkdirSync(path.join(home, 'security'), { recursive: true, mode: 0o500 });
    const marker = path.join(os.tmpdir(), `gstack-egress-git-${process.pid}`);
    fs.rmSync(marker, { force: true });
    const result = await runBash(`
      set -uo pipefail
      . "${LIB}"
      _receipted_git closed brain-sync github.com curated-memory-git-push "artifacts_sync_mode!=off" \\
        touch "${marker}"
    `);
    expect(result.status).toBe(3);
    expect(fs.existsSync(marker)).toBe(false); // command never ran
    expect(result.stderr).toContain('brain-sync NOT sent');
  });
});

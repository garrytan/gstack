/**
 * Tests for the secret-sink test harness (D21 #5).
 *
 * Positive controls: deliberately leak a seed in every covered channel and
 * assert the harness catches it. A harness that silently under-reports is
 * worse than no harness — these tests are the quality gate.
 *
 * Negative controls: run real setup-gbrain bins with known secrets; no
 * leaks should appear.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWithSecretSink } from './helpers/secret-sink-harness';

const ROOT = path.resolve(import.meta.dir, '..');
const LEAK_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-bins-'));

// Build a disposable bash script that leaks in a specific way. Returns
// path to the executable. We don't bother cleaning these up per-test —
// they live under a tmpdir that's fine to linger between tests.
function makeLeakyBin(name: string, body: string): string {
  const p = path.join(LEAK_BIN_DIR, name);
  fs.writeFileSync(p, `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  return p;
}

describe('secret-sink-harness — positive controls', () => {
  test('catches a seed echoed to stdout', async () => {
    const bin = makeLeakyBin(
      'leak-stdout',
      'echo "config contains: $LEAK_SEED"'
    );
    const seed = 'my-secret-password-12345';
    const r = await runWithSecretSink({
      bin,
      args: [],
      seeds: [seed],
      env: { LEAK_SEED: seed },
    });
    expect(r.leaks.length).toBeGreaterThan(0);
    const stdoutLeaks = r.leaks.filter((l) => l.channel === 'stdout');
    expect(stdoutLeaks.length).toBeGreaterThan(0);
    expect(stdoutLeaks.some((l) => l.matchType === 'exact')).toBe(true);
  });

  test('catches a seed echoed to stderr', async () => {
    const bin = makeLeakyBin(
      'leak-stderr',
      'echo "leaked: $LEAK_SEED" >&2'
    );
    const seed = 'another-secret-value-67890';
    const r = await runWithSecretSink({
      bin,
      args: [],
      seeds: [seed],
      env: { LEAK_SEED: seed },
    });
    expect(r.leaks.some((l) => l.channel === 'stderr')).toBe(true);
  });

  test('catches a seed written to a file under $HOME', async () => {
    const bin = makeLeakyBin(
      'leak-file',
      'mkdir -p "$HOME/.gstack" && echo "seed: $LEAK_SEED" > "$HOME/.gstack/debug.log"'
    );
    const seed = 'file-leaked-secret-value-xyz';
    const r = await runWithSecretSink({
      bin,
      args: [],
      seeds: [seed],
      env: { LEAK_SEED: seed },
    });
    const fileLeaks = r.leaks.filter((l) => l.channel === 'file');
    expect(fileLeaks.length).toBeGreaterThan(0);
    expect(fileLeaks[0].where).toBe('.gstack/debug.log');
  });

  test('catches a seed leaked into the telemetry channel', async () => {
    const bin = makeLeakyBin(
      'leak-telemetry',
      'mkdir -p "$HOME/.gstack/analytics" && ' +
      'echo "{\\"event\\":\\"x\\",\\"leaked_secret\\":\\"$LEAK_SEED\\"}" ' +
      '  >> "$HOME/.gstack/analytics/skill-usage.jsonl"'
    );
    const seed = 'telemetry-leaked-abc123xyz';
    const r = await runWithSecretSink({
      bin,
      args: [],
      seeds: [seed],
      env: { LEAK_SEED: seed },
    });
    const telemetryLeaks = r.leaks.filter((l) => l.channel === 'telemetry');
    expect(telemetryLeaks.length).toBeGreaterThan(0);
    expect(telemetryLeaks[0].where).toContain('analytics/');
  });

  test('catches a seed leaked in base64-encoded form (auth header pattern)', async () => {
    // printf (not echo) so no trailing newline — matches how real auth
    // headers encode: base64(seed) exactly, not base64(seed + "\n").
    const bin = makeLeakyBin(
      'leak-base64',
      'printf "%s" "$LEAK_SEED" | base64'
    );
    const seed = 'base64-leaked-long-enough-secret';
    const r = await runWithSecretSink({
      bin,
      args: [],
      seeds: [seed],
      env: { LEAK_SEED: seed },
    });
    expect(r.leaks.some((l) => l.matchType === 'base64')).toBe(true);
  });

  test('catches a first-12-char prefix leak (the "I only logged a portion" pattern)', async () => {
    const bin = makeLeakyBin(
      'leak-prefix',
      'prefix="${LEAK_SEED:0:12}"; echo "debug prefix: $prefix"'
    );
    const seed = 'prefix-leaked-0123456789abcdef';
    const r = await runWithSecretSink({
      bin,
      args: [],
      seeds: [seed],
      env: { LEAK_SEED: seed },
    });
    expect(r.leaks.some((l) => l.matchType === 'prefix-12')).toBe(true);
  });

  test('clean run with no leak returns an empty leaks array', async () => {
    const bin = makeLeakyBin('clean', 'echo "no secret here"');
    const r = await runWithSecretSink({
      bin,
      args: [],
      seeds: ['never-emitted-seed-xyz-987'],
    });
    expect(r.leaks).toEqual([]);
  });
});

describe('secret-sink-harness — real bins (negative controls)', () => {
  test('supabase-verify does not leak a URL password on reject', async () => {
    const bin = path.join(ROOT, 'bin', 'gstack-gbrain-supabase-verify');
    const seedPassword = 'extremely-distinctive-password-abc-xyz-987';
    // Use a URL that will be REJECTED (wrong scheme) so all error paths run
    const leakyUrl = `mysql://user:${seedPassword}@host:6543/db`;
    const r = await runWithSecretSink({
      bin,
      args: [leakyUrl],
      seeds: [seedPassword],
    });
    // Status 2 — rejected as expected
    expect(r.status).toBe(2);
    // No leaks in any channel
    expect(r.leaks).toEqual([]);
  });

  test('supabase-verify does not leak on direct-connection rejection path', async () => {
    const bin = path.join(ROOT, 'bin', 'gstack-gbrain-supabase-verify');
    const seedPassword = 'another-distinctive-secret-for-direct-conn';
    const leakyUrl = `postgresql://postgres:${seedPassword}@db.abcdef.supabase.co:5432/postgres`;
    const r = await runWithSecretSink({
      bin,
      args: [leakyUrl],
      seeds: [seedPassword],
    });
    expect(r.status).toBe(3);
    expect(r.leaks).toEqual([]);
  });

  test('lib.sh read_secret_to_env does not leak stdin via captured channels', async () => {
    const seed = 'piped-secret-that-should-stay-invisible-zzz';
    // Wrapper script: source lib.sh, read secret, echo only its length.
    const lib = path.join(ROOT, 'bin', 'gstack-gbrain-lib.sh');
    const bin = makeLeakyBin(
      'read-secret-wrapper',
      `. "${lib}"\nread_secret_to_env MY_SECRET "Prompt: "\necho "len=\${#MY_SECRET}"`
    );
    const r = await runWithSecretSink({
      bin,
      args: [],
      seeds: [seed],
      stdin: seed,
    });
    expect(r.status).toBe(0);
    // The length is visible (43) but the value is not
    expect(r.stdout).toContain(`len=${seed.length}`);
    expect(r.leaks).toEqual([]);
  });

  test('supabase-provision does not leak a PAT on auth-failure path', async () => {
    const bin = path.join(ROOT, 'bin', 'gstack-gbrain-supabase-provision');
    const seedPat = 'sbp_very_distinctive_pat_seed_abc_xyz_1234567890';
    // With no SUPABASE_API_BASE override, the bin tries the real API URL.
    // We want to avoid real network calls — point at a bogus URL that
    // immediately fails with curl. The bin should exit with an error
    // WITHOUT leaking the PAT to any channel.
    const r = await runWithSecretSink({
      bin,
      args: ['list-orgs'],
      seeds: [seedPat],
      env: {
        SUPABASE_ACCESS_TOKEN: seedPat,
        // Nonexistent port — curl fails fast.
        SUPABASE_API_BASE: 'http://127.0.0.1:1',
      },
      timeoutMs: 30_000, // curl retries with backoff — give it room to exit
    });
    // Expect a non-zero exit (network failure, exit 8 per the bin's
    // retry-exhausted path)
    expect(r.status).not.toBe(0);
    expect(r.leaks).toEqual([]);
  }, 60_000);
});

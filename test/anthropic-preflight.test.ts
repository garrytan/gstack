/**
 * Regression pins for the preflight-dedup seam (test/helpers/anthropic-preflight.ts).
 *
 * The preflight runs at MODULE LOAD in every paid test file that imports
 * e2e-helpers, so a broken skip-check either brings back ~30 paid pings per
 * sharded run or — worse — skips the fail-fast everywhere. Both directions
 * are pinned here with an injected spawn; no real claude call is made.
 */

import { describe, test, expect } from 'bun:test';
import { preflightAnthropicApi } from './helpers/anthropic-preflight';

type SpawnCall = { command: string; args: string[] };

function fakeSpawn(stdout: string, calls: SpawnCall[]) {
  return ((command: string, args: string[]) => {
    calls.push({ command, args });
    return { stdout: Buffer.from(stdout), stderr: Buffer.from(''), status: 0 } as ReturnType<
      typeof import('child_process').spawnSync
    >;
  }) as typeof import('child_process').spawnSync;
}

describe('preflightAnthropicApi', () => {
  test('EVALS_PREFLIGHT_OK=1 skips the ping entirely (sharded-child path)', () => {
    const calls: SpawnCall[] = [];
    const result = preflightAnthropicApi({ EVALS_PREFLIGHT_OK: '1' }, fakeSpawn('never read', calls));
    expect(result).toBe('skipped');
    expect(calls.length).toBe(0);
  });

  test('without the flag, pings exactly once and passes on healthy output', () => {
    const calls: SpawnCall[] = [];
    const result = preflightAnthropicApi({}, fakeSpawn('{"type":"result"}', calls));
    expect(result).toBe('ok');
    expect(calls.length).toBe(1);
    expect(calls[0].args.join(' ')).toContain('claude -p');
  });

  test('unreachable API throws (fail-fast before any shard spawns)', () => {
    const calls: SpawnCall[] = [];
    expect(() =>
      preflightAnthropicApi({}, fakeSpawn('error: ConnectionRefused connecting to api', calls)),
    ).toThrow(/Anthropic API unreachable/);
  });

  test('a truthy-but-not-"1" flag still pings (no accidental widening)', () => {
    const calls: SpawnCall[] = [];
    const result = preflightAnthropicApi({ EVALS_PREFLIGHT_OK: 'true' }, fakeSpawn('ok', calls));
    expect(result).toBe('ok');
    expect(calls.length).toBe(1);
  });

  // Failure modes that guarantee every shard fails too must fail the
  // preflight — previously a missing binary, a timeout kill, and exit 127
  // all returned 'ok' and the fleet burned its own discovery of the outage.
  const shapedSpawn = (shape: Partial<ReturnType<typeof import('child_process').spawnSync>>) =>
    ((() => ({ stdout: Buffer.from(''), stderr: Buffer.from(''), status: 0, ...shape })) as unknown as
      typeof import('child_process').spawnSync);

  test('spawn error (unlaunchable shell/binary) throws', () => {
    expect(() =>
      preflightAnthropicApi({}, shapedSpawn({ error: new Error('spawn sh ENOENT') })),
    ).toThrow(/could not run/);
  });

  test('timeout kill (signal set) throws', () => {
    expect(() =>
      preflightAnthropicApi({}, shapedSpawn({ signal: 'SIGTERM' })),
    ).toThrow(/timed out/);
  });

  test('exit 127 (claude not found) throws', () => {
    expect(() =>
      preflightAnthropicApi({}, shapedSpawn({ status: 127 })),
    ).toThrow(/not found on PATH/);
  });

  test('other non-zero exits stay fail-open (a flaky preflight must not block a runnable suite)', () => {
    expect(preflightAnthropicApi({}, shapedSpawn({ status: 1, stdout: Buffer.from('transient') }))).toBe('ok');
  });
});

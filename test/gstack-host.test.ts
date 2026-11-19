/**
 * gstack-host — names the harness actually running this session, for the
 * review-log host field and the skill-start banner. A row records the
 * executing harness, never the installed docs' host label (the install
 * target).
 *
 * These permutations are the contract the detection order depends on. Run
 * with a SCRUBBED env (the test process itself runs inside a harness, so
 * its CLAUDECODE, CODEX_*, and GSTACK_ACTIVE_HOST markers would leak in
 * and contaminate the classification).
 *
 * Free, deterministic, gate-tier.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-host');

/** Run the helper with ONLY the supplied env (plus PATH so bash resolves). */
function host(env: Record<string, string>): string {
  return execFileSync(BIN, [], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

describe('gstack-host', () => {
  test('GSTACK_ACTIVE_HOST always outranks ambient markers (explicit registration)', () => {
    expect(host({ GSTACK_ACTIVE_HOST: 'codex' })).toBe('codex');
    expect(host({ GSTACK_ACTIVE_HOST: 'kiro', CLAUDECODE: '1', CODEX_THREAD_ID: 't1' })).toBe('kiro');
    expect(host({ GSTACK_ACTIVE_HOST: 'claude', CLAUDECODE: '1' })).toBe('claude');
  });

  test('claude branch (unchanged): CLAUDECODE with no conflicting explicit host', () => {
    expect(host({ CLAUDECODE: '1' })).toBe('claude');
    expect(host({ CLAUDECODE: '1', GSTACK_ACTIVE_HOST: 'claude' })).toBe('claude');
    // an explicit codex registration outranks the claude marker
    expect(host({ CLAUDECODE: '1', GSTACK_ACTIVE_HOST: 'codex' })).toBe('codex');
  });

  test('codex branch (unchanged): Codex markers without a claude marker', () => {
    expect(host({ CODEX_THREAD_ID: 't1' })).toBe('codex');
    expect(host({ CODEX_SANDBOX: 'workspace-write' })).toBe('codex');
  });

  test('bare env → claude (the primary host; no markers, no guess)', () => {
    expect(host({})).toBe('claude');
  });
});

/**
 * sendCommand ECONNRESET short-circuit for user-initiated shutdown.
 *
 * Validates that browse stop / browse restart do NOT trigger the
 * "Server crashed twice in a row" warning when the daemon intentionally
 * closes the HTTP connection. The regression guard confirms the
 * short-circuit only applies to stop/restart — non-shutdown commands
 * still hit the existing crash-retry logic.
 *
 * We exercise the actual binary because sendCommand is an internal
 * module-level function and cannot be unit-mocked against a real
 * daemon fetch endpoint without re-architecting cli.ts. The test
 * gracefully degrades when the binary is not built
 * (describe.skipIf(!HAS_BINARY)) so CI shards without a dist/ still
 * pass.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const BROWSE_BIN = path.join(
  ROOT,
  'browse',
  'dist',
  process.platform === 'win32' ? 'browse.exe' : 'browse',
);

const HAS_BINARY = (() => {
  try {
    return fs.existsSync(BROWSE_BIN);
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_BINARY)('browse: user-initiated shutdown skips crash-retry', () => {
  test('stop command on ECONNRESET does not print crash warning', () => {
    // Ensure daemon is up; status is idempotent and will start one if needed.
    spawnSync(BROWSE_BIN, ['status'], { encoding: 'utf-8', timeout: 10000 });

    const result = spawnSync(BROWSE_BIN, ['stop'], {
      encoding: 'utf-8',
      timeout: 10000,
      cwd: ROOT,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('crashed');
    expect(result.stderr).not.toContain('aborting');
    expect(result.stderr).not.toContain('fetch failed');
  });

  test('restart command on ECONNRESET does not print crash warning', () => {
    spawnSync(BROWSE_BIN, ['status'], { encoding: 'utf-8', timeout: 10000 });

    const result = spawnSync(BROWSE_BIN, ['restart'], {
      encoding: 'utf-8',
      timeout: 15000,
      cwd: ROOT,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('crashed');
    expect(result.stderr).not.toContain('aborting');
  });
});

describe('browse: sendCommand short-circuit regression guard', () => {
  // Code-shape test: catches a refactor that accidentally widens the
  // short-circuit to all commands (which would silently skip crash-retry
  // for genuine daemon failures during goto/status/etc.).
  test('guard is scoped to stop + restart only', () => {
    const cliPath = path.join(ROOT, 'browse', 'src', 'cli.ts');
    const cliSrc = fs.readFileSync(cliPath, 'utf-8');

    // The guard must check both 'stop' AND 'restart'
    expect(cliSrc).toMatch(
      /if\s*\(\s*command\s*===\s*['"]stop['"]\s*\|\|\s*command\s*===\s*['"]restart['"]\s*\)/,
    );
    // The guard must call process.exit(0) (not throw — throw would be
    // caught by main().catch() and print "[browse] fetch failed")
    expect(cliSrc).toMatch(/process\.exit\(0\)/);
    // The guard must live inside the existing ECONNRESET handler, not
    // replace it
    expect(cliSrc).toContain('ECONNREFUSED');
    expect(cliSrc).toContain('ECONNRESET');
  });

  test('guard preserves original crash-retry path for non-shutdown commands', () => {
    const cliPath = path.join(ROOT, 'browse', 'src', 'cli.ts');
    const cliSrc = fs.readFileSync(cliPath, 'utf-8');

    // The "Server crashed twice in a row" message must still exist —
    // removing it would silently degrade the genuine-crash reporting.
    expect(cliSrc).toContain('Server crashed twice in a row');
    // And it must be reached when retries >= 1
    expect(cliSrc).toMatch(/retries\s*>=\s*1.*aborting/);
  });
});
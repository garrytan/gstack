import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'compare-pr-version.ts');

function runCompare(options: {
  prVersion: string;
  nextVersion?: string;
  baseVersion?: string;
  claimed?: Array<{ pr: number; branch: string; version: string; url?: string }>;
  forkVersionRepair?: string;
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'compare-pr-version-test-'));
  try {
    const nextJson = join(tmpDir, 'next.json');
    writeFileSync(
      nextJson,
      JSON.stringify({
        version: options.nextVersion ?? '1.26.8.0',
        base_version: options.baseVersion ?? '1.26.7.0',
        claimed: options.claimed ?? [],
      }),
    );

    const result = spawnSync('bun', ['run', SCRIPT, nextJson, '123'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PR_VERSION: options.prVersion,
        ...(options.forkVersionRepair === undefined
          ? {}
          : { FORK_VERSION_REPAIR: options.forkVersionRepair }),
      },
    });

    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('compare-pr-version fork repair handling', () => {
  test('lower-than-base fails without FORK_VERSION_REPAIR', () => {
    const result = runCompare({ prVersion: '1.26.3.0' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VERSION not bumped');
  });

  test('lower-than-base passes with FORK_VERSION_REPAIR=true', () => {
    const result = runCompare({ prVersion: '1.26.3.0', forkVersionRepair: 'true' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('fork version repair');
  });

  test('equal-to-base still fails with FORK_VERSION_REPAIR=true', () => {
    const result = runCompare({
      prVersion: '1.26.7.0',
      baseVersion: '1.26.7.0',
      forkVersionRepair: 'true',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VERSION not bumped');
  });

  test('claimed-version collision still fails with FORK_VERSION_REPAIR=true', () => {
    const result = runCompare({
      prVersion: '1.26.3.0',
      forkVersionRepair: 'true',
      claimed: [{ pr: 456, branch: 'other-repair', version: '1.26.3.0' }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VERSION collision');
  });
});

import { describe, test, expect, afterEach } from 'bun:test';
import { sandboxDisableArgs } from '../src/stealth';

// Snapshot + restore the env vars the helper reads, so tests don't leak state.
const ORIG = {
  CI: process.env.CI,
  CONTAINER: process.env.CONTAINER,
};

function clearEnv() {
  delete process.env.CI;
  delete process.env.CONTAINER;
}

afterEach(() => {
  // restore
  if (ORIG.CI === undefined) delete process.env.CI; else process.env.CI = ORIG.CI;
  if (ORIG.CONTAINER === undefined) delete process.env.CONTAINER; else process.env.CONTAINER = ORIG.CONTAINER;
});

describe('sandboxDisableArgs', () => {
  test('returns --no-sandbox when CONTAINER is set', () => {
    clearEnv();
    process.env.CONTAINER = '1';
    expect(sandboxDisableArgs()).toContain('--no-sandbox');
  });

  test('returns --no-sandbox when CI is set', () => {
    clearEnv();
    process.env.CI = 'true';
    expect(sandboxDisableArgs()).toContain('--no-sandbox');
  });

  test('returns --no-sandbox when running as root (uid 0)', () => {
    clearEnv();
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    // Only assert the root branch when the test process is actually root
    // (true in the CI/container image). On a normal dev box uid!=0, so we
    // assert the negative branch instead.
    if (isRoot) {
      expect(sandboxDisableArgs()).toContain('--no-sandbox');
    } else {
      expect(sandboxDisableArgs()).toEqual([]);
    }
  });

  test('returns [] when not container/CI and not root', () => {
    clearEnv();
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (!isRoot) {
      expect(sandboxDisableArgs()).toEqual([]);
    }
  });
});

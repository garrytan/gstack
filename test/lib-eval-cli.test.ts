/**
 * Tests for lib/cli-eval.ts — eval CLI integration tests.
 *
 * Spawns the CLI as a subprocess and verifies exit codes + output.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { formatLeaderboard } from '../lib/cli-eval';
import type { LeaderboardEntry } from '../lib/dashboard-queries';

const CLI_PATH = path.resolve(__dirname, '..', 'lib', 'cli-eval.ts');
const TEST_DIR = path.join(os.tmpdir(), `gstack-cli-eval-test-${Date.now()}`);
const EVAL_DIR = path.join(TEST_DIR, 'evals');

function runCli(args: string[], env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(['bun', 'run', CLI_PATH, ...args], {
    env: {
      ...process.env,
      HOME: TEST_DIR,
      GSTACK_STATE_DIR: path.join(TEST_DIR, '.gstack'),
      ...env,
    },
    cwd: TEST_DIR,
  });
  return {
    stdout: proc.stdout?.toString() || '',
    stderr: proc.stderr?.toString() || '',
    exitCode: proc.exitCode,
  };
}

// Write a minimal valid eval result file
function writeEvalFile(name: string, overrides?: Partial<Record<string, any>>): string {
  const filePath = path.join(EVAL_DIR, name);
  const data = {
    schema_version: 1,
    version: '0.3.3',
    branch: 'main',
    git_sha: 'abc1234',
    timestamp: '2025-05-01T12:00:00Z',
    hostname: 'test',
    tier: 'e2e',
    total_tests: 1,
    passed: 1,
    failed: 0,
    total_cost_usd: 0.50,
    total_duration_ms: 30000,
    tests: [{ name: 'test-a', suite: 'core', tier: 'e2e', passed: true, duration_ms: 30000, cost_usd: 0.50 }],
    ...overrides,
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

describe('lib/cli-eval', () => {
  beforeAll(() => {
    fs.mkdirSync(EVAL_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.gstack-dev', 'evals'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('help', () => {
    test('shows usage with --help', () => {
      const { stdout, exitCode } = runCli(['--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('gstack eval');
      expect(stdout).toContain('list');
      expect(stdout).toContain('compare');
      expect(stdout).toContain('push');
    });

    test('shows usage with no args', () => {
      const { stdout, exitCode } = runCli([]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('gstack eval');
    });

    test('unknown command shows error and usage', () => {
      const { stderr, exitCode } = runCli(['nonsense']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown command');
    });
  });

  describe('list', () => {
    test('shows "no eval runs" when empty', () => {
      const { stdout } = runCli(['list']);
      expect(stdout).toContain('No eval runs');
    });
  });

  describe('push', () => {
    test('push: missing file argument shows usage', () => {
      const { stderr, exitCode } = runCli(['push']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });

    test('push: file not found exits with error', () => {
      const { stderr, exitCode } = runCli(['push', '/nonexistent/eval.json']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('File not found');
    });

    test('push: invalid JSON exits with error', () => {
      const badFile = path.join(TEST_DIR, 'bad.json');
      fs.writeFileSync(badFile, 'not json at all');
      const { stderr, exitCode } = runCli(['push', badFile]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Invalid JSON');
    });

    test('push: invalid schema exits with validation errors', () => {
      const invalidFile = path.join(TEST_DIR, 'invalid-schema.json');
      fs.writeFileSync(invalidFile, JSON.stringify({ not: 'a valid eval' }));
      const { stderr, exitCode } = runCli(['push', invalidFile]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Validation errors');
    });

    test('push: valid file succeeds with local-only message', () => {
      // Write a valid standard format eval
      const validFile = path.join(TEST_DIR, 'valid-eval.json');
      fs.writeFileSync(validFile, JSON.stringify({
        schema_version: 1,
        version: '0.3.3',
        git_branch: 'main',
        git_sha: 'abc1234',
        timestamp: '2025-05-01T12:00:00Z',
        hostname: 'test',
        tier: 'e2e',
        total: 1,
        passed: 1,
        failed: 0,
        total_cost_usd: 0.50,
        duration_seconds: 30,
        all_results: [{ name: 'test-a', passed: true }],
      }));
      const { stdout, exitCode } = runCli(['push', validFile]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Saved to');
      // sync not configured, so we get local-only or "not configured"
      expect(stdout).toMatch(/local|not configured|Synced|queued/i);
    });
  });

  describe('cost', () => {
    test('cost: missing file shows usage', () => {
      const { stderr, exitCode } = runCli(['cost']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });

    test('cost: file without costs shows message', () => {
      const file = path.join(TEST_DIR, 'no-costs.json');
      fs.writeFileSync(file, JSON.stringify({ version: '1.0' }));
      const { stdout } = runCli(['cost', file]);
      expect(stdout).toContain('No cost data');
    });
  });

  describe('cache', () => {
    test('cache: no subcommand shows usage', () => {
      const { stderr, exitCode } = runCli(['cache']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('Usage');
    });

    test('cache stats: empty cache', () => {
      const { stdout } = runCli(['cache', 'stats']);
      expect(stdout).toContain('empty');
    });
  });

  describe('help includes leaderboard', () => {
    test('usage mentions leaderboard command', () => {
      const { stdout } = runCli(['--help']);
      expect(stdout).toContain('leaderboard');
    });
  });
});

// --- formatLeaderboard (pure function tests) ---

describe('formatLeaderboard', () => {
  test('formats entries as table', () => {
    const entries: LeaderboardEntry[] = [
      { userId: 'u1', email: 'alice@test.com', ships: 5, evalRuns: 3, sessions: 10, avgPassRate: 92, totalCost: 4.50 },
      { userId: 'u2', email: 'bob@test.com', ships: 3, evalRuns: 2, sessions: 8, avgPassRate: 85, totalCost: 3.00 },
    ];
    const output = formatLeaderboard(entries);

    expect(output).toContain('Team Leaderboard');
    expect(output).toContain('alice@test.com');
    expect(output).toContain('bob@test.com');
    expect(output).toContain('5');  // alice's ships
    expect(output).toContain('92%');
    expect(output).toContain('85%');
    expect(output).toContain('$4.50');
    expect(output).toContain('2 contributors');
    expect(output).toContain('8 ships');
  });

  test('returns message for empty entries', () => {
    const output = formatLeaderboard([]);
    expect(output).toContain('No activity');
  });

  test('handles null avgPassRate', () => {
    const entries: LeaderboardEntry[] = [
      { userId: 'u1', email: 'alice@test.com', ships: 1, evalRuns: 0, sessions: 2, avgPassRate: null, totalCost: 0 },
    ];
    const output = formatLeaderboard(entries);
    expect(output).toContain('—');
    expect(output).not.toContain('null');
  });

  test('ranks entries in order', () => {
    const entries: LeaderboardEntry[] = [
      { userId: 'u1', email: 'first@test.com', ships: 5, evalRuns: 0, sessions: 0, avgPassRate: null, totalCost: 0 },
      { userId: 'u2', email: 'second@test.com', ships: 3, evalRuns: 0, sessions: 0, avgPassRate: null, totalCost: 0 },
    ];
    const output = formatLeaderboard(entries);
    const firstIdx = output.indexOf('first@test.com');
    const secondIdx = output.indexOf('second@test.com');
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(output).toContain('1.');
    expect(output).toContain('2.');
  });
});

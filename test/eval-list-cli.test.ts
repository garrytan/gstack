import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-eval-list-'));
  const evalDir = path.join(tmpHome, '.gstack-dev', 'evals');
  fs.mkdirSync(evalDir, { recursive: true });
  writeEvalRun(evalDir, '2026-a.json', '2026-05-24T01:00:00Z', 2);
  writeEvalRun(evalDir, '2026-b.json', '2026-05-24T02:00:00Z', 3);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeEvalRun(evalDir: string, filename: string, timestamp: string, turns: number) {
  fs.writeFileSync(
    path.join(evalDir, filename),
    JSON.stringify({
      schema_version: 1,
      version: '1.44.0.0',
      branch: 'main',
      git_sha: filename,
      timestamp,
      tier: 'e2e',
      total_tests: 1,
      passed: 1,
      failed: 0,
      total_cost_usd: 0,
      total_duration_ms: 1000,
      tests: [
        {
          name: filename,
          suite: 'sample',
          tier: 'e2e',
          passed: true,
          duration_ms: 1000,
          cost_usd: 0,
          turns_used: turns,
        },
      ],
    }),
  );
}

function runEvalList(...args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('bun', ['run', 'scripts/eval-list.ts', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: tmpHome,
      GSTACK_HOME: path.join(tmpHome, '.gstack'),
    },
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('eval:list CLI', () => {
  test('limits displayed eval runs with a valid positive integer', () => {
    const result = runEvalList('--limit', '1');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Eval History (2 total runs)');
    expect(result.stdout).toContain('Showing: 1');
    expect(result.stdout).toContain('2026-05-24 02:00');
    expect(result.stdout).not.toContain('2026-05-24 01:00');
  });

  test('rejects malformed limit values instead of silently slicing output', () => {
    for (const value of ['1abc', 'nope', '0', '-1', '1.5']) {
      const result = runEvalList('--limit', value);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('--limit requires a positive integer');
      expect(result.stdout).toBe('');
    }
  });
});

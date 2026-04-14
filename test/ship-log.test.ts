/**
 * Unit tests for gstack-ship-log.
 * Free (no API calls), runs with `bun test`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;

const execOpts = (): ExecSyncOptionsWithStringEncoding => ({
  cwd: ROOT,
  env: { ...process.env, GSTACK_STATE_DIR: tmpDir },
  encoding: 'utf-8',
  timeout: 15000,
});

function run(args: string, opts: { expectFail?: boolean } = {}): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`${BIN}/gstack-ship-log ${args}`, execOpts()).trim();
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail) {
      return { stdout: (e.stderr?.toString() || '').trim(), exitCode: e.status || 1 };
    }
    throw e;
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ship-log-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gstack-ship-log', () => {
  test('passes bash syntax check', () => {
    execSync(`bash -n ${BIN}/gstack-ship-log`, { encoding: 'utf-8' });
  });

  test('appends valid JSONL entry', () => {
    const entry = '{"ts":"2026-03-28T10:00:00Z","version":"1.0.0","branch":"feat/foo","pr_url":"https://example.com/1"}';
    run(`'${entry}'`);

    const logFile = path.join(tmpDir, 'analytics', 'ship-log.jsonl');
    expect(fs.existsSync(logFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(logFile, 'utf-8').trim());
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.branch).toBe('feat/foo');
  });

  test('appends multiple entries as separate lines', () => {
    run(`'{"ts":"2026-03-28T10:00:00Z","version":"1.0.0"}'`);
    run(`'{"ts":"2026-03-28T11:00:00Z","version":"1.0.1"}'`);

    const logFile = path.join(tmpDir, 'analytics', 'ship-log.jsonl');
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  test('read returns NO_SHIP_LOG when no log exists', () => {
    const result = run('read');
    expect(result.stdout).toBe('NO_SHIP_LOG');
    expect(result.exitCode).toBe(0);
  });

  test('read returns log contents', () => {
    run(`'{"ts":"2026-03-28T10:00:00Z","version":"1.0.0"}'`);
    const result = run('read');
    expect(result.stdout).toContain('"version":"1.0.0"');
  });

  test('read --window filters by date', () => {
    const recent = `{"ts":"${new Date().toISOString()}","version":"2.0.0"}`;
    const old = '{"ts":"2020-01-01T00:00:00Z","version":"0.1.0"}';
    run(`'${old}'`);
    run(`'${recent}'`);

    const result = run('read --window 7d');
    expect(result.stdout).toContain('2.0.0');
    expect(result.stdout).not.toContain('0.1.0');
  });

  test('--help prints usage', () => {
    const result = run('--help');
    expect(result.stdout).toContain('gstack-ship-log');
    expect(result.exitCode).toBe(0);
  });

  test('empty args prints usage to stderr and exits 1', () => {
    const result = run('', { expectFail: true });
    expect(result.exitCode).toBe(1);
  });

  test('creates analytics directory if missing', () => {
    const analyticsDir = path.join(tmpDir, 'analytics');
    expect(fs.existsSync(analyticsDir)).toBe(false);
    run(`'{"ts":"2026-03-28T10:00:00Z"}'`);
    expect(fs.existsSync(analyticsDir)).toBe(true);
  });
});

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;
let slugDir: string;

function runLog(input: string, opts: { expectFail?: boolean } = {}): { stdout: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, NSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    const stdout = execSync(`${BIN}/nstack-timeline-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim();
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail) {
      return { stdout: e.stderr?.toString() || '', exitCode: e.status || 1 };
    }
    throw e;
  }
}

function runRead(args: string = ''): string {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, NSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    return execSync(`${BIN}/nstack-timeline-read ${args}`, execOpts).trim();
  } catch {
    return '';
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nstack-timeline-'));
  slugDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(slugDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function findTimelineFile(): string | null {
  const projectDirs = fs.readdirSync(slugDir);
  if (projectDirs.length === 0) return null;
  const f = path.join(slugDir, projectDirs[0], 'timeline.jsonl');
  return fs.existsSync(f) ? f : null;
}

describe('nstack-timeline-log', () => {
  test('accepts valid JSON and appends to timeline.jsonl', () => {
    const input = '{"skill":"review","event":"started","branch":"main"}';
    const result = runLog(input);
    expect(result.exitCode).toBe(0);

    const f = findTimelineFile();
    expect(f).not.toBeNull();
    const content = fs.readFileSync(f!, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.skill).toBe('review');
    expect(parsed.event).toBe('started');
    expect(parsed.branch).toBe('main');
  });

  test('rejects invalid JSON with exit 0 (non-blocking)', () => {
    const result = runLog('not json at all');
    expect(result.exitCode).toBe(0);

    // No file should be created
    const f = findTimelineFile();
    expect(f).toBeNull();
  });

  test('injects timestamp when ts field is missing', () => {
    const input = '{"skill":"review","event":"started","branch":"main"}';
    runLog(input);

    const f = findTimelineFile();
    expect(f).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(f!, 'utf-8').trim());
    expect(parsed.ts).toBeDefined();
    expect(new Date(parsed.ts).getTime()).toBeGreaterThan(0);
  });

  test('preserves timestamp when ts field is present', () => {
    const input = '{"skill":"review","event":"completed","branch":"main","ts":"2025-06-15T10:00:00Z"}';
    runLog(input);

    const f = findTimelineFile();
    expect(f).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(f!, 'utf-8').trim());
    expect(parsed.ts).toBe('2025-06-15T10:00:00Z');
  });

  test('validates required fields (skill, event) - exits 0 if missing skill', () => {
    const result = runLog('{"event":"started","branch":"main"}');
    expect(result.exitCode).toBe(0);

    const f = findTimelineFile();
    expect(f).toBeNull();
  });

  test('validates required fields (skill, event) - exits 0 if missing event', () => {
    const result = runLog('{"skill":"review","branch":"main"}');
    expect(result.exitCode).toBe(0);

    const f = findTimelineFile();
    expect(f).toBeNull();
  });
});

describe('nstack-timeline-read', () => {
  test('returns empty output for missing file (exit 0)', () => {
    const output = runRead();
    expect(output).toBe('');
  });

  test('filters by --branch', () => {
    runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'feature-a', outcome: 'approved', ts: '2026-03-28T10:00:00Z' }));
    runLog(JSON.stringify({ skill: 'ship', event: 'completed', branch: 'feature-b', outcome: 'merged', ts: '2026-03-28T11:00:00Z' }));

    const output = runRead('--branch feature-a');
    expect(output).toContain('review');
    expect(output).not.toContain('feature-b');
  });

  test('limits output with --limit', () => {
    for (let i = 0; i < 5; i++) {
      runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'main', outcome: 'approved', ts: `2026-03-2${i}T10:00:00Z` }));
    }

    const unlimited = runRead('--limit 20');
    const limited = runRead('--limit 2');

    // Count event lines (lines starting with "- ")
    const unlimitedEvents = unlimited.split('\n').filter(l => l.startsWith('- ')).length;
    const limitedEvents = limited.split('\n').filter(l => l.startsWith('- ')).length;

    expect(unlimitedEvents).toBe(5);
    expect(limitedEvents).toBe(2);
  });
});

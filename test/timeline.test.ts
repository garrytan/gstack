import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync, execSync, spawnSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
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
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    const stdout = execSync(`${BIN}/gstack-timeline-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim();
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
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    return execSync(`${BIN}/gstack-timeline-read ${args}`, execOpts).trim();
  } catch {
    return '';
  }
}

function runReadArgs(args: string[] = []): string {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    return execFileSync(path.join(BIN, 'gstack-timeline-read'), args, execOpts).trim(); // timeout via execOpts
  } catch {
    return '';
  }
}

function runReadStatus(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(path.join(BIN, 'gstack-timeline-read'), args, {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-timeline-'));
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

describe('gstack-timeline-log', () => {
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

describe('gstack-timeline-read', () => {
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

  test('filters branch names containing single quotes', () => {
    runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: "feature/o'hare", outcome: 'approved', ts: '2026-03-28T10:00:00Z' }));
    runLog(JSON.stringify({ skill: 'ship', event: 'completed', branch: 'feature-other', outcome: 'merged', ts: '2026-03-28T11:00:00Z' }));

    const output = runReadArgs(['--branch', "feature/o'hare"]);

    expect(output).toContain('review');
    expect(output).toContain("feature/o'hare");
    expect(output).not.toContain('feature-other');
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

  test('no --limit still shows the 20 most recent events', () => {
    for (let i = 0; i < 25; i++) {
      runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'main', ts: `2026-03-01T10:${String(i).padStart(2, '0')}:00Z` }));
    }
    const result = runReadStatus([]);
    expect(result.status).toBe(0);
    const events = result.stdout.split('\n').filter(l => l.startsWith('- '));
    expect(events.length).toBe(20);
    expect(events[0]).toContain('10:05:00Z');
  });

  // #1723: a malformed --limit used to be parsed leniently (1abc -> 1) or
  // silently replaced by the default; a bare --limit crashed on unbound $2.
  const badLimits: Array<[string, string[], string]> = [
    ['missing value', ['--limit'], 'got no value'],
    ['zero', ['--limit', '0'], "got '0'"],
    ['negative', ['--limit', '-5'], "got '-5'"],
    ['non-numeric', ['--limit', 'abc'], "got 'abc'"],
    ['trailing garbage', ['--limit', '1abc'], "got '1abc'"],
  ];
  for (const history of ['empty', 'populated'] as const) {
    for (const [label, args, got] of badLimits) {
      test(`--limit ${label} exits 2 with an example on ${history} history`, () => {
        if (history === 'populated') {
          runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'main', ts: '2026-03-28T10:00:00Z' }));
        }
        const result = runReadStatus(args);
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('--limit must be a positive integer');
        expect(result.stderr).toContain(got);
        expect(result.stderr).toContain('example: --limit 20');
      });
    }
  }

  // --since/--branch used to read an unbound $2 (exit 1), and an unparseable
  // --since silently returned unfiltered history.
  const badFilters: Array<[string, string[], string]> = [
    ['--since missing value', ['--since'], '--since must be a relative time like "7 days ago" (got no value)'],
    ['--since empty value', ['--since', ''], '--since must be a relative time like "7 days ago" (got an empty value)'],
    ['--since followed by a flag', ['--since', '--limit', '5'], "(got flag '--limit')"],
    ['--since yesterday', ['--since', 'yesterday'], "--since must be a relative time like \"7 days ago\" (got 'yesterday')"],
    ['--since 2 weeks', ['--since', '2 weeks'], "(got '2 weeks')"],
    ['--since 7days', ['--since', '7days'], "(got '7days')"],
    ['--since impossible month', ['--since', '2026-13-01'], "(got '2026-13-01')"],
    ['--since unanchored', ['--since', 'about 7 days ago, roughly'], "(got 'about 7 days ago, roughly')"],
    ['--branch missing value', ['--branch'], '--branch must be a branch name (got no value)'],
    ['--branch empty value', ['--branch', ''], '--branch must be a branch name (got an empty value)'],
    ['--branch followed by a flag', ['--branch', '--limit', '5'], "--branch must be a branch name (got flag '--limit')"],
    ['unknown flag', ['--bogus'], "unknown argument '--bogus'"],
    ['stray argument', ['stray'], "unknown argument 'stray'"],
  ];
  for (const history of ['empty', 'populated'] as const) {
    for (const [label, args, message] of badFilters) {
      test(`${label} exits 2 before any read on ${history} history`, () => {
        if (history === 'populated') {
          runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'main', ts: '2026-03-28T10:00:00Z' }));
        }
        const result = runReadStatus(args);
        expect(result.status, result.stderr).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(message);
        if (label.startsWith('--since')) expect(result.stderr).toContain('accepted: "<N> minute|hour|day|week|month[s] ago", "<N>h|d|w", or an ISO date');
        if (label === 'unknown flag' || label === 'stray argument') expect(result.stderr).toContain('Usage: gstack-timeline-read');
      });
    }

    test(`--help prints the usage line and exits 0 on ${history} history`, () => {
      if (history === 'populated') {
        runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'main', ts: '2026-03-28T10:00:00Z' }));
      }
      const result = runReadStatus(['--help']);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('Usage: gstack-timeline-read [--since "7 days ago"|7d|YYYY-MM-DD] [--limit N] [--branch NAME]');
    });

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    for (const since of ['7 days ago', '3 Hours ago', '7d', '24h', '1w', yesterday, `${yesterday}T00:00:00Z`]) {
      test(`--since '${since}' keeps recent events and drops old ones on ${history} history`, () => {
        if (history === 'populated') {
          runLog(JSON.stringify({ skill: 'review', event: 'completed', branch: 'main', ts: '2020-01-01T10:00:00Z' }));
          runLog(JSON.stringify({ skill: 'ship', event: 'completed', branch: 'main', ts: new Date(Date.now() - 3_600_000).toISOString() }));
        }
        const result = runReadStatus(['--since', since]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        if (history === 'empty') expect(result.stdout).toBe('');
        else {
          expect(result.stdout).toContain('/ship completed');
          expect(result.stdout).not.toContain('/review completed');
        }
      });
    }
  }
});

// The four secret families brain sync's scanner used to miss (GST-2196).
// Built by concatenation so this file never holds a scannable literal.
const SECRET_FAMILIES: [string, string][] = [
  ['stripe live key', 'sk_' + 'live_' + 'Q7d2Lm9Xr4Tb8Vn1Kp3Wz6Hc'],
  ['slack bot token', 'xox' + 'b-' + '2384710293-4829103847-Zr8Qm2Lx7Vn4Tb'],
  ['database url with a password', 'postgres://app:' + 'Vq8zR2' + 'mLp7@db.internal.example.com:5432/prod'],
  ['npm token', 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
];

describe('gstack-timeline-log refuses HIGH-tier secrets', () => {
  for (const [name, secret] of SECRET_FAMILIES) {
    test(`rejects a ${name} in any field and writes nothing`, () => {
      const input = JSON.stringify({ skill: 'ship', event: 'completed', branch: 'main', outcome: `deploy failed: ${secret}` });
      const result = runLog(input, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain('HIGH-tier secret');
      expect(result.stdout).not.toContain(secret);
      expect(findTimelineFile()).toBeNull();
    });
  }

  test('ordinary events with token and password words still write', () => {
    const input = '{"skill":"review","event":"completed","branch":"fix-token-refresh","outcome":"password reset flow reviewed; token rotation ok"}';
    expect(runLog(input).exitCode).toBe(0);
    const f = findTimelineFile();
    expect(f).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(f!, 'utf-8').trim()).outcome).toBe('password reset flow reviewed; token rotation ok');
  });
});

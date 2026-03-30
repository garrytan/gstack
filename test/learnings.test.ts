import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;
let slugDir: string;
let learningsFile: string;

function runLog(input: string, opts: { expectFail?: boolean } = {}): { stdout: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    const stdout = execSync(`${BIN}/gstack-learnings-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim();
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail) {
      return { stdout: e.stderr?.toString() || '', exitCode: e.status || 1 };
    }
    throw e;
  }
}

function runSearch(args: string = ''): string {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 15000,
  };
  try {
    return execSync(`${BIN}/gstack-learnings-search ${args}`, execOpts).trim();
  } catch {
    return '';
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-learn-'));
  slugDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(slugDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function findLearningsFile(): string | null {
  const projectDirs = fs.readdirSync(slugDir);
  if (projectDirs.length === 0) return null;
  const f = path.join(slugDir, projectDirs[0], 'learnings.jsonl');
  return fs.existsSync(f) ? f : null;
}

describe('gstack-learnings-log', () => {
  test('appends valid JSON to learnings.jsonl', () => {
    const input = '{"skill":"review","type":"pattern","key":"test-key","insight":"test insight","confidence":8,"source":"observed"}';
    const result = runLog(input);
    expect(result.exitCode).toBe(0);

    const f = findLearningsFile();
    expect(f).not.toBeNull();
    const content = fs.readFileSync(f!, 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.skill).toBe('review');
    expect(parsed.key).toBe('test-key');
    expect(parsed.confidence).toBe(8);
  });

  test('auto-injects timestamp when ts is missing', () => {
    const input = '{"skill":"review","type":"pattern","key":"ts-test","insight":"test","confidence":5,"source":"observed"}';
    runLog(input);

    const f = findLearningsFile();
    expect(f).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(f!, 'utf-8').trim());
    expect(parsed.ts).toBeDefined();
    expect(new Date(parsed.ts).getTime()).toBeGreaterThan(0);
  });

  test('rejects non-JSON input with non-zero exit code', () => {
    const result = runLog('not json at all', { expectFail: true });
    expect(result.exitCode).not.toBe(0);
  });

  test('append-only: duplicate keys create multiple entries', () => {
    const input1 = '{"skill":"review","type":"pattern","key":"dup-key","insight":"first version","confidence":6,"source":"observed"}';
    const input2 = '{"skill":"review","type":"pattern","key":"dup-key","insight":"second version","confidence":8,"source":"observed"}';
    runLog(input1);
    runLog(input2);

    const f = findLearningsFile();
    expect(f).not.toBeNull();
    const lines = fs.readFileSync(f!, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });
});

describe('gstack-learnings-search', () => {
  test('returns empty and exits 0 when no learnings file exists', () => {
    const output = runSearch();
    expect(output).toBe('');
  });

  test('returns formatted output when learnings exist', () => {
    runLog('{"skill":"review","type":"pattern","key":"test-search","insight":"search test insight","confidence":7,"source":"observed"}');
    const output = runSearch();
    expect(output).toContain('LEARNINGS:');
    expect(output).toContain('test-search');
    expect(output).toContain('search test insight');
  });

  test('deduplicates entries by key+type (latest wins)', () => {
    const old = JSON.stringify({ skill: 'review', type: 'pattern', key: 'dedup-test', insight: 'old version', confidence: 5, source: 'observed', ts: '2026-01-01T00:00:00Z' });
    const newer = JSON.stringify({ skill: 'review', type: 'pattern', key: 'dedup-test', insight: 'new version', confidence: 8, source: 'observed', ts: '2026-03-28T00:00:00Z' });
    runLog(old);
    runLog(newer);

    const output = runSearch();
    expect(output).toContain('new version');
    expect(output).not.toContain('old version');
    expect(output).toContain('1 loaded');
  });

  test('filters by --type', () => {
    runLog('{"skill":"review","type":"pattern","key":"p1","insight":"a pattern","confidence":7,"source":"observed"}');
    runLog('{"skill":"review","type":"pitfall","key":"p2","insight":"a pitfall","confidence":7,"source":"observed"}');

    const patternOnly = runSearch('--type pattern');
    expect(patternOnly).toContain('p1');
    expect(patternOnly).not.toContain('p2');
  });

  test('filters by --query', () => {
    runLog('{"skill":"review","type":"pattern","key":"auth-bypass","insight":"check session tokens","confidence":7,"source":"observed"}');
    runLog('{"skill":"review","type":"pattern","key":"n-plus-one","insight":"use includes for associations","confidence":7,"source":"observed"}');

    const authOnly = runSearch('--query auth');
    expect(authOnly).toContain('auth-bypass');
    expect(authOnly).not.toContain('n-plus-one');
  });

  test('respects --limit', () => {
    for (let i = 0; i < 5; i++) {
      runLog(`{"skill":"review","type":"pattern","key":"limit-${i}","insight":"insight ${i}","confidence":7,"source":"observed"}`);
    }

    const limited = runSearch('--limit 2');
    // Should show 2, not 5
    expect(limited).toContain('2 loaded');
  });

  test('applies confidence decay for observed/inferred sources', () => {
    // Entry from 90 days ago with source=observed, confidence=8
    // Should decay to 8 - floor(90/30) = 8 - 3 = 5
    const ts = new Date(Date.now() - 90 * 86400000).toISOString();
    runLog(`{"skill":"review","type":"pattern","key":"decay-test","insight":"old observation","confidence":8,"source":"observed","ts":"${ts}"}`);

    const output = runSearch();
    // Should show confidence 5 (decayed from 8)
    expect(output).toContain('confidence: 5/10');
  });

  test('does NOT decay user-stated learnings', () => {
    const ts = new Date(Date.now() - 90 * 86400000).toISOString();
    runLog(`{"skill":"review","type":"preference","key":"no-decay-test","insight":"user preference","confidence":9,"source":"user-stated","ts":"${ts}"}`);

    const output = runSearch();
    // Should still show confidence 9 (no decay for user-stated)
    expect(output).toContain('confidence: 9/10');
  });

  test('skips malformed JSONL lines gracefully', () => {
    // Write a valid entry, then manually append a bad line
    runLog('{"skill":"review","type":"pattern","key":"valid-entry","insight":"valid","confidence":7,"source":"observed"}');
    const f = findLearningsFile();
    expect(f).not.toBeNull();
    fs.appendFileSync(f!, '\nthis is not json\n');
    fs.appendFileSync(f!, '{"skill":"review","type":"pattern","key":"also-valid","insight":"also valid","confidence":6,"source":"observed","ts":"2026-03-28T00:00:00Z"}\n');

    const output = runSearch();
    expect(output).toContain('valid-entry');
    expect(output).toContain('also-valid');
  });
});

describe('gstack-learnings-log edge cases', () => {
  test('preserves existing timestamp when ts is present', () => {
    const input = '{"skill":"review","type":"pattern","key":"ts-preserve","insight":"test","confidence":5,"source":"observed","ts":"2025-06-15T10:00:00Z"}';
    runLog(input);

    const f = findLearningsFile();
    expect(f).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(f!, 'utf-8').trim());
    expect(parsed.ts).toBe('2025-06-15T10:00:00Z');
  });

  test('handles JSON with special characters in insight', () => {
    const input = JSON.stringify({ skill: 'review', type: 'pattern', key: 'special-chars', insight: 'Use "quotes" and \\backslashes', confidence: 7, source: 'observed' });
    runLog(input);

    const f = findLearningsFile();
    expect(f).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(f!, 'utf-8').trim());
    expect(parsed.insight).toContain('quotes');
    expect(parsed.insight).toContain('backslashes');
  });

  test('handles JSON with files array field', () => {
    const input = JSON.stringify({ skill: 'review', type: 'architecture', key: 'with-files', insight: 'test', confidence: 8, source: 'observed', files: ['src/auth.ts', 'src/db.ts'] });
    runLog(input);

    const f = findLearningsFile();
    expect(f).not.toBeNull();
    const parsed = JSON.parse(fs.readFileSync(f!, 'utf-8').trim());
    expect(parsed.files).toEqual(['src/auth.ts', 'src/db.ts']);
  });
});

describe('gstack-learnings-search edge cases', () => {
  test('sorts by confidence then recency', () => {
    // Two entries: one high confidence old, one lower confidence recent
    runLog(JSON.stringify({ skill: 'review', type: 'pattern', key: 'high-conf', insight: 'high confidence entry', confidence: 9, source: 'user-stated', ts: '2026-01-01T00:00:00Z' }));
    runLog(JSON.stringify({ skill: 'review', type: 'pattern', key: 'recent', insight: 'recent entry', confidence: 5, source: 'observed', ts: '2026-03-28T00:00:00Z' }));

    const output = runSearch();
    const highIdx = output.indexOf('high-conf');
    const recentIdx = output.indexOf('recent');
    // High confidence should appear first
    expect(highIdx).toBeLessThan(recentIdx);
  });

  test('groups output by type', () => {
    runLog(JSON.stringify({ skill: 'review', type: 'pattern', key: 'p1', insight: 'a pattern', confidence: 7, source: 'observed' }));
    runLog(JSON.stringify({ skill: 'review', type: 'pitfall', key: 'pit1', insight: 'a pitfall', confidence: 7, source: 'observed' }));

    const output = runSearch();
    expect(output).toContain('## Patterns');
    expect(output).toContain('## Pitfalls');
  });

  test('combined --type and --query filtering', () => {
    runLog(JSON.stringify({ skill: 'review', type: 'pattern', key: 'auth-token', insight: 'check token expiry', confidence: 7, source: 'observed' }));
    runLog(JSON.stringify({ skill: 'review', type: 'pitfall', key: 'auth-leak', insight: 'auth token in logs', confidence: 7, source: 'observed' }));
    runLog(JSON.stringify({ skill: 'review', type: 'pattern', key: 'cache-key', insight: 'cache invalidation', confidence: 7, source: 'observed' }));

    const output = runSearch('--type pattern --query auth');
    expect(output).toContain('auth-token');
    expect(output).not.toContain('auth-leak');  // wrong type
    expect(output).not.toContain('cache-key');  // wrong query
  });

  test('entries with missing key or type are skipped', () => {
    runLog(JSON.stringify({ skill: 'review', type: 'pattern', key: 'valid', insight: 'valid entry', confidence: 7, source: 'observed' }));
    const f = findLearningsFile();
    expect(f).not.toBeNull();
    // Append entries missing key and type
    fs.appendFileSync(f!, JSON.stringify({ skill: 'review', type: 'pattern', insight: 'no key', confidence: 7, source: 'observed' }) + '\n');
    fs.appendFileSync(f!, JSON.stringify({ skill: 'review', key: 'no-type', insight: 'no type', confidence: 7, source: 'observed' }) + '\n');

    const output = runSearch();
    expect(output).toContain('valid');
    expect(output).not.toContain('no key');
    expect(output).not.toContain('no-type');
  });

  test('confidence decay floors at 0 (never negative)', () => {
    // Entry from 1 year ago with confidence 3 — decay would be 12, clamped to 0
    const ts = new Date(Date.now() - 365 * 86400000).toISOString();
    runLog(JSON.stringify({ skill: 'review', type: 'pattern', key: 'ancient', insight: 'very old', confidence: 3, source: 'observed', ts }));

    const output = runSearch();
    expect(output).toContain('confidence: 0/10');
  });
});

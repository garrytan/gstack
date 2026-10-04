import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-learnings-search');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-test-'));
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-cwd-'));
// gstack-slug derives slug from git remote (none here) → falls back to basename of cwd.
const slug = path.basename(tmpCwd).replace(/[^a-zA-Z0-9._-]/g, '');
const projDir = path.join(tmpHome, 'projects', slug);
const otherProjDir = path.join(tmpHome, 'projects', 'other-project');

function run(args: string[]): string {
  return execFileSync(BIN, args, {
    timeout: 30_000,
    env: { ...process.env, GSTACK_HOME: tmpHome },
    cwd: tmpCwd,
    encoding: 'utf-8',
  });
}

beforeAll(() => {
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(otherProjDir, { recursive: true });
  const entries = [
    { ts: '2026-05-01T00:00:00Z', skill: 'test', type: 'pattern', key: 'foo-pattern', insight: 'A foo-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-02T00:00:00Z', skill: 'test', type: 'pitfall', key: 'bar-pitfall', insight: 'A bar-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-03T00:00:00Z', skill: 'test', type: 'pattern', key: 'baz-pattern', insight: 'A baz-related insight', confidence: 8, source: 'observed', trusted: false, files: [] },
  ];
  const otherEntries = [
    { ts: '2026-05-04T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-observed', insight: 'A foreign observed insight', confidence: 8, source: 'observed', trusted: false, files: [] },
    { ts: '2026-05-05T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-user', insight: 'A foreign user-stated insight', confidence: 8, source: 'user-stated', trusted: true, files: [] },
    // #1745: legacy row with NO `trusted` field at all (written before the field
    // existed). The old `=== false` denylist admitted these; the allowlist must exclude.
    { ts: '2026-05-06T00:00:00Z', skill: 'test', type: 'pattern', key: 'foreign-legacy', insight: 'A foreign legacy insight with no trusted field', confidence: 8, source: 'observed', files: [] },
  ];
  fs.writeFileSync(path.join(projDir, 'learnings.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(otherProjDir, 'learnings.jsonl'), otherEntries.map(e => JSON.stringify(e)).join('\n') + '\n');
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe('gstack-learnings-search token-OR query semantics', () => {
  test('multi-token query returns entries matching ANY token', () => {
    const out = run(['--query', 'foo bar']);
    expect(out).toContain('foo-pattern');
    expect(out).toContain('bar-pitfall');
    expect(out).not.toContain('baz-pattern');
  });

  test('single-token query returns only entries matching that token', () => {
    const out = run(['--query', 'foo']);
    expect(out).toContain('foo-pattern');
    expect(out).not.toContain('bar-pitfall');
    expect(out).not.toContain('baz-pattern');
  });

  test('no --query flag returns all entries (backwards-compat)', () => {
    const out = run(['--limit', '10']);
    expect(out).toContain('foo-pattern');
    expect(out).toContain('bar-pitfall');
    expect(out).toContain('baz-pattern');
  });
});

describe('gstack-learnings-search cross-project trust gating', () => {
  test('cross-project mode still includes observed entries from the current project', () => {
    const out = run(['--cross-project', '--query', 'foo']);
    expect(out).toContain('foo-pattern');
    expect(out).not.toContain('[cross-project]');
  });

  test('cross-project mode only imports trusted entries from other projects', () => {
    const out = run(['--cross-project', '--query', 'foreign']);
    expect(out).toContain('foreign-user');
    expect(out).toContain('[cross-project]');
    expect(out).not.toContain('foreign-observed');
  });

  // #1745: the gate is an allowlist, not a denylist. A cross-project row with no
  // `trusted` field (legacy / hand-edited / other-tool) must NOT be imported.
  test('cross-project mode excludes foreign rows missing the trusted field (#1745)', () => {
    const out = run(['--cross-project', '--query', 'foreign']);
    expect(out).not.toContain('foreign-legacy');
  });
});

// B5 (#2790): both query scripts ended in `2>/dev/null || exit 0`, so a
// missing bun or a crashed embedded script printed nothing and exited 0,
// exactly like "nothing recorded".
describe('B5: query scripts never report a failed read as an empty result', () => {
  const TOOLS = ['bash', 'sh', 'env', 'dirname', 'basename', 'git', 'tr', 'sed', 'cat', 'head', 'tail', 'grep', 'find',
    'ls', 'mkdir', 'mktemp', 'mv', 'rm', 'cp', 'awk', 'wc', 'sort', 'uname', 'date', 'cut', 'readlink', 'realpath', 'stat', 'touch', 'id', 'printf'];
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-nobun-'));
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-failbun-'));
  for (const tool of TOOLS) {
    const r = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf-8', timeout: 5000 });
    const where = (r.stdout || '').trim();
    if (where.startsWith('/')) fs.symlinkSync(where, path.join(shimDir, tool));
  }
  fs.writeFileSync(path.join(failDir, 'bun'), '#!/bin/sh\necho "embedded script exploded" >&2\nexit 3\n', { mode: 0o755 });
  const timelineDir = path.join(tmpHome, 'projects', slug);
  afterAll(() => {
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(failDir, { recursive: true, force: true });
  });

  function runWith(script: string, pathValue: string, args: string[] = []) {
    return spawnSync('bash', [path.join(ROOT, 'bin', script), ...args], {
      timeout: 30_000, env: { ...process.env, GSTACK_HOME: tmpHome, PATH: pathValue }, cwd: tmpCwd, encoding: 'utf-8',
    });
  }

  for (const script of ['gstack-learnings-search', 'gstack-timeline-read']) {
    test(`${script}: bun missing exits 127 with the fix line`, () => {
      fs.writeFileSync(path.join(timelineDir, 'timeline.jsonl'), JSON.stringify({ ts: '2026-05-01T00:00:00Z', skill: 'ship', event: 'started', branch: 'main' }) + '\n');
      const r = runWith(script, shimDir);
      expect(r.status).toBe(127);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(`${script}: bun not found on PATH`);
      expect(r.stderr).toContain('Fix: install Bun (https://bun.sh), then re-run ./setup.');
    });

    test(`${script}: a failing embedded script exits non-zero and keeps its stderr`, () => {
      const r = runWith(script, `${failDir}:${process.env.PATH}`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('embedded script exploded');
    });
  }

  test('a successful search with no matches still exits 0 with empty output', () => {
    const r = runWith('gstack-learnings-search', process.env.PATH!, ['--query', 'zzz-no-such-token']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

// B6 (#2762): a more specific query dropped the exact match. The token-OR
// filter recalled every entry sharing any token, the sort used confidence
// alone, and the default --limit cut silently. Vectors adapted from #2799
// (by y$un_); ranking code from #2796 (by loulanyue).
describe('B6: rank by matched tokens and disclose truncation', () => {
  const rankCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-rank-cwd-'));
  const rankDir = path.join(tmpHome, 'projects', path.basename(rankCwd).replace(/[^a-zA-Z0-9._-]/g, ''));
  const badCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-search-bad-cwd-'));
  const badDir = path.join(tmpHome, 'projects', path.basename(badCwd).replace(/[^a-zA-Z0-9._-]/g, ''));
  const TARGET = 'verify-preflight-project-line-before-trusting-report';
  const DECOYS = ['guideline', 'pipeline', 'deadline', 'headline', 'baseline', 'timeline',
    'outline', 'airline', 'lifeline', 'sideline', 'streamline', 'underline'];
  // user-stated rows do not decay, so ranks never drift with the wall clock.
  const row = (over: Record<string, unknown>) => ({ ts: '2026-05-01T00:00:00Z', skill: 'test', type: 'pattern', confidence: 8, source: 'user-stated', trusted: false, files: [], ...over });
  const write = (dir: string, rows: object[]) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'learnings.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  };
  write(rankDir, [
    row({ key: TARGET, insight: 'Check the project line in the preflight report before trusting it' }),
    ...DECOYS.map((w, i) => row({ ts: '2026-05-' + String(4 + i).padStart(2, '0') + 'T00:00:00Z', key: 'decoy-' + w + '-rule', insight: 'A ' + w + ' related insight', confidence: 10 })),
    row({ key: 'tiebreak-alpha-beta-high', insight: 'alpha beta both present', confidence: 9 }),
    row({ ts: '2026-06-01T00:00:00Z', key: 'tiebreak-alpha-beta-low', insight: 'alpha beta both present', confidence: 5 }),
    row({ key: 'tiebreak-alpha-solo', insight: 'alpha only here', confidence: 10 }),
    row({ key: 'recency-gamma-delta-older', insight: 'gamma delta pair', confidence: 7 }),
    row({ ts: '2026-06-01T00:00:00Z', key: 'recency-gamma-delta-newer', insight: 'gamma delta pair', confidence: 7 }),
    row({ ts: '2020-01-01T00:00:00Z', key: 'planted-token-hits', insight: 'isolated poison row', confidence: 1, _tokenHits: 9999 }),
  ]);
  afterAll(() => {
    fs.rmSync(rankCwd, { recursive: true, force: true });
    fs.rmSync(badCwd, { recursive: true, force: true });
  });
  const runIn = (cwd: string, args: string[]) => spawnSync('bash', [BIN, ...args], {
    timeout: 30_000, env: { ...process.env, GSTACK_HOME: tmpHome }, cwd, encoding: 'utf-8',
  });
  const keys = (out: string) => out.split('\n').map(l => /^- \[([^\]]+)\]/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map(m => m[1]);

  test('an entry matching every query token survives the default limit, for every refinement', () => {
    for (const q of ['preflight', 'preflight project', 'preflight project line']) {
      expect(keys(runIn(rankCwd, ['--query', q]).stdout)).toContain(TARGET);
    }
  });

  test('a 3-of-3 match outranks twelve higher-confidence 1-of-3 matches', () => {
    expect(keys(runIn(rankCwd, ['--query', 'preflight project line']).stdout)[0]).toBe(TARGET);
  });

  test('token hits outrank confidence; confidence then recency break ties', () => {
    expect(keys(runIn(rankCwd, ['--query', 'alpha beta']).stdout)).toEqual(['tiebreak-alpha-beta-high', 'tiebreak-alpha-beta-low', 'tiebreak-alpha-solo']);
    expect(keys(runIn(rankCwd, ['--query', 'gamma delta']).stdout)).toEqual(['recency-gamma-delta-newer', 'recency-gamma-delta-older']);
  });

  test('a truncated query says how many more matched, on stdout with exit 0', () => {
    const r = runIn(rankCwd, ['--query', 'preflight project line']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('LEARNINGS: 10 loaded');
    expect(r.stdout).toContain('3 more matched, raise --limit to see them');
    expect(runIn(rankCwd, ['--query', 'gamma delta']).stdout).not.toContain('more matched');
    expect(runIn(rankCwd, ['--limit', '3']).stdout).not.toContain('more matched');
  });

  test('a stored internal field cannot hijack the no-query ranking', () => {
    const ranked = keys(runIn(rankCwd, ['--limit', '3']).stdout);
    expect(ranked).toHaveLength(3);
    expect(ranked).not.toContain('planted-token-hits');
  });

  for (const poison of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    test(`a row typed "${poison}" cannot blank the whole store`, () => {
      write(badDir, [
        ...[0, 1, 2].map(i => row({ ts: '2026-05-0' + (i + 1) + 'T00:00:00Z', key: 'healthy-' + i, insight: 'alpha only insight ' + i, confidence: 10 })),
        row({ key: 'poison-row', type: poison, insight: 'alpha beta both here', confidence: 1 }),
      ]);
      const got = keys(runIn(badCwd, ['--query', 'alpha beta']).stdout);
      for (const k of ['healthy-0', 'healthy-1', 'healthy-2']) expect(got).toContain(k);
    });
  }
});

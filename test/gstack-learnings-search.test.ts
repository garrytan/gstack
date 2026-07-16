import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

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

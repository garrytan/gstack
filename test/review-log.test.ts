import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { gitIn } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpDir: string;
let slugDir: string;

function run(input: string, opts: { expectFail?: boolean } = {}): { stdout: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 10000,
  };
  try {
    const stdout = execSync(`${BIN}/gstack-review-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim();
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    if (opts.expectFail) {
      return { stdout: e.stderr?.toString() || '', exitCode: e.status || 1 };
    }
    throw e;
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-revlog-'));
  // gstack-review-log uses gstack-slug which needs a git repo — create the projects dir
  // with a predictable slug by pre-creating the directory structure
  slugDir = path.join(tmpDir, 'projects');
  fs.mkdirSync(slugDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('gstack-review-log', () => {
  test('appends valid JSON to review JSONL file', () => {
    const input = '{"skill":"plan-eng-review","status":"clean"}';
    const result = run(input);
    expect(result.exitCode).toBe(0);

    // Find the JSONL file that was written
    const projectDirs = fs.readdirSync(slugDir);
    expect(projectDirs.length).toBeGreaterThan(0);
    const projectDir = path.join(slugDir, projectDirs[0]);
    const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    expect(jsonlFiles.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(projectDir, jsonlFiles[0]), 'utf-8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.skill).toBe('plan-eng-review');
    expect(parsed.status).toBe('clean');
  });

  test('rejects non-JSON input with non-zero exit code', () => {
    const result = run('not json at all', { expectFail: true });
    expect(result.exitCode).not.toBe(0);

    // Verify nothing was written
    const projectDirs = fs.readdirSync(slugDir);
    if (projectDirs.length > 0) {
      const projectDir = path.join(slugDir, projectDirs[0]);
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      if (jsonlFiles.length > 0) {
        const content = fs.readFileSync(path.join(projectDir, jsonlFiles[0]), 'utf-8').trim();
        expect(content).toBe('');
      }
    }
  });

  function readNewestRecord(): any {
    const projectDirs = fs.readdirSync(slugDir);
    const projectDir = path.join(slugDir, projectDirs[0]);
    const jsonlFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    const content = fs.readFileSync(path.join(projectDir, jsonlFiles[0]), 'utf-8').trim();
    const lines = content.split('\n');
    return JSON.parse(lines[lines.length - 1]);
  }

  test('stamps authoritative binding fields (commit_full, tree, wtree, dirty) in a git repo', () => {
    const result = run('{"skill":"review","status":"clean"}');
    expect(result.exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.commit_full).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.wtree).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof rec.dirty).toBe('boolean');
    // Non-binding caller fields pass through untouched.
    expect(rec.skill).toBe('review');
    expect(rec.status).toBe('clean');
  });

  test('caller-supplied binding fields are IGNORED, never trusted', () => {
    const forged = '{"skill":"review","status":"clean","wtree":"forged","tree":"forged","commit_full":"forged","dirty":"forged"}';
    const result = run(forged);
    expect(result.exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.wtree).not.toBe('forged');
    expect(rec.tree).not.toBe('forged');
    expect(rec.commit_full).not.toBe('forged');
    expect(rec.dirty).not.toBe('forged');
    expect(rec.wtree).toMatch(/^[0-9a-f]{40}$/);
  });

  test('append still succeeds outside a git repo (binding fields omitted)', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-nongit-'));
    try {
      const execOpts: ExecSyncOptionsWithStringEncoding = {
        cwd: nonGit,
        env: { ...process.env, GSTACK_HOME: tmpDir },
        encoding: 'utf-8',
        timeout: 10000,
      };
      execSync(`${BIN}/gstack-review-log '{"skill":"review","status":"clean"}'`, execOpts);
      // A record landed somewhere under projects/ without a wtree stamp.
      const found: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('-reviews.jsonl')) found.push(p);
        }
      };
      walk(slugDir);
      expect(found.length).toBeGreaterThan(0);
      const rec = JSON.parse(fs.readFileSync(found[0], 'utf-8').trim().split('\n').pop()!);
      expect(rec.skill).toBe('review');
      expect(rec.wtree).toBeUndefined();
      expect(rec.commit_full).toBeUndefined();
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe('gstack-wtree', () => {
  function withScratchRepo(fn: (repoDir: string, wtree: () => string) => void) {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-wtree-'));
    try {
      const git = (args: string) => gitIn(repoDir, args);
      git('init -q -b main');
      fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello\n');
      fs.writeFileSync(path.join(repoDir, '.gitignore'), 'scratch.txt\n');
      git('add a.txt .gitignore');
      git('commit -q -m init');
      const wtree = () => execSync(`${BIN}/gstack-wtree`, { cwd: repoDir, encoding: 'utf-8', timeout: 10000 }).trim();
      fn(repoDir, wtree);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }

  test('an UNTRACKED source file changes the fingerprint; a gitignored file does not', () => {
    withScratchRepo((repoDir, wtree) => {
      const clean = wtree();
      expect(clean).toMatch(/^[0-9a-f]{40}$/);

      // Gitignored scratch: invisible to the fingerprint (Conductor scratch stays out).
      fs.writeFileSync(path.join(repoDir, 'scratch.txt'), 'noise\n');
      expect(wtree()).toBe(clean);

      // Untracked NEW source file: visible (new files can never be invisible to freshness).
      fs.writeFileSync(path.join(repoDir, 'new-source.ts'), 'export {}\n');
      expect(wtree()).not.toBe(clean);
    });
  });

  test('committing identical content does NOT change the fingerprint', () => {
    withScratchRepo((repoDir, wtree) => {
      fs.writeFileSync(path.join(repoDir, 'a.txt'), 'edited\n');
      const dirtyFingerprint = wtree();
      gitIn(repoDir, 'commit -q -am edit');
      expect(wtree()).toBe(dirtyFingerprint);
    });
  });

  test('exits non-zero outside a git repo', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-wtree-nongit-'));
    try {
      expect(() => execSync(`${BIN}/gstack-wtree`, { cwd: nonGit, timeout: 10000, stdio: 'pipe' })).toThrow();
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe('gstack-review-read', () => {
  test('emits ---WTREE---, ---TREE--- and ---DIRTY--- sections', () => {
    const out = execSync(`${BIN}/gstack-review-read`, {
      cwd: ROOT,
      env: { ...process.env, GSTACK_HOME: tmpDir },
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(out).toContain('---HEAD---');
    expect(out).toContain('---WTREE---');
    expect(out).toContain('---TREE---');
    expect(out).toContain('---DIRTY---');
    const wtreeLine = out.split('---WTREE---')[1].trim().split('\n')[0].trim();
    expect(wtreeLine).toMatch(/^([0-9a-f]{40}|unknown)$/);
    const dirtyLine = out.split('---DIRTY---')[1].trim().split('\n')[0].trim();
    expect(['true', 'false']).toContain(dirtyLine);
  });
});

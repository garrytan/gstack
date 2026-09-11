import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execSync, spawnSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { gitIn } from './helpers/scratch-repo';
import { resolveProjectIdentity } from '../lib/project-identity';
import { createInstalledAuthorityFixture } from './helpers/installed-authority';

const ROOT = path.resolve(import.meta.dir, '..');
let installed: ReturnType<typeof createInstalledAuthorityFixture>;
let BIN: string;

let tmpDir: string;
let slugDir: string;

beforeAll(() => {
  const build = spawnSync(process.execPath, ['run', 'scripts/build-authority-bundles.ts'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 30_000,
  });
  expect(build.status).toBe(0);
  installed = createInstalledAuthorityFixture(ROOT);
  BIN = installed.bin;
});

afterAll(() => installed?.cleanup());

function run(input: string, opts: { expectFail?: boolean } = {}): { stdout: string; exitCode: number } {
  const execOpts: ExecSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    env: { ...process.env, GSTACK_HOME: tmpDir },
    encoding: 'utf-8',
    timeout: 10000,
  };
  try {
    const stdout = execSync(`${BIN}/gstack-review-log '${input.replace(/'/g, "'\\''")}'`, execOpts).trim(); // timeout via execOpts
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
    const identity = resolveProjectIdentity(ROOT);
    expect(rec.repo_id).toBe(identity.repo_id);
    expect(rec.branch_ref).toBe(identity.raw_branch);
    // Non-binding caller fields pass through untouched.
    expect(rec.skill).toBe('review');
    expect(rec.status).toBe('clean');
  });

  test('caller-supplied binding fields are IGNORED, never trusted', () => {
    const forged = '{"skill":"review","status":"clean","wtree":"forged","tree":"forged","commit_full":"forged","dirty":"forged","repo_id":"forged","branch_ref":"forged"}';
    const result = run(forged);
    expect(result.exitCode).toBe(0);
    const rec = readNewestRecord();
    expect(rec.wtree).not.toBe('forged');
    expect(rec.tree).not.toBe('forged');
    expect(rec.commit_full).not.toBe('forged');
    expect(rec.dirty).not.toBe('forged');
    expect(rec.repo_id).not.toBe('forged');
    expect(rec.branch_ref).not.toBe('forged');
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
      execSync(`${BIN}/gstack-review-log '{"skill":"review","status":"clean"}'`, execOpts); // timeout via execOpts
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

  test('--expected-wtree atomically rejects movement and appends nothing', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-revlog-tree-'));
    try {
      gitIn(repoDir, 'init -q -b main');
      fs.writeFileSync(path.join(repoDir, 'a.txt'), 'one\n');
      gitIn(repoDir, 'add a.txt');
      gitIn(repoDir, 'commit -q -m init');
      const expected = execSync(`${BIN}/gstack-wtree`, { timeout: 30_000, cwd: repoDir, encoding: 'utf8' }).trim();
      fs.writeFileSync(path.join(repoDir, 'a.txt'), 'two\n');
      expect(() => execSync(`${BIN}/gstack-review-log --expected-wtree ${expected} '{"skill":"review","status":"clean"}'`, {
        cwd: repoDir, env: { ...process.env, GSTACK_HOME: tmpDir }, stdio: 'pipe',
      })).toThrow();
      const records: string[] = [];
      const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const item = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(item); else if (entry.name.endsWith('-reviews.jsonl')) records.push(item);
        }
      };
      walk(slugDir);
      expect(records).toHaveLength(0);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
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

  test('racy-git window: a same-size rewrite pinned to the index timestamp changes the fingerprint', () => {
    withScratchRepo((repoDir, wtree) => {
      const file = path.join(repoDir, 'a.txt');
      const indexPath = path.join(repoDir, '.git', 'index');
      // ctime can't be restored after a rewrite; production hits this window
      // when everything lands in the same second (ctime SECONDS match).
      // trustctime=false isolates the racy mechanism deterministically
      // instead of racing a second boundary.
      gitIn(repoDir, 'config core.trustctime false');
      // Pin the cached entry's mtime to a fixed timestamp (zero nsec, so the
      // restore below is exact even on USE_NSEC git builds).
      const pinned = new Date('2026-01-01T12:00:00Z');
      fs.utimesSync(file, pinned, pinned);
      gitIn(repoDir, 'add a.txt');
      const clean = wtree();
      // Same-size rewrite restored to the pinned stat, with the index file
      // itself pinned to the SAME timestamp: the entry is stat-identical to
      // its stale cache and sits exactly on git's racy-git boundary.
      // gstack-wtree must carry the real index's mtime onto its temp copy —
      // a fresh-stamped copy marks the entry non-racy, trusts the stale stat
      // cache, and the edit vanishes from the fingerprint (evidence would
      // stay FRESH after a source change).
      fs.writeFileSync(file, 'howdy\n'); // same byte length as 'hello\n'
      fs.utimesSync(file, pinned, pinned);
      fs.utimesSync(indexPath, pinned, pinned);
      expect(wtree()).not.toBe(clean);
    });
  });

  // #2687 hardening: `touch -r ... || true` meant a FAILED touch silently
  // reopened the racy-window hole (the temp index copy keeps its "now" stamp
  // and every entry reads non-racy). A failed touch must fall through to the
  // read-tree HEAD seed, which re-hashes everything.
  test('racy-git window stays closed even when touch fails (stubbed-touch fallback)', () => {
    withScratchRepo((repoDir, _wtree) => {
      const file = path.join(repoDir, 'a.txt');
      const indexPath = path.join(repoDir, '.git', 'index');
      gitIn(repoDir, 'config core.trustctime false');
      const pinned = new Date('2026-01-01T12:00:00Z');
      fs.utimesSync(file, pinned, pinned);
      gitIn(repoDir, 'add a.txt');
      // PATH-stubbed `touch` that always fails.
      const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-touch-stub-'));
      fs.writeFileSync(path.join(stubDir, 'touch'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const wtreeStubbed = () =>
        execSync(`${BIN}/gstack-wtree`, {
          cwd: repoDir,
          encoding: 'utf-8',
          timeout: 10000,
          env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}` },
        }).trim();
      try {
        const clean = wtreeStubbed();
        fs.writeFileSync(file, 'howdy\n'); // same byte length as 'hello\n'
        fs.utimesSync(file, pinned, pinned);
        fs.utimesSync(indexPath, pinned, pinned);
        expect(wtreeStubbed()).not.toBe(clean);
      } finally {
        fs.rmSync(stubDir, { recursive: true, force: true });
      }
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
  test('--json returns one stable union object', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/authority/review-read.ts'), '--json'], { cwd: ROOT, env: { ...process.env, GSTACK_HOME: tmpDir }, encoding: 'utf8' });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'ecpe.review-union.v1', reviews: expect.any(Array) });
  });
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

  test('unions only explicit legacy candidates, deduplicates, and filters conflicting repo ids', () => {
    const fixtureRepo = path.join(tmpDir, 'fixture-repo');
    fs.mkdirSync(path.join(fixtureRepo, 'config'), { recursive: true });
    gitIn(fixtureRepo, 'init -q -b main');
    fs.writeFileSync(path.join(fixtureRepo, 'README.md'), 'fixture\n');
    gitIn(fixtureRepo, 'add README.md');
    gitIn(fixtureRepo, 'commit -qm fixture');
    fs.writeFileSync(path.join(fixtureRepo, 'config/workspace-registry.toml'), `
[registry]
version = 2
[[entry]]
id = "fixture-project"
path = "."
kind = "repository"
remote_required = false
active = true
aliases = ["legacy-project"]
`);
    const identity = resolveProjectIdentity(fixtureRepo);
    const row = { run_id: 'run-1', timestamp: '2026-08-31T00:00:00.000Z', skill: 'review', repo_id: identity.repo_id };
    for (const slug of [identity.write_slug, 'legacy-project']) {
      const target = path.join(tmpDir, 'projects', slug, `${identity.write_branch}-reviews.jsonl`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(row) + '\n');
    }
    fs.appendFileSync(
      path.join(tmpDir, 'projects', 'legacy-project', `${identity.write_branch}-reviews.jsonl`),
      JSON.stringify({ run_id: 'wrong', timestamp: '2026-08-31T00:00:01.000Z', repo_id: 'wrong/repository' }) + '\n',
    );

    const out = execSync(`${BIN}/gstack-review-read`, {
      cwd: fixtureRepo,
      env: { ...process.env, GSTACK_HOME: tmpDir },
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(out.match(/"run_id":"run-1"/g)).toHaveLength(1);
    expect(out).not.toContain('"run_id":"wrong"');
  });
});

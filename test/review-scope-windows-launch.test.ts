/**
 * #3541: `gstack-review-scope summary` reads the review log through
 * gstack-review-read, a bash script. Spawned by path it never starts on
 * Windows (no shebangs), so summary always refused with an empty
 * "gstack-review-read failed:" and /ship could not write its review-loop file.
 *
 * Windows-safe by construction: both bins launch through
 * lib/script-invocation.ts (Git Bash on win32), state lives under os.tmpdir().
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScriptSync } from '../lib/script-invocation';

const ROOT = path.resolve(import.meta.dir, '..');
const SLUG = 'review-scope-launch';

let tmp = '', repo = '', state = '', env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-rs-launch-')));
  repo = path.join(tmp, 'repo');
  state = path.join(tmp, 'state');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(state, 'projects', SLUG), { recursive: true });
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  env = {
    ...process.env, HOME: tmp, USERPROFILE: tmp, GSTACK_STATE_ROOT: state, GSTACK_HOME: state, GSTACK_PROJECT_SLUG: SLUG,
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
  };
  git('init', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('-c', 'user.email=fixture@example.test', '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('summary reads the review log through gstack-review-read (#3541)', () => {
  const rows = [
    { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:00:00Z', review_scope: 'frozen', findings: [{ fingerprint: 'a:1:x', blocking: true, action: 'fixed' }] },
    { skill: 'review', via: 'ship', timestamp: '2026-10-26T10:30:00Z', review_scope: 'frozen', findings: [] },
  ];
  fs.writeFileSync(path.join(state, 'projects', SLUG, 'feat-reviews.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const out = path.join(tmp, 'review-loop.json');
  const r = runScriptSync(path.join(ROOT, 'bin', 'gstack-review-scope'), ['summary', '--since', '2026-10-26T09:00:00Z', '--out', out, '--json'], {
    cwd: repo, env, encoding: 'utf8', timeout: 120_000,
  });
  expect(r.error).toBeUndefined();
  expect(r.status, r.stderr).toBe(0);
  const summary = JSON.parse(fs.readFileSync(out, 'utf8'));
  expect(summary).toMatchObject({ passes: 2, blocking_found: 1, fixed: 1, scope: 'frozen' });
}, 150_000);

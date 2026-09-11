import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';

const ROOT = path.join(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin', 'gstack-pr-title-rewrite');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { timeout: 30_000,
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository(titlePolicy?: 'version_prefix' | 'conventional' | 'free',releaseMode:'per_pr'|'required_on_release'='per_pr') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-title-policy-'));
  fs.writeFileSync(path.join(root, 'VERSION'), '1.2.3\n');
  if (titlePolicy) {
    fs.mkdirSync(path.join(root, '.gstack'));
    let profile = fs.readFileSync(path.join(ROOT, 'test/fixtures/work-profile/valid.yaml'), 'utf8');
    const release = titlePolicy === 'version_prefix'
      ? `release:\n  mode: ${releaseMode}\n  title_policy: version_prefix\n  version_source: { path: VERSION, format: plain_text, selector: whole_file }\n  version_targets:\n    - { path: VERSION, format: plain_text, selector: whole_file, value_encoding: exact }`
      : `release:\n  mode: none\n  title_policy: ${titlePolicy}`;
    profile = profile.replace('release:\n  mode: none\n  title_policy: free', release);
    if (titlePolicy === 'version_prefix') {
      profile = profile.replace('metadata_projections: []', 'metadata_projections:\n  - { path: VERSION, format: plain_text, selector: whole_file }');
    }
    fs.writeFileSync(path.join(root, '.gstack/work-profile.yaml'), profile);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(root, 'checkout', '-qb', 'feature');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function run(args: string[], cwd = ROOT, environment: Record<string, string> = {}): { stdout: string; status: number; stderr: string } {
  const r = spawnSync(HELPER, args, { cwd, encoding: 'utf-8', env: { ...process.env, ...environment }, timeout: 30_000 });
  const stdout = r.stdout ?? '';
  return { stdout: stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout, status: r.status ?? -1, stderr: r.stderr ?? '' };
}

function rewrite(version: string, title: string): { stdout: string; status: number; stderr: string } {
  const fixture = repository();
  try { return run([version, title], fixture.root); }
  finally { fixture.cleanup(); }
}

describe('gstack-pr-title-rewrite', () => {
  test('already correct: no change', () => {
    const r = rewrite('1.2.3.4', 'v1.2.3.4 feat: foo');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('v1.2.3.4 feat: foo');
  });

  test('preserves the exact current prefix for one-part versions and trailing spaces', () => {
    expect(rewrite('1', 'v1 feat: foo').stdout).toBe('v1 feat: foo');
    expect(rewrite('1.2.3', 'v1.2.3 ').stdout).toBe('v1.2.3 ');
  });

  test('different version prefix: replaces it', () => {
    expect(rewrite('1.2.3.5', 'v1.2.3.4 feat: foo').stdout).toBe('v1.2.3.5 feat: foo');
  });

  test('different prefix length (3-part vs 4-part): replaces it', () => {
    expect(rewrite('1.2.3.4', 'v1.2.3 feat: foo').stdout).toBe('v1.2.3.4 feat: foo');
  });

  test('bare correct version (no description): no change, not duplicated', () => {
    // CHANGELOG/ship uses a version-only title for branch-ahead bumps. It must
    // stay as-is, not become "v1.2.3.4 v1.2.3.4".
    expect(rewrite('1.2.3.4', 'v1.2.3.4').stdout).toBe('v1.2.3.4');
  });

  test('bare different version (no description): replaces, not duplicates', () => {
    // Must strip the stale prefix even with nothing after it, otherwise CI
    // writes back "v1.2.3.4 v1.2.3".
    expect(rewrite('1.2.3.4', 'v1.2.3').stdout).toBe('v1.2.3.4');
  });

  test('idempotent on a bare version title', () => {
    const once = rewrite('1.2.3.4', 'v1.2.3').stdout;
    expect(rewrite('1.2.3.4', once).stdout).toBe(once);
  });

  test('no version prefix: prepends', () => {
    expect(rewrite('1.2.3.4', 'feat: foo').stdout).toBe('v1.2.3.4 feat: foo');
  });

  test('does not mistake plain words for a prefix', () => {
    expect(rewrite('1.2.3.4', 'version 5 feature').stdout).toBe('v1.2.3.4 version 5 feature');
  });

  test('does not strip a single-segment prefix like v1', () => {
    expect(rewrite('1.2.3.4', 'v1 feat: foo').stdout).toBe('v1.2.3.4 v1 feat: foo');
  });

  test('errors on missing args', () => {
    const r = spawnSync(HELPER, ['1.2.3.4'], { encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).not.toBe(0);
  });

  test('rejects malformed VERSION with shell metacharacters', () => {
    expect(rewrite('1.*.*.*', 'feat: foo').status).toBe(2);
    expect(rewrite('1.2.3.4; rm -rf /', 'feat: foo').status).toBe(2);
  });

  test('idempotent: applying twice yields the same result', () => {
    const once = rewrite('1.2.3.4', 'feat: foo').stdout;
    const twice = rewrite('1.2.3.4', once).stdout;
    expect(twice).toBe(once);
  });

  test('trusted version-prefix mode resolves policy and checks the rendered version', () => {
    const fixture = repository('version_prefix');
    try {
      const result = run(['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--assert-title-policy', 'version_prefix', '--version', '1.2.3', '--title', 'feat: foo'], fixture.root);
      expect(result).toEqual({ status: 0, stdout: 'v1.2.3 feat: foo', stderr: '' });
      const mismatch = run(['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--version', '9.9.9', '--title', 'feat: foo'], fixture.root);
      expect(mismatch.status).toBe(2);
      expect(mismatch.stderr).toContain('release_title_version_mismatch');
    } finally { fixture.cleanup(); }
  });

  test('inactive required-on-release version-prefix policy uses the candidate title without a version',()=>{
    const fixture=repository('version_prefix','required_on_release');
    try{
      expect(run(['--lane','single_repo_code','--assert-target-ref','origin/main','--assert-title-policy','version_prefix','--title','feat: no release'],fixture.root)).toEqual({status:0,stdout:'feat: no release',stderr:''});
      const invalid=run(['--lane','single_repo_code','--assert-target-ref','origin/main','--assert-title-policy','version_prefix','--version','1.2.3','--title','feat: no release'],fixture.root);
      expect(invalid.stderr).toContain('release_title_version_not_applicable');
    }finally{fixture.cleanup()}
  });

  test('title-policy mismatch fails before a missing current version is read', () => {
    const fixture = repository('version_prefix');
    try {
      fs.rmSync(path.join(fixture.root, 'VERSION'));
      const result = run(['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--assert-title-policy', 'free', '--title', 'anything'], fixture.root);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('release_title_policy_assertion_mismatch');
      expect(result.stderr).not.toContain('release_version_source_unreadable');
    } finally { fixture.cleanup(); }
  });

  test('trusted conventional mode strips a stale version prefix and validates form', () => {
    const fixture = repository('conventional');
    try {
      expect(run(['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--title', 'v1.2.2 feat(parser)!: keep bytes'], fixture.root).stdout).toBe('feat(parser)!: keep bytes');
      const invalid = run(['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--title', 'plain title'], fixture.root);
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain('release_title_conventional_invalid');
    } finally { fixture.cleanup(); }
  });

  test('trusted free mode returns the title byte-for-byte and works from a subdirectory', () => {
    const fixture = repository('free');
    const subdirectory = path.join(fixture.root, 'nested');
    fs.mkdirSync(subdirectory);
    try {
      const title = '  Custom title 그대로  ';
      expect(run(['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--assert-title-policy', 'free', '--title', title], subdirectory)).toEqual({ status: 0, stdout: title, stderr: '' });
    } finally { fixture.cleanup(); }
  });

  test('legacy positional form cannot bypass a trusted profile', () => {
    const fixture = repository('free');
    try {
      const result = run(['1.2.3', 'feat: foo'], fixture.root);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('release_legacy_title_input_forbidden');
    } finally { fixture.cleanup(); }
  });

  test('ambient Git repository selectors cannot redirect trusted policy discovery', () => {
    const governed = repository('free');
    const attacker = repository();
    try {
      const result = run(['1.2.3', 'feat: foo'], governed.root, {
        GIT_DIR: path.join(attacker.root, '.git'),
        GIT_WORK_TREE: attacker.root,
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('release_legacy_title_input_forbidden');
    } finally {
      governed.cleanup();
      attacker.cleanup();
    }
  });

  test('legacy positional form requires proven trusted-profile absence', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-title-outside-git-'));
    try {
      const result = run(['1.2.3', 'feat: foo'], outside);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('trusted_policy_resolution_required');
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  test('strict frontend rejects caller-selected policy and unknown arguments', () => {
    const fixture = repository('free');
    try {
      for (const args of [
        ['--title-policy', 'free', '--title', 'hello'],
        ['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--title', 'hello', '--workspace-root', fixture.root],
      ]) {
        const result = run(args, fixture.root);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain('release_title_argument_forbidden');
      }
    } finally { fixture.cleanup(); }
  });

  test('strict frontend requires one valid execution-plan lane',()=>{
    const fixture=repository('free');
    try{
      for(const args of [
        ['--assert-target-ref','origin/main','--title','hello'],
        ['--lane','unknown','--assert-target-ref','origin/main','--title','hello'],
        ['--lane','docs_ux','--lane','single_repo_code','--assert-target-ref','origin/main','--title','hello'],
      ])expect(run(args,fixture.root).status).toBe(2);
    }finally{fixture.cleanup()}
  });

  test('strict frontend rejects option-shaped title values instead of consuming another flag', () => {
    const fixture = repository('free');
    try {
      for (const args of [
        ['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--title', '--title'],
        ['--lane','single_repo_code','--assert-target-ref', 'origin/main', '--title', '--release-requested'],
      ]) {
        const result = run(args, fixture.root);
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('release_title_argument_value_missing');
      }
    } finally { fixture.cleanup(); }
  });

  test('authority frontend is executable', () => {
    expect(fs.statSync(HELPER).mode & 0o111).not.toBe(0);
  });
});

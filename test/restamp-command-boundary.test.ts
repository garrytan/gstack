/**
 * C1/C2 trust boundary: a policy file never authorizes execution. Pins the
 * refusal (exit 3, REPO_COMMANDS_NOT_ALLOWED, `nothing written`, commands
 * listed), the unreviewed bootstrap path, the release-tool contract (allowed
 * outputs, failure), and that every refusal leaves the tree and the journal
 * untouched.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { BASE_POLICY, cleanup, makeFixtureRepo, makePr, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = (opts?: Parameters<typeof makeFixtureRepo>[0]) => { const r = makeFixtureRepo(opts); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const treeOf = (repo: FixtureRepo) => repo.git('status', '--porcelain') + '|' + repo.git('rev-parse', 'HEAD');
const journal = (repo: FixtureRepo) => path.join(repo.work, '.gstack', 'tmp', 'restamp-journal.json');

describe('repo commands run only with --allow-repo-commands', () => {
  test('standalone: the declared commands are listed, exit 3, nothing written (no file, no journal, no worktree)', () => {
    const repo = fixture();
    makePr(repo, 'feat-a');
    const before = treeOf(repo);
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/repo commands not executed \(pass --allow-repo-commands\).*nothing written.*\(REPO_COMMANDS_NOT_ALLOWED\)/);
    expect(r.out).toContain('COMMAND: release_tool="node gen.js" cwd=.');
    expect(r.out).toMatch(/GSTACK_RESULT: skill=restamp status=refused run=/);
    expect(treeOf(repo)).toBe(before);
    expect(fs.existsSync(journal(repo))).toBe(false);
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
    const json = JSON.parse(runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--json']).out);
    expect(json).toMatchObject({ status: 'refused', code: 'REPO_COMMANDS_NOT_ALLOWED', result: 'refused' });
    expect(json.commands).toEqual([{ key: 'release_tool', command: 'node gen.js', cwd: '.' }]);
  });

  test('a policy without commands needs no flag; --dry-run still writes nothing', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: null, release_outputs: [] } });
    makePr(repo, 'feat-a');
    const before = treeOf(repo);
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--dry-run']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('STAMP_VERSION: 1.2.4.0');
    expect(r.out).toContain('stage release_tool: skipped (no release_tool in policy)');
    expect(r.out).toMatch(/^\+1\.2\.4\.0$/m);
    expect(treeOf(repo)).toBe(before);
    expect(fs.existsSync(journal(repo))).toBe(false);
  });

  test('--policy-from head is the unreviewed bootstrap path: refused without the flag, labeled head (unreviewed) with it', () => {
    const repo = fixture({ policy: null });
    makePr(repo, 'feat-a');
    fs.writeFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), JSON.stringify({ ...BASE_POLICY, release_tool: null }) + '\n');
    const refused = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--policy-from', 'head']);
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.err).toMatch(/--policy-from head.*needs --allow-repo-commands.*nothing written.*\(REPO_COMMANDS_NOT_ALLOWED\)/);
    const base = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--dry-run']);
    expect(base.out).toContain('policy=none (defaults;');
    expect(base.out).toContain('queue_mode=claim-at-open');
    const head = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--policy-from', 'head', '--allow-repo-commands', '--dry-run']);
    expect(head.status).toBe(EXIT.ok);
    expect(head.out).toContain('policy=head (unreviewed)');
    expect(head.out).toContain('queue_mode=stamp-at-merge');
  });

  test('a PR cannot smuggle a command: the committed base copy wins over the branch copy', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: null } });
    makePr(repo, 'feat-a');
    fs.writeFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), JSON.stringify({ ...BASE_POLICY, release_tool: 'touch PWNED' }) + '\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'smuggle');
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands', '--dry-run']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('stage release_tool: skipped (no release_tool in policy)');
    expect(fs.existsSync(path.join(repo.work, 'PWNED'))).toBe(false);
  });

  test('POLICY_SOURCE_UNAVAILABLE (exit 3) when origin/<base> is unresolvable; the working-tree policy is not consulted', () => {
    const repo = fixture();
    makePr(repo, 'feat-a');
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'develop', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/policy source unavailable.*nothing written.*fix: git fetch origin develop --depth=1 \(POLICY_SOURCE_UNAVAILABLE\)/);
    expect(fs.existsSync(journal(repo))).toBe(false);
  });
});

describe('release-tool contract', () => {
  test('an output outside the allowed set refuses before any write (RESTAMP_OUTPUT_OUTSIDE_ALLOWED)', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: 'node gen.js && echo x > stray.txt', release_outputs: ['generated/**'] } });
    makePr(repo, 'feat-a');
    const before = treeOf(repo);
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/release_tool wrote outside the allowed set: stray\.txt.*nothing written.*\(RESTAMP_OUTPUT_OUTSIDE_ALLOWED\)/);
    expect(treeOf(repo)).toBe(before);
    expect(fs.existsSync(path.join(repo.work, 'stray.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(repo.work, 'VERSION'), 'utf8')).toBe('1.2.3.0\n');
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('a path declared in release_outputs is allowed; the same path undeclared is not', () => {
    const declared = fixture({ policy: { ...BASE_POLICY, release_tool: 'node gen.js && echo x > generated/extra.txt' } });
    makePr(declared, 'feat-a');
    expect(runBin(declared, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands']).status).toBe(EXIT.ok);
    expect(fs.existsSync(path.join(declared.work, 'generated', 'extra.txt'))).toBe(true);
    const undeclared = fixture({ policy: { ...BASE_POLICY, release_outputs: [] } });
    makePr(undeclared, 'feat-a');
    const r = runBin(undeclared, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/generated\/digest\.md.*\(RESTAMP_OUTPUT_OUTSIDE_ALLOWED\)/);
  });

  test('a failing release tool is RESTAMP_RELEASE_TOOL_FAILED with nothing written to the branch', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: 'node -e "process.exit(7)"' } });
    makePr(repo, 'feat-a');
    const before = treeOf(repo);
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/release_tool exited 7.*nothing written to the branch.*\(RESTAMP_RELEASE_TOOL_FAILED\)/);
    expect(treeOf(repo)).toBe(before);
  });

  test('the staging worktree is isolated: the release tool cannot see the branch checkout and runs in the staged content', () => {
    const repo = fixture({ policy: { ...BASE_POLICY, release_tool: 'node -e "require(\'fs\').writeFileSync(\'generated/cwd.txt\', process.cwd())"' } });
    makePr(repo, 'feat-a');
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.ok);
    const cwd = fs.readFileSync(path.join(repo.work, 'generated', 'cwd.txt'), 'utf8');
    expect(cwd).not.toBe(repo.work);
    expect(cwd).toContain('gstack-restamp-staging-');
    expect(fs.existsSync(cwd)).toBe(false);
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
  });
});

describe('restamp_command (field wave CD3): the repo owns the stamp inside the staging worktree', () => {
  const RESTAMP_JS = [
    "const fs = require('fs'); const { execSync } = require('child_process');",
    "if (execSync('git status --porcelain', { encoding: 'utf8', timeout: 30000 }).trim()) { console.error('FAIL: the working tree is not clean'); process.exit(1); }",
    "const v = process.argv[2];",
    "if (!v || v !== process.env.GSTACK_RESTAMP_VERSION) { console.error('version argument and GSTACK_RESTAMP_VERSION disagree'); process.exit(2); }",
    "if (process.env.FIXTURE_FAIL) process.exit(7);",
    "fs.writeFileSync('VERSION', (process.env.FIXTURE_WRONG_VERSION ? '9.9.9.9' : v) + '\\n');",
    "const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); pkg.version = v.split('.').slice(0, 3).join('.'); fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');",
    "fs.writeFileSync('generated/digest.md', '# digest v' + v + '\\nbody\\n');",
    "if (process.env.FIXTURE_SAVE) { const prev = Number(execSync('git show ' + process.env.GSTACK_RESTAMP_BASE_SHA + ':generated/save.txt', { encoding: 'utf8', timeout: 30000 })); fs.writeFileSync('generated/save.txt', String(prev + 1) + '\\n'); }",
    "if (process.env.FIXTURE_STRAY) fs.writeFileSync('stray.txt', 'x\\n');",
    "execSync('git add -A', { timeout: 30000 }); execSync('git -c user.name=r -c user.email=r@example.com -c commit.gpgsign=false commit -q -m restamp', { timeout: 30000 });",
  ].join('\n') + '\n';
  const POLICY = { ...BASE_POLICY, release_tool: null, restamp_command: 'node restamp.js' };

  function delegated(): FixtureRepo {
    const repo = fixture({ policy: POLICY });
    fs.writeFileSync(path.join(repo.work, 'restamp.js'), RESTAMP_JS);
    repo.git('add', 'restamp.js'); repo.git('commit', '-q', '-m', 'repo restamp tool'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'feat-a');
    return repo;
  }

  test('it runs first, on a clean checkout of HEAD, with the allocated version as argument and GSTACK_RESTAMP_VERSION; gstack\'s version writer is skipped', () => {
    const repo = delegated();
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('STAMP_VERSION: 1.2.4.0');
    expect(r.out).toContain('stage restamp_command: done (node restamp.js 1.2.4.0)');
    expect(r.out).toContain('stage version: skipped (restamp_command owns the version)');
    expect(r.out.indexOf('stage restamp_command:')).toBeLessThan(r.out.indexOf('stage version:'));
    expect(fs.readFileSync(path.join(repo.work, 'VERSION'), 'utf8')).toBe('1.2.4.0\n');
    expect(fs.readFileSync(path.join(repo.work, 'generated', 'digest.md'), 'utf8')).toBe('# digest v1.2.4.0\nbody\n');
    expect(repo.git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('a failure, a wrong version, an output outside the allowed set or a dirty caller tree writes nothing to the branch', () => {
    const cases: Array<[Record<string, string>, RegExp, number]> = [
      [{ FIXTURE_FAIL: '1' }, /restamp_command exited 7.*nothing written to the branch.*\(RESTAMP_RELEASE_TOOL_FAILED\)/, EXIT.refused],
      [{ FIXTURE_WRONG_VERSION: '1' }, /restamp_command left VERSION at 9\.9\.9\.9, expected 1\.2\.4\.0.*nothing written.*\(RESTAMP_VERSION_SOURCE\)/, EXIT.refused],
      [{ FIXTURE_STRAY: '1' }, /restamp_command wrote outside the allowed set: stray\.txt.*\(RESTAMP_OUTPUT_OUTSIDE_ALLOWED\)/, EXIT.refused],
    ];
    for (const [env, err, status] of cases) {
      const repo = delegated();
      const before = treeOf(repo);
      const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands'], env);
      expect(r.status).toBe(status);
      expect(r.err).toMatch(err);
      expect(treeOf(repo)).toBe(before);
      expect(fs.readFileSync(path.join(repo.work, 'VERSION'), 'utf8')).toBe('1.2.3.0\n');
    }
    const dirty = delegated();
    fs.writeFileSync(path.join(dirty.work, 'notes.txt'), 'uncommitted\n');
    const before = treeOf(dirty);
    const d = runBin(dirty, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands']);
    expect(d.status).toBe(EXIT.fail);
    expect(d.err).toMatch(/restamp_command needs a clean HEAD, index and worktree.*notes\.txt.*nothing written.*\(RESTAMP_CONFLICT\)/);
    expect(treeOf(dirty)).toBe(before);
    expect(fs.existsSync(journal(dirty))).toBe(false);
  });

  test('it gets the release predecessor in GSTACK_RESTAMP_BASE_SHA, so a repo counter (a SAVE_VERSION) computes predecessor + 1', () => {
    const repo = fixture({ policy: POLICY });
    fs.writeFileSync(path.join(repo.work, 'restamp.js'), RESTAMP_JS);
    fs.writeFileSync(path.join(repo.work, 'generated', 'save.txt'), '41\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'repo restamp tool and counter'); repo.git('push', '-q', 'origin', 'main');
    makePr(repo, 'feat-save');
    fs.writeFileSync(path.join(repo.work, 'generated', 'save.txt'), '99\n');
    repo.git('commit', '-q', '-am', 'a branch-side counter edit the hook must not read');
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main', '--allow-repo-commands'], { FIXTURE_SAVE: '1' });
    expect(r.status).toBe(EXIT.ok);
    expect(fs.readFileSync(path.join(repo.work, 'generated', 'save.txt'), 'utf8')).toBe('42\n');
  });

  test('without --allow-repo-commands it is listed and refused like release_tool', () => {
    const repo = delegated();
    const r = runBin(repo, 'gstack-restamp', ['--next', '--base', 'main']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.out).toContain('COMMAND: restamp_command="node restamp.js" cwd=.');
  });
});

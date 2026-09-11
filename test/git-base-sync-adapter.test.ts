import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as adapters from '../lib/closed-effect-adapters';
import { runtimeAttestation } from './helpers/installed-authority';

let base: string, root: string, seed: string;
let prior: NodeJS.ProcessEnv;
const authorizations = ['ECPE_BASE_SYNC_AUTHORIZED', 'ECPE_TRACKED_WRITE_AUTHORIZED', 'ECPE_GIT_STAGE_AUTHORIZED', 'ECPE_GIT_COMMIT_AUTHORIZED'];
function gitAt(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, timeout: 30_000,
    env: { PATH: process.env.PATH!, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const git = (...args: string[]) => gitAt(root, ...args);
function commit(cwd: string, name: string, body: string) {
  fs.writeFileSync(path.join(cwd, name), body); gitAt(cwd, 'add', name); gitAt(cwd, 'commit', '-qm', name);
}
function remoteAdvance(name = 'base.txt', body = 'new base\n') {
  commit(seed, name, body); gitAt(seed, 'push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
  // The fixture used a real bare remote for object transfer. The closed adapter
  // consumes that fetched snapshot without performing provider/network writes.
  git('remote', 'set-url', 'origin', 'https://github.com/fixture/base-sync.git');
}
const inspect = () => adapters.inspectGitBaseSync(root, { skill: 'ship', lane: 'single_repo_code', assertTargetRef: 'origin/main' });
const apply = (plan: any, overrides: Record<string, string> = {}) => adapters.executeGitBaseSync(root, {
  skill: 'ship', lane: 'single_repo_code', assertTargetRef: plan.target_ref,
  expectedHead: plan.head_oid, expectedBase: plan.base_oid, assertIndexPreimage: plan.index_sha256,
  assertRepository: plan.repository, ...overrides,
});
function snapshot() {
  return { head: git('rev-parse', 'HEAD'), index: fs.readFileSync(path.join(root, '.git/index')).toString('base64'),
    status: git('status', '--porcelain=v1', '--untracked-files=all'),
    files: Object.fromEntries(fs.readdirSync(root).filter(name => name !== '.git').map(name => [name, fs.readFileSync(path.join(root, name)).toString('base64')])) };
}
beforeEach(() => {
  prior = { ...process.env }; base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-base-sync-'));
  seed = path.join(base, 'seed'); root = path.join(base, 'feature'); const remote = path.join(base, 'remote.git');
  fs.mkdirSync(seed); gitAt(base, 'init', '--bare', '-q', remote); gitAt(seed, 'init', '-q', '-b', 'main');
  gitAt(seed, 'config', 'user.name', 'Fixture'); gitAt(seed, 'config', 'user.email', 'fixture@example.invalid');
  commit(seed, 'shared.txt', 'original\n'); gitAt(seed, 'remote', 'add', 'origin', remote); gitAt(seed, 'push', '-qu', 'origin', 'main');
  gitAt(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'); gitAt(base, 'clone', '-q', remote, root);
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('switch', '-qc', 'feature');
  const manifest = path.join(base, 'runtime.json'); const executable = fs.realpathSync(Bun.which('git')!);
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'ecpe.gstack-runtime.v1', tools: { git: { ...runtimeAttestation(executable), version: git('--version') } } }));
  process.env.ECPE_TESTING = '1'; process.env.ECPE_TEST_RUNTIME_MANIFEST = manifest;
  process.env.HOME = path.join(base, 'default-account'); fs.mkdirSync(process.env.HOME);
  delete process.env.XDG_CONFIG_HOME;
  for (const name of authorizations) process.env[name] = '1';
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
  Object.assign(process.env, prior); fs.rmSync(base, { recursive: true, force: true });
});

describe('closed exact trusted-base synchronization', () => {
  test('synchronizes a clean branch behind the fetched base and proves the result', async () => {
    remoteAdvance(); const plan = await inspect(); const result = await apply(plan);
    expect(result).toMatchObject({ status: 'synchronized', operation: 'ship.base_sync', head_oid: plan.base_oid, base_oid: plan.base_oid,
      postcondition: { base_contained: true, index_matches_head: true, worktree_clean: true } });
    expect(git('rev-parse', 'HEAD')).toBe(plan.base_oid); expect(git('status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(root, 'base.txt'), 'utf8')).toBe('new base\n');
  });
  test('merges clean divergent work and proves both exact parents and the predicted tree', async () => {
    commit(root, 'feature.txt', 'feature\n'); remoteAdvance(); const plan = await inspect();
    const result = await apply(plan);
    expect(result.status).toBe('synchronized'); expect(git('show', '-s', '--format=%P', 'HEAD')).toBe(`${plan.head_oid} ${plan.base_oid}`);
    expect(git('rev-parse', 'HEAD^{tree}')).toBe(result.tree_oid);
    expect(fs.readFileSync(path.join(root, 'feature.txt'), 'utf8')).toBe('feature\n');
  });
  test('merges divergent work with only global identity through the isolated Git account environment', async () => {
    commit(root, 'feature.txt', 'feature\n'); remoteAdvance();
    git('config', '--unset', 'user.name'); git('config', '--unset', 'user.email');
    const accountHome = path.join(base, 'account'); fs.mkdirSync(accountHome);
    fs.writeFileSync(path.join(accountHome, '.gitconfig'), '[user]\n name = Global Account\n email = global@example.invalid\n[commit]\n gpgSign = true\n[merge]\n gpgSign = true\n');
    const executable = fs.realpathSync(Bun.which('git')!);
    const wrapper = path.join(base, 'git-observer'); const log = path.join(base, 'git-env.jsonl');
    const version = git('--version');
    fs.writeFileSync(wrapper, `#!${process.execPath}\n` + `
import * as fs from 'node:fs';
const args = process.argv.slice(2);
if (!args.includes('--version')) {
  const keys = ['HOME', 'SSH_AUTH_SOCK', 'GNUPGHOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_NO_REPLACE_OBJECTS',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_TRACE', 'GH_TOKEN', 'OPENAI_API_KEY'];
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) }) + '\\n');
}
const child = Bun.spawnSync([${JSON.stringify(executable)}, ...args], { cwd: process.cwd(), env: process.env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exit(child.exitCode);
`, { mode: 0o700 });
    fs.writeFileSync(process.env.ECPE_TEST_RUNTIME_MANIFEST!, JSON.stringify({ schema: 'ecpe.gstack-runtime.v1',
      tools: { git: { ...runtimeAttestation(wrapper), version } } }));
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[key];
    Object.assign(process.env, { HOME: accountHome, SSH_AUTH_SOCK: '/fixture/agent', GNUPGHOME: '/fixture/gnupg',
      GIT_CONFIG_GLOBAL: '/wrong/config', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Ambient User',
      GIT_CONFIG_PARAMETERS: "'user.name=Ambient User'", GIT_DIR: '/wrong/repo', GIT_NO_REPLACE_OBJECTS: '0', GIT_TRACE: '1',
      GH_TOKEN: 'fixture-unrelated-provider-token', OPENAI_API_KEY: 'fixture-unrelated-secret' });
    const plan = await inspect(); const result = await apply(plan);
    expect(result.status).toBe('synchronized');
    expect(git('show', '-s', '--format=%an <%ae>|%cn <%ce>', 'HEAD')).toBe('Global Account <global@example.invalid>|Global Account <global@example.invalid>');
    expect(git('show', '-s', '--format=%P', 'HEAD')).toBe(`${plan.head_oid} ${plan.base_oid}`);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some(call => call.args.includes('merge'))).toBe(true);
    for (const call of calls) {
      expect(call.env).toEqual({ HOME: accountHome, SSH_AUTH_SOCK: '/fixture/agent', GNUPGHOME: '/fixture/gnupg', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' });
      for (const setting of [`core.hooksPath=${os.devNull}`, 'core.fsmonitor=false', 'commit.gpgSign=false', 'merge.gpgSign=false']) {
        expect(call.args).toContain(setting);
      }
    }
  }, 20_000);
  test('already-contained inspection and execution perform no writes', async () => {
    remoteAdvance(); git('merge', '--ff-only', 'origin/main'); const before = snapshot(); const plan = await inspect();
    expect(plan.status).toBe('already_contained'); expect((await apply(plan)).status).toBe('already_contained'); expect(snapshot()).toEqual(before);
  });
  test('rejects conflicts before changing HEAD, index, or worktree', async () => {
    commit(root, 'shared.txt', 'feature edit\n'); remoteAdvance('shared.txt', 'base edit\n');
    const plan = await inspect(); const before = snapshot();
    await expect(apply(plan)).rejects.toThrow('git_base_sync_conflict'); expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(root, '.git/MERGE_HEAD'))).toBe(false);
  });
  test.each(['dirty', 'staged', 'untracked'])('rejects %s state without disturbing it', async kind => {
    remoteAdvance(); const plan = await inspect();
    fs.writeFileSync(path.join(root, kind === 'untracked' ? 'untracked.txt' : 'shared.txt'), 'user work\n');
    if (kind === 'staged') git('add', 'shared.txt');
    const before = snapshot(); await expect(apply(plan)).rejects.toThrow(); expect(snapshot()).toEqual(before);
  });
  test.each(['expectedHead', 'expectedBase', 'assertIndexPreimage', 'assertTargetRef', 'assertRepository'])('rejects wrong %s assertion', async key => {
    remoteAdvance(); const plan = await inspect(); const before = snapshot();
    const value = key === 'assertTargetRef' ? 'origin/other' : key === 'assertRepository' ? 'github.com/other/repo' : 'f'.repeat(key === 'assertIndexPreimage' ? 64 : 40);
    await expect(apply(plan, { [key]: value })).rejects.toThrow(); expect(snapshot()).toEqual(before);
  });
  test.each(authorizations)('requires separate %s authorization', async name => {
    remoteAdvance(); const plan = await inspect(); delete process.env[name]; const before = snapshot();
    await expect(apply(plan)).rejects.toThrow('grant_required'); expect(snapshot()).toEqual(before);
  });
  test('rejects merge and filter drivers before preflight', async () => {
    remoteAdvance(); const plan = await inspect(); git('config', 'merge.custom.driver', 'false');
    const before = snapshot(); await expect(apply(plan)).rejects.toThrow('git_base_sync_driver_unsupported'); expect(snapshot()).toEqual(before);
  });
  test.each(['filter.fixture.clean', 'merge.fixture.driver', 'branch.feature.mergeoptions', 'include.path'])('rejects effective global %s before mutation', async key => {
    remoteAdvance(); const plan = await inspect(); const before = snapshot();
    const accountHome = path.join(base, 'global-config'); fs.mkdirSync(accountHome);
    gitAt(base, 'config', '--file', path.join(accountHome, '.gitconfig'), key,
      key === 'include.path' ? path.join(base, 'unused-config') : key === 'branch.feature.mergeoptions' ? '--no-commit' : 'false');
    process.env.HOME = accountHome;
    await expect(apply(plan)).rejects.toThrow('git_base_sync_driver_unsupported');
    expect(snapshot()).toEqual(before);
  });
  test('rejects candidate attributes before changing any files', async () => {
    remoteAdvance('.gitattributes', '*.txt merge=union\n');
    const before = snapshot(); await expect(inspect()).rejects.toThrow('git_base_sync_driver_unsupported'); expect(snapshot()).toEqual(before);
  });
  test('rejects a changed clean index even when the head and base are still exact', async () => {
    remoteAdvance(); const plan = await inspect(); git('update-index', '--index-version', '4');
    const before = snapshot(); await expect(apply(plan)).rejects.toThrow('git_base_sync_assertion_mismatch'); expect(snapshot()).toEqual(before);
  });
  test('generic staging cannot masquerade as ship.base_sync', async () => {
    process.env.ECPE_GIT_WRITE_AUTHORIZED = '1'; commit(root, 'feature.txt', 'feature\n');
    await expect(adapters.executeGitStageCommit(root, { skill: 'ship', operation: 'ship.base_sync', paths: ['shared.txt'] })).rejects.toThrow('git_base_sync_adapter_required');
  });
  test('CLI exposes inspect/apply and rejects arbitrary remote or duplicate assertions', async () => {
    remoteAdvance(); const cli = path.join(import.meta.dir, '../scripts/authority/effect-scope.ts');
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, cli, 'git-base-sync', ...args], { cwd: root, env: process.env, timeout: 30_000 });
    const common = ['--skill', 'ship', '--lane', 'single_repo_code', '--assert-target-ref', 'origin/main', '--json'];
    const inspected = run('inspect', ...common); expect(inspected.exitCode, inspected.stderr.toString()).toBe(0);
    const plan = JSON.parse(inspected.stdout.toString()).result;
    for (const extra of [['--remote', 'other'], ['--expected-head', plan.head_oid, '--expected-head', plan.head_oid]]) {
      const rejected = run('apply', ...common, ...extra); expect(rejected.exitCode).toBe(2);
    }
    const synced = run('apply', ...common, '--expected-head', plan.head_oid, '--expected-base', plan.base_oid,
      '--assert-index-preimage', plan.index_sha256, '--assert-repository', plan.repository);
    expect(synced.exitCode, synced.stderr.toString()).toBe(0); expect(JSON.parse(synced.stdout.toString()).result.status).toBe('synchronized');
  });
});

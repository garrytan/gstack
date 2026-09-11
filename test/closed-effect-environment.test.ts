import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runtimeAttestation } from './helpers/installed-authority';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], {
    cwd, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(provider: 'github' | 'gitlab' = 'github', options: { extraStage?: boolean; childError?: boolean; fakeTransport?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecpe-child-env-')));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const accountHome = path.join(root, 'account');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(accountHome, '.config/gh'), { recursive: true });
  fs.mkdirSync(path.join(accountHome, '.config/glab-cli'), { recursive: true });
  fs.writeFileSync(path.join(accountHome, '.config/gh/hosts.yml'), 'fixture-config-credential');
  fs.writeFileSync(path.join(accountHome, '.config/glab-cli/config.yml'), 'fixture-config-credential');
  fs.writeFileSync(path.join(accountHome, '.gitconfig'), '[user]\n name = Account User\n email = account@example.invalid\n');
  git(repo, 'init', '-q', '-b', 'feature');
  git(repo, 'remote', 'add', 'origin', `https://${provider === 'github' ? 'github.com' : 'gitlab.com'}/owner/repo.git`);
  fs.writeFileSync(path.join(repo, 'value.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'report[1].txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'report1.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const before = git(repo, 'rev-parse', 'HEAD');
  const log = path.join(root, 'children.jsonl');
  const tools: Record<string, unknown> = {};
  for (const tool of ['git', 'gh', 'glab', 'ssh']) {
    const executable = path.join(root, tool);
    fs.writeFileSync(executable, `#!${process.execPath}\n` + `
import * as fs from 'node:fs';
import * as path from 'node:path';
const tool = ${JSON.stringify(tool)};
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-V') { console.log(tool + ' version fixture'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool, args, env: process.env }) + '\\n');
if (tool === 'git') {
  if (${Boolean(options.fakeTransport)} && args.includes('ls-remote')) {
    console.log('9999999999999999999999999999999999999999\\trefs/heads/feature'); process.exit(0);
  }
  if (${Boolean(options.fakeTransport)} && args.includes('push')) process.exit(0);
  const result = Bun.spawnSync(['/usr/bin/git', ...args], { cwd: process.cwd(), env: process.env, stdin: new Uint8Array(await Bun.stdin.arrayBuffer()), stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  if (${Boolean(options.extraStage)} && args.includes('add') && result.exitCode === 0) {
    Bun.spawnSync(['/usr/bin/git', 'add', '--', 'report1.txt'], { cwd: process.cwd(), env: process.env, timeout: 30_000 });
  }
  process.exit(result.exitCode);
}
if (tool === 'ssh') {
  if (!args.includes('-G')) { console.error('fixture_network_forbidden'); process.exit(1); }
  const source = fs.readFileSync(args[args.indexOf('-F') + 1], 'utf8');
  const hostname = source.match(/^\\s*hostname\\s+(\\S+)/im)?.[1] || 'github.com';
  console.log('hostname ' + hostname + '\\nuser git\\nport 22'); process.exit(0);
}
if (${Boolean(options.childError)}) {
  console.error(process.env.GH_TOKEN || 'fixture-config-credential'); process.exit(1);
}
const authenticated = tool === 'gh'
  ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN || fs.existsSync(path.join(process.env.GH_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '/missing', '.config'), 'gh'), 'hosts.yml'))
  : process.env.GITLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN || process.env.OAUTH_TOKEN || process.env.CI_JOB_TOKEN || fs.existsSync(path.join(process.env.GLAB_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '/missing', '.config'), 'glab-cli'), 'config.yml'));
if (!authenticated) { console.error('fixture_auth_missing'); process.exit(1); }
console.log(args.includes('graphql')
  ? JSON.stringify({ data: { repository: { id: 'R_fixture', nameWithOwner: 'owner/repo', viewerPermission: 'WRITE', pullRequest: { number: 17, state: 'OPEN' } } } })
  : '[]');
`, { mode: 0o700 });
    tools[tool] = { ...runtimeAttestation(executable), version: `${tool} version fixture` };
  }
  const manifest = path.join(root, 'runtime.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'ecpe.gstack-runtime.v1', tools }));
  const adapters = new URL('../lib/closed-effect-adapters.ts', import.meta.url).href;
  const access = new URL('../lib/provider-access.ts', import.meta.url).href;
  const driver = path.join(root, 'driver.ts');
  fs.writeFileSync(driver, `
import { discoverProviderPr, executeGitStageCommit, executeGitPush } from ${JSON.stringify(adapters)};
import { queryProviderAccess } from ${JSON.stringify(access)};
Object.assign(process.env, JSON.parse(process.argv[3]));
try {
  const result = process.argv[2] === 'access' ? await queryProviderAccess(process.cwd(), 17)
    : process.argv[2] === 'push' ? await executeGitPush(process.cwd(), { skill: 'ship', operation: 'ship.delivery' })
    : process.argv[2] === 'commit' ? await executeGitStageCommit(process.cwd(), { skill: 'ship', operation: 'ship.delivery', paths: JSON.parse(process.argv[4]) })
    : await discoverProviderPr(process.cwd(), { skill: 'ship' });
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exit(1); }
`);
  return {
    root, repo, accountHome, before,
    async run(command: 'discover' | 'access' | 'commit' | 'push', env: Record<string, string> = {}, paths = ['value.txt']) {
      const child = Bun.spawn([process.execPath, driver, command, JSON.stringify(env), JSON.stringify(paths)], {
        cwd: repo, env: { PATH: '/usr/bin:/bin', ECPE_TESTING: '1', ECPE_TEST_RUNTIME_MANIFEST: manifest, ECPE_GIT_WRITE_AUTHORIZED: '1', ECPE_GIT_PUSH_AUTHORIZED: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, exitCode };
    },
    children(): Array<{ tool: string; args: string[]; env: Record<string, string> }> {
      return fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    },
  };
}

const hostile = {
  PATH: '/ambient/path', LANG: 'ambient', LC_ALL: 'ambient',
  GIT_DIR: '/wrong/repo', GIT_WORK_TREE: '/wrong/tree', GIT_INDEX_FILE: '/wrong/index',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Ambient User',
  GIT_CONFIG_PARAMETERS: "'user.name=Ambient User'", GIT_CONFIG_GLOBAL: '/wrong/config',
  GIT_SSH: '/wrong/ssh', GIT_SSH_COMMAND: 'false', GIT_ASKPASS: '/wrong/askpass',
  GIT_EXTERNAL_DIFF: '/wrong/diff', GIT_TRACE: '1', GH_DEBUG: 'api', GLAB_DEBUG_HTTP: 'true',
  GH_REPO: 'wrong/repo', GH_HOST: 'wrong.example', GITLAB_HOST: 'wrong.example',
  BASH_ENV: '/wrong/env', NODE_OPTIONS: '--no-warnings', PYTHONPATH: '/wrong/python',
  OPENAI_API_KEY: 'fixture-unrelated-secret', GH_PAGER: '/wrong/pager',
};

function assertIsolated(env: Record<string, string>) {
  expect(env.PATH).toBe('/usr/bin:/bin');
  expect(env.LC_ALL).toBe('C');
  for (const key of Object.keys(hostile).filter(key => !['PATH', 'LANG', 'LC_ALL', 'GIT_EXTERNAL_DIFF'].includes(key))) {
    expect(env[key], key).toBeUndefined();
  }
  expect(env.GIT_EXTERNAL_DIFF ?? '').toBe('');
  expect(env.ECPE_TEST_RUNTIME_MANIFEST).toBeUndefined();
}

describe('closed adapter account environment', () => {
  test.each(['discover', 'access'] as const)('%s passes GitHub CI auth only to the provider child', async command => {
    const f = fixture();
    const result = await f.run(command, { ...hostile, GH_TOKEN: 'fixture-gh-token', GITLAB_TOKEN: 'fixture-other-provider', GIT_AUTHOR_NAME: 'CI Author' });
    expect(result.exitCode).toBe(0);
    for (const child of f.children()) {
      assertIsolated(child.env);
      expect(child.env.GITLAB_TOKEN).toBeUndefined();
      expect(child.env.GH_TOKEN).toBe(child.tool === 'gh' ? 'fixture-gh-token' : undefined);
      expect(child.env.GIT_AUTHOR_NAME).toBe(child.tool === 'git' ? 'CI Author' : undefined);
    }
  });

  test.each(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])('preserves %s for GitHub API authentication', async token => {
    const f = fixture();
    expect((await f.run('access', { [token]: 'fixture-token' })).exitCode).toBe(0);
    expect(f.children().find(child => child.tool === 'gh')!.env[token]).toBe('fixture-token');
  });

  test.each(['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'CI_JOB_TOKEN'])('preserves %s only for GitLab authentication', async token => {
    const f = fixture('gitlab');
    expect((await f.run('discover', { ...hostile, [token]: 'fixture-token', GH_TOKEN: 'fixture-other-provider' })).exitCode).toBe(0);
    for (const child of f.children()) {
      assertIsolated(child.env);
      expect(child.env.GH_TOKEN).toBeUndefined();
      expect(child.env[token]).toBe(child.tool === 'glab' ? 'fixture-token' : undefined);
    }
  });

  test.each(['HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR'])('discovers normal GitHub auth via %s', async variable => {
    const f = fixture();
    const value = variable === 'HOME' ? f.accountHome : path.join(f.accountHome, variable === 'GH_CONFIG_DIR' ? '.config/gh' : '.config');
    const result = await f.run('discover', { [variable]: value });
    expect(result.exitCode).toBe(0);
    expect(f.children().find(child => child.tool === 'gh')!.env[variable]).toBe(value);
  });

  test('commits with global user identity while rejecting ambient Git config injection', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.repo, 'value.txt'), 'changed\n');
    const result = await f.run('commit', { ...hostile, HOME: f.accountHome, SSH_AUTH_SOCK: '/fixture/agent', GNUPGHOME: '/fixture/gnupg' });
    expect(result.exitCode).toBe(0);
    expect(git(f.repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe('Account User <account@example.invalid>|Account User <account@example.invalid>');
    for (const child of f.children()) {
      assertIsolated(child.env);
      expect(child.env.SSH_AUTH_SOCK).toBe('/fixture/agent');
      expect(child.env.GNUPGHOME).toBe('/fixture/gnupg');
    }
  });

  test.each(['HOME', 'XDG_CONFIG_HOME', 'GLAB_CONFIG_DIR'])('discovers normal GitLab auth via %s', async variable => {
    const f = fixture('gitlab');
    const value = variable === 'HOME' ? f.accountHome : path.join(f.accountHome, variable === 'GLAB_CONFIG_DIR' ? '.config/glab-cli' : '.config');
    expect((await f.run('discover', { [variable]: value })).exitCode).toBe(0);
    expect(f.children().find(child => child.tool === 'glab')!.env[variable]).toBe(value);
  });

  test.each(['discover', 'access'] as const)('%s does not expose provider stderr credentials', async command => {
    const f = fixture('github', { childError: true });
    const result = await f.run(command, { GH_TOKEN: 'fixture-private-token' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(command === 'access' ? 'provider_child_failed' : 'closed_effect_failed');
    expect(result.stdout + result.stderr).not.toContain('fixture-private-token');
    const configFailure = await f.run(command, { HOME: f.accountHome });
    expect(configFailure.exitCode).toBe(1);
    expect(configFailure.stdout + configFailure.stderr).not.toContain('fixture-config-credential');
  });

  test('stages a literal bracket filename without staging its neighboring filename', async () => {
    const f = fixture();
    git(f.repo, 'config', 'user.name', 'Fixture'); git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(f.repo, 'report[1].txt'), 'requested\n');
    fs.writeFileSync(path.join(f.repo, 'report1.txt'), 'unrequested\n');
    expect((await f.run('commit', {}, ['report[1].txt'])).exitCode).toBe(0);
    expect(git(f.repo, 'diff', '--name-only', `${f.before}..HEAD`)).toBe('report[1].txt');
    expect(git(f.repo, 'diff', '--name-only')).toBe('report1.txt');
  });

  test('refuses a commit when the staged paths change beyond the granted set', async () => {
    const f = fixture('github', { extraStage: true });
    git(f.repo, 'config', 'user.name', 'Fixture'); git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(f.repo, 'value.txt'), 'requested\n');
    fs.writeFileSync(path.join(f.repo, 'report1.txt'), 'unrequested\n');
    const result = await f.run('commit');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('git_stage_projection_changed');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(f.children().some(child => child.args.includes('commit'))).toBe(false);
  });

  test('does not let rename detection hide an ungranted staged deletion', async () => {
    const f = fixture();
    git(f.repo, 'config', 'user.name', 'Fixture'); git(f.repo, 'config', 'user.email', 'fixture@example.invalid');
    git(f.repo, 'mv', 'value.txt', 'renamed.txt');
    const result = await f.run('commit', {}, ['renamed.txt']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('git_stage_foreign_preimage');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.before);
  });

  test.each(['repository', 'global', 'attributes'])('rejects %s filter context before changing the index', async scope => {
    const f = fixture();
    fs.writeFileSync(path.join(f.repo, 'value.txt'), 'changed\n');
    if (scope === 'repository') git(f.repo, 'config', 'filter.fixture.clean', 'false');
    if (scope === 'global') fs.appendFileSync(path.join(f.accountHome, '.gitconfig'), '[filter "fixture"]\n clean = false\n');
    if (scope === 'attributes') fs.writeFileSync(path.join(f.repo, '.gitattributes'), 'value.txt filter=fixture\n');
    const index = fs.readFileSync(path.join(f.repo, '.git/index'));
    const result = await f.run('commit', { HOME: f.accountHome });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('git_attribute_driver_unsupported');
    expect(fs.readFileSync(path.join(f.repo, '.git/index'))).toEqual(index);
    expect(f.children().some(child => child.args.includes('add'))).toBe(false);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.before);
  });

  test.each(['directory', 'deleted-prefix', 'directory-replaced-by-file'])('rejects a %s path before changing the index', async kind => {
    const f = fixture(); const directory = path.join(f.repo, 'notes');
    fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'entry.txt'), 'note\n');
    if (kind === 'deleted-prefix' || kind === 'directory-replaced-by-file') {
      git(f.repo, 'add', 'notes/entry.txt');
      git(f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'tracked note');
      fs.unlinkSync(path.join(directory, 'entry.txt')); fs.rmdirSync(directory);
      if (kind === 'directory-replaced-by-file') fs.writeFileSync(directory, 'replacement file\n');
    }
    const index = fs.readFileSync(path.join(f.repo, '.git/index'));
    const head = git(f.repo, 'rev-parse', 'HEAD');
    const result = await f.run('commit', { HOME: f.accountHome }, ['notes']);
    expect(result.exitCode).toBe(1);
    expect(fs.readFileSync(path.join(f.repo, '.git/index'))).toEqual(index);
    expect(result.stderr).toContain('git_stage_path_not_file');
    expect(f.children().some(child => child.args.includes('add'))).toBe(false);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('accepts an exact tracked file deletion', async () => {
    const f = fixture(); fs.unlinkSync(path.join(f.repo, 'value.txt'));
    const result = await f.run('commit', { HOME: f.accountHome }, ['value.txt']);
    expect(result.exitCode).toBe(0);
    expect(git(f.repo, 'diff', '--name-status', `${f.before}..HEAD`)).toBe('D\tvalue.txt');
  });

  test.each(['repository', 'global'])('rejects %s push URL rewrites before observing or mutating a remote', async scope => {
    const f = fixture('github', { fakeTransport: true });
    const key = 'url.https://other.example/owner/.pushInsteadOf';
    if (scope === 'repository') git(f.repo, 'config', key, 'https://github.com/owner/');
    else git(f.repo, 'config', '--file', path.join(f.accountHome, '.gitconfig'), key, 'https://github.com/owner/');
    const result = await f.run('push', { HOME: f.accountHome });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('git_transport_config_unsupported');
    expect(f.children().some(child => child.args.includes('ls-remote') || child.args.includes('push'))).toBe(false);
  });

  test('binds remote preimage and mutation to the same literal canonical HTTPS URL', async () => {
    const f = fixture('github', { fakeTransport: true });
    const result = await f.run('push', { ...hostile, HOME: f.accountHome });
    expect(result.exitCode).toBe(0);
    const read = f.children().find(child => child.args.includes('ls-remote'))!;
    const write = f.children().find(child => child.args.includes('push'))!;
    expect(read.args.slice(read.args.indexOf('ls-remote'))).toEqual(['ls-remote', '--heads', 'https://github.com/owner/repo.git', 'refs/heads/feature']);
    expect(write.args.slice(write.args.indexOf('push'))).toEqual(['push', '--no-follow-tags', '--recurse-submodules=no', 'https://github.com/owner/repo.git', `${f.before}:refs/heads/feature`, '--force-with-lease=refs/heads/feature:9999999999999999999999999999999999999999']);
    for (const child of [read, write]) { assertIsolated(child.env); expect(child.env.HOME).toBe(f.accountHome); }
  });

  test.each(['repository', 'global'])('pushes only the granted branch despite %s tag/submodule defaults', async scope => {
    const f = fixture('github', { fakeTransport: true });
    const target = scope === 'repository' ? [] : ['--file', path.join(f.accountHome, '.gitconfig')];
    git(f.repo, 'config', ...target, 'push.followTags', 'true');
    git(f.repo, 'config', ...target, 'push.recurseSubmodules', 'on-demand');
    git(f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'tag', '-am', 'fixture tag', 'fixture-tag');
    expect((await f.run('push', { HOME: f.accountHome })).exitCode).toBe(0);
    const children = f.children();
    const read = children.find(child => child.args.includes('ls-remote'))!;
    const write = children.find(child => child.args.includes('push'))!;
    const bare = path.join(f.root, 'isolated.git'); git(f.root, 'init', '--bare', '-q', bare);
    // Replay the actual adapter argv, substituting only the local transport and
    // its empty-ref lease. This exercises real Git without any network access.
    const replay = write.args.map(arg => arg === 'https://github.com/owner/repo.git' ? bare
      : arg === 'protocol.https.allow=always' ? 'protocol.file.allow=always'
      : arg.startsWith('--force-with-lease=') ? '--force-with-lease=refs/heads/feature:' : arg);
    const pushed = Bun.spawnSync(['/usr/bin/git', ...replay], {
      cwd: f.repo, env: { PATH: '/usr/bin:/bin', HOME: f.accountHome, GIT_CONFIG_NOSYSTEM: '1' },
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    expect(pushed.exitCode).toBe(0);
    expect(git(bare, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/feature');
    expect(write.args).toContain('--no-follow-tags');
    expect(write.args).toContain('--recurse-submodules=no');
    for (const child of [read, write]) {
      expect(child.args).toContain('push.followTags=false');
      expect(child.args).toContain('push.recurseSubmodules=no');
    }
  });

  test.each([
    ['repository', 'followRedirects', 'true'], ['global', 'followRedirects', 'true'],
    ['repository', 'sslVerify', 'false'], ['global', 'sslVerify', 'false'],
  ])('rejects effective %s URL-scoped http.%s=%s before remote access', async (scope, setting, value) => {
    const f = fixture('github', { fakeTransport: true });
    const key = `http.https://github.com/.${setting}`;
    if (scope === 'repository') git(f.repo, 'config', key, value);
    else git(f.repo, 'config', '--file', path.join(f.accountHome, '.gitconfig'), key, value);
    // Prove Git's URL-specific lookup wins over the generic command flags.
    const effective = Bun.spawnSync(['/usr/bin/git', '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
      'config', '--get-urlmatch', `http.${setting}`, 'https://github.com/owner/repo.git'], {
      cwd: f.repo, env: { PATH: '/usr/bin:/bin', HOME: f.accountHome, GIT_CONFIG_NOSYSTEM: '1' },
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    expect(effective.exitCode).toBe(0); expect(effective.stdout.toString().trim()).toBe(value);
    const result = await f.run('push', { HOME: f.accountHome });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('git_transport_config_unsupported');
    expect(f.children().some(child => child.args.includes('ls-remote') || child.args.includes('push'))).toBe(false);
  });

  test.each(['Host github.com\n HostName other.example\n', 'Host github.com\n Include other.conf\n'])('rejects SSH config that cannot preserve the canonical destination: %s', async config => {
    const f = fixture('github', { fakeTransport: true });
    git(f.repo, 'remote', 'set-url', 'origin', 'git@github.com:owner/repo.git');
    fs.mkdirSync(path.join(f.accountHome, '.ssh')); fs.writeFileSync(path.join(f.accountHome, '.ssh/config'), config);
    const result = await f.run('push', { HOME: f.accountHome, SSH_AUTH_SOCK: '/fixture/agent' });
    expect(result.exitCode).toBe(1);
    expect(f.children().some(child => child.args.includes('ls-remote') || child.args.includes('push'))).toBe(false);
  });

  test('pins attested SSH and its validated static config for both network boundaries', async () => {
    const f = fixture('github', { fakeTransport: true });
    git(f.repo, 'remote', 'set-url', 'origin', 'git@github.com:owner/repo.git');
    fs.mkdirSync(path.join(f.accountHome, '.ssh')); fs.writeFileSync(path.join(f.accountHome, '.ssh/config'), 'Host github.com\n HostName github.com\n IdentityFile ~/.ssh/id_ed25519\n');
    const result = await f.run('push', { HOME: f.accountHome, SSH_AUTH_SOCK: '/fixture/agent' });
    expect(result.exitCode).toBe(0);
    const observed = f.children();
    const checked = observed.find(child => child.tool === 'ssh' && child.args.includes('-G'))!;
    expect(checked).toBeDefined();
    const configFile = checked.args[checked.args.indexOf('-F') + 1];
    const boundaries = observed.filter(child => child.tool === 'git' && (child.args.includes('ls-remote') || child.args.includes('push')));
    expect(boundaries).toHaveLength(2);
    for (const child of boundaries) {
      expect(child.env.GIT_SSH_COMMAND).toContain(path.join(f.root, 'ssh'));
      expect(child.env.GIT_SSH_COMMAND).toContain(configFile);
      expect(child.env.SSH_AUTH_SOCK).toBe('/fixture/agent');
      expect(child.args).toContain('ssh://git@github.com/owner/repo.git');
    }
    expect(fs.existsSync(configFile)).toBe(false);
  });
});

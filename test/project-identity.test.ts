import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalizeRepositoryRemote,
  encodeIdentityComponent,
  ledgerCandidates,
  readJsonlUnion,
  resolveRegisteredProjectIdentity,
  resolveProjectIdentity,
  resolveTrustedLocalBase,
} from '../lib/project-identity';

const roots: string[] = [];

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['/usr/bin/git', ...args], { timeout: 30_000,
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: temp('identity-home-'), LC_ALL: 'C' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function repo(remote?: string): string {
  const root = temp('identity-repo-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Identity Test');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'fixture');
  git(root, 'checkout', '-qb', 'feat/x');
  if (remote) git(root, 'remote', 'add', 'origin', remote);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('canonical provider repository identity', () => {
  test('GitHub HTTPS and SSH retain display casing but share a lowercase repo_id', () => {
    for (const remote of [
      'https://github.com/Konghak/PortfolioOps.git',
      'git@github.com:Konghak/PortfolioOps.git',
    ]) {
      const identity = resolveProjectIdentity(repo(remote));
      expect(identity.repo_id).toBe('github.com/konghak/portfolioops');
      expect(identity.provider).toEqual({
        kind: 'github',
        host: 'github.com',
        name_with_owner: 'Konghak/PortfolioOps',
      });
      expect(identity.write_slug).toBe('github.com--konghak--portfolioops');
      expect(identity.read_slugs).toContain('Konghak-PortfolioOps');
      expect(identity.read_slugs).toContain('PortfolioOps');
    }
  });

  test('allowlisted insteadOf and static SSH alias resolve without ssh -G', () => {
    expect(canonicalizeRepositoryRemote('work:Konghak/PortfolioOps.git', {
      insteadOf: [{ prefix: 'work:', replacement: 'https://github.com/' }],
    }).repo_id).toBe('github.com/konghak/portfolioops');

    expect(canonicalizeRepositoryRemote('git@github-konghak:Konghak/PortfolioOps.git', {
      sshConfig: 'Host github-konghak\n  HostName github.com\n  User git\n',
    }).repo_id).toBe('github.com/konghak/portfolioops');
  });

  test('executable or custom transport forms fail before identity output', () => {
    expect(() => canonicalizeRepositoryRemote('ext::sh -c whoami')).toThrow('git_transport_unsupported');
    expect(() => canonicalizeRepositoryRemote('helper::Konghak/PortfolioOps')).toThrow('git_transport_unsupported');
    expect(() => canonicalizeRepositoryRemote('git@alias:Konghak/PortfolioOps.git', {
      sshConfig: 'Host alias\n  ProxyCommand sh -c whoami\n',
    })).toThrow('git_ssh_config_unsupported');
  });

  test('an unresolved SSH alias is legacy-read-only and never gains provider authority', () => {
    const identity = resolveProjectIdentity(repo('git@unknown-alias:Konghak/PortfolioOps.git'));
    expect(identity.provider).toBeUndefined();
    expect(identity.read_slugs).toEqual(expect.arrayContaining(['Konghak-PortfolioOps', 'PortfolioOps']));
  });
});

describe('collision-free write identity and explicit legacy reads', () => {
  test('component encoding is byte-level and cannot collide with separators', () => {
    expect(encodeIdentityComponent('a-b')).toBe('a%2Db');
    expect(encodeIdentityComponent('a%b')).toBe('a%25b');
    expect(encodeIdentityComponent('한')).toBe('%ED%95%9C');
    expect(
      ['a', 'b-c'].map(encodeIdentityComponent).join('--'),
    ).not.toBe(['a-b', 'c'].map(encodeIdentityComponent).join('--'));
    expect(encodeIdentityComponent('a--b')).not.toContain('--');
  });

  test('feat/x writes encodeURIComponent and reads only explicit canonical/legacy forms', () => {
    const identity = resolveProjectIdentity(repo('https://github.com/Konghak/PortfolioOps.git'));
    expect(identity.raw_branch).toBe('feat/x');
    expect(identity.write_branch).toBe('feat%2Fx');
    expect(identity.read_branches).toEqual(expect.arrayContaining(['feat%2Fx', 'feat-x', 'featx']));
    const candidates = ledgerCandidates(identity, 'reviews', '/state');
    expect(candidates).toContain('/state/projects/github.com--konghak--portfolioops/feat%2Fx-reviews.jsonl');
    expect(candidates.some((item) => item.includes('unrelated'))).toBe(false);
  });

  test('union reads deduplicate v2 by run_id and legacy by canonical JSON, then sort', () => {
    const root = temp('identity-ledger-');
    const first = path.join(root, 'first.jsonl');
    const second = path.join(root, 'second.jsonl');
    fs.writeFileSync(first, [
      JSON.stringify({ run_id: 'r2', timestamp: '2026-01-02T00:00:00.000Z', value: 2 }),
      JSON.stringify({ timestamp: '2026-01-03T00:00:00.000Z', a: 1, b: 2 }),
    ].join('\n') + '\n');
    fs.writeFileSync(second, [
      JSON.stringify({ run_id: 'r2', timestamp: '2026-01-02T00:00:00.000Z', value: 999 }),
      JSON.stringify({ b: 2, a: 1, timestamp: '2026-01-03T00:00:00.000Z' }),
      JSON.stringify({ run_id: 'r1', timestamp: '2026-01-01T00:00:00.000Z', value: 1 }),
    ].join('\n') + '\n');

    const rows = readJsonlUnion<any>([first, second]);
    expect(rows.map((row) => row.run_id ?? 'legacy')).toEqual(['r1', 'r2', 'legacy']);
    expect(rows.find((row) => row.run_id === 'r2')!.value).toBe(2);
  });
});

describe('reviewed local registry identity', () => {
  test('deepest root-managed entry stays distinct from the harness root', () => {
    const root = repo();
    const child = path.join(root, 'domains/konghak/agent_contracts');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(root, 'config/workspace-registry.toml'), `
[registry]
version = 2

[[entry]]
id = "agent-contracts"
domain = "konghak"
path = "domains/konghak/agent_contracts"
kind = "root-managed-project"
remote_required = false
active = true
aliases = ["agent_contracts"]
`);

    const nested = resolveProjectIdentity(child);
    const harness = resolveProjectIdentity(root);
    expect(nested.repo_id).toBe('agent-contracts');
    expect(nested.write_slug).toBe('agent%2Dcontracts');
    expect(nested.read_slugs).toContain('agent_contracts');
    expect(harness.repo_id).not.toBe(nested.repo_id);
    expect(ledgerCandidates(harness, 'timeline', '/state')).not.toEqual(
      ledgerCandidates(nested, 'timeline', '/state'),
    );
  });

  test('two registry entries claiming one alias fail closed', () => {
    const root = repo();
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config/workspace-registry.toml'), `
[registry]
version = 2
[[entry]]
id = "one"
path = "."
kind = "root-managed-project"
active = true
aliases = ["shared"]
[[entry]]
id = "two"
path = "sub"
kind = "root-managed-project"
active = true
aliases = ["shared"]
`);
    expect(() => resolveProjectIdentity(root)).toThrow('workspace_registry_alias_collision');
  });

  test('profile mode rejects an unregistered local-only repository', () => {
    const root = repo();
    expect(() => resolveProjectIdentity(root, { mode: 'profile' })).toThrow('local_project_registry_missing');
    expect(resolveProjectIdentity(root, { mode: 'legacy' }).repo_id).toBe(path.basename(root));
  });

  test('internal registry-id resolution cannot be confused with the harness root identity', () => {
    const root = repo();
    const child = path.join(root, 'domains/konghak/agent_contracts');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(root, 'config/workspace-registry.toml'), `
[registry]
version = 2
[[entry]]
id = "agent-contracts"
path = "domains/konghak/agent_contracts"
kind = "root-managed-project"
remote_required = false
active = true
`);
    const counterpart = resolveRegisteredProjectIdentity('agent-contracts', root);
    expect(counterpart.repo_id).toBe('agent-contracts');
    expect(counterpart.write_slug).not.toBe(resolveProjectIdentity(root).write_slug);
    expect(() => resolveRegisteredProjectIdentity('missing', root)).toThrow('registered_project_identity_missing');
  });

  test('trusted local base resolves a reviewed local branch to one frozen full SHA', () => {
    const parent = temp('identity-registry-');
    const local = path.join(parent, 'local');
    fs.mkdirSync(local);
    git(local, 'init', '-q');
    git(local, 'config', 'user.email', 'test@example.com');
    git(local, 'config', 'user.name', 'Identity Test');
    fs.writeFileSync(path.join(local, 'README.md'), 'fixture\n');
    git(local, 'add', 'README.md');
    git(local, 'commit', '-qm', 'fixture');
    git(local, 'branch', '-M', 'main');
    const head = git(local, 'rev-parse', 'HEAD');
    fs.mkdirSync(path.join(parent, 'config'));
    fs.writeFileSync(path.join(parent, 'config/workspace-registry.toml'), `
[registry]
version = 2
[[entry]]
id = "local"
path = "local"
kind = "repository"
remote_required = false
trusted_base_ref = "refs/heads/main"
active = true
`);
    expect(resolveTrustedLocalBase(local)).toEqual({
      registry_id: 'local',
      trusted_base_ref: 'refs/heads/main',
      target_sha: head,
    });
    expect(resolveTrustedLocalBase(local, head)).toMatchObject({ target_sha: head });
    expect(() => resolveTrustedLocalBase(local, '0'.repeat(40))).toThrow('local_trusted_base_target_mismatch');
  });

  test('trusted local base cannot fall back to caller HEAD when unconfigured', () => {
    const parent = temp('identity-registry-');
    const local = path.join(parent, 'local');
    fs.mkdirSync(local);
    git(local, 'init', '-q');
    git(local, 'config', 'user.email', 'test@example.com');
    git(local, 'config', 'user.name', 'Identity Test');
    fs.writeFileSync(path.join(local, 'README.md'), 'fixture\n');
    git(local, 'add', 'README.md');
    git(local, 'commit', '-qm', 'fixture');
    fs.mkdirSync(path.join(parent, 'config'));
    fs.writeFileSync(path.join(parent, 'config/workspace-registry.toml'), `
[registry]
version = 2
[[entry]]
id = "local"
path = "local"
kind = "repository"
remote_required = false
active = true
`);
    expect(() => resolveTrustedLocalBase(local)).toThrow('local_trusted_base_unconfigured');
  });
});

describe('installed project identity CLI', () => {
  test('emits JSON by default, shell-safe closed fields under --shell, and no public registry hint', () => {
    const cwd = repo('https://github.com/Konghak/PortfolioOps.git');
    const script = path.join(import.meta.dir, '..', 'scripts/authority/project-identity.ts');
    const json = Bun.spawnSync(['bun', '--no-env-file', script], { timeout: 30_000, cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout.toString()).repo_id).toBe('github.com/konghak/portfolioops');

    const shell = Bun.spawnSync(['bun', '--no-env-file', script, '--shell'], { timeout: 30_000, cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.toString()).toContain("SLUG='github.com--konghak--portfolioops'");
    expect(shell.stdout.toString()).toContain("BRANCH='feat%2Fx'");
    expect(shell.stdout.toString()).toContain("REPO_ID='github.com/konghak/portfolioops'");

    const hinted = Bun.spawnSync(['bun', '--no-env-file', script, '--registry-id', 'agent-contracts'], { timeout: 30_000,
      cwd, stdout: 'pipe', stderr: 'pipe',
    });
    expect(hinted.exitCode).toBe(2);
    expect(hinted.stderr.toString()).toContain('project_identity_arguments_invalid');
  });
});

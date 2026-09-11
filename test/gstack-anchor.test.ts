import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInstalledAuthorityFixture, runtimeAttestation } from './helpers/installed-authority';

const root = path.resolve(import.meta.dir, '..');
let installed: ReturnType<typeof createInstalledAuthorityFixture>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { timeout: 30_000,
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function profileRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-release-'));
  fs.mkdirSync(path.join(cwd, '.gstack'));
  fs.writeFileSync(path.join(cwd, '.gstack/work-profile.yaml'), fs.readFileSync(path.join(root, 'test/fixtures/work-profile/valid.yaml'), 'utf8'));
  fs.writeFileSync(path.join(cwd, 'VERSION'), '1.2.3\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'GSTACK_FORCE_LEGACY=not-valid\n');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(cwd, 'checkout', '-qb', 'feature');
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

describe('installed authority anchor', () => {
  beforeAll(() => {
    expect(Bun.spawnSync(['bun', 'run', 'scripts/build-authority-bundles.ts'], { timeout: 30_000, cwd: root }).exitCode).toBe(0);
    installed = createInstalledAuthorityFixture(root);
  });
  afterAll(() => installed.cleanup());
  test('runs only a manifest-bound command through pinned Bun', () => {
    const result = Bun.spawnSync([installed.anchor, 'gstack-effect-scope', 'resolve', '--skill', 'review', '--json'], { timeout: 30_000, cwd: root, env: { ...process.env, PATH: '/hostile' } });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).grants).toEqual([]);
  });
  test('ignores a dead build owner record without deleting it', () => {
    const lock = path.join(installed.root, 'dist/.authority-build.lock');
    fs.writeFileSync(lock, `${JSON.stringify({
      schema: 'ecpe.authority-build-lock.v1',
      pid: 2_147_483_647,
      nonce: crypto.randomUUID(),
      created_at: new Date(0).toISOString(),
    })}\n`, { mode: 0o600 });
    try {
      const result = Bun.spawnSync([installed.anchor, 'gstack-effect-scope', 'resolve', '--skill', 'review', '--json'], {
        timeout: 2_000,
        cwd: root,
        env: { ...process.env, PATH: '/hostile' },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });
  test('bundled closed adapters resolve the runtime-root manifest by default', () => {
    const runtimeManifest = path.join(installed.root, '.ecpe-installed-runtime.json');
    const manifest = JSON.parse(fs.readFileSync(runtimeManifest, 'utf8'));
    manifest.tools.git = {
      ...runtimeAttestation('/usr/bin/git'),
      version: execFileSync('/usr/bin/git', ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(),
    };
    fs.writeFileSync(runtimeManifest, JSON.stringify(manifest) + '\n');
    const env = { ...process.env, PATH: '/hostile' };
    delete env.ECPE_TESTING;
    delete env.ECPE_TEST_RUNTIME_MANIFEST;
    const result = Bun.spawnSync([
      installed.anchor, 'gstack-effect-scope', 'provider-pr', 'discover', '--skill', 'ship', '--json',
    ], { timeout: 30_000, cwd: root, env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('tool_manifest_missing:gh');
    expect(result.stderr.toString()).not.toContain('/dist/.ecpe-installed-runtime.json');
  });
  test('installed section delivery verifies and serves a manifest-bound host section', () => {
    const fixture = profileRepository();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-section-state-'));
    fs.chmodSync(stateRoot, 0o700);
    const section = path.join(installed.root, 'sections/ship/pr-body.md');
    const content = fs.readFileSync(path.join(root, 'ship/sections/pr-body.md'), 'utf8');
    fs.mkdirSync(path.dirname(section), { recursive: true });
    fs.writeFileSync(section, content);
    const runtimeManifest = path.join(installed.root, '.ecpe-installed-runtime.json');
    const manifest = JSON.parse(fs.readFileSync(runtimeManifest, 'utf8'));
    manifest.artifacts = {
      '.agents/skills/gstack-ship/sections/pr-body.md': {
        sha256: new Bun.CryptoHasher('sha256').update(content).digest('hex'),
        size: Buffer.byteLength(content),
        mode: fs.statSync(section).mode & 0o777,
      },
    };
    fs.writeFileSync(runtimeManifest, JSON.stringify(manifest) + '\n');
    fs.mkdirSync(path.join(stateRoot, 'ecpe/inflight'), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'ecpe/inflight/run-installed-section.json'), JSON.stringify({
      schema: 'ecpe.lifecycle-inflight.v1', run_id: 'run-installed-section', slug: 'repo', skill: 'ship',
      branch: 'feature', repository_root: fs.realpathSync(fixture.cwd),
      contract: { work_kind: 'release', finish_line: 'pr_open' },
    }));
    const env = { ...process.env, PATH: '/hostile', ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: stateRoot };
    delete env.ECPE_TEST_RUNTIME_MANIFEST;
    try {
      const result = Bun.spawnSync([
        installed.anchor, 'gstack-section-delivery', 'resolve', '--skill', 'ship', '--stage', 'pr-body', '--json',
      ], { timeout: 30_000, cwd: fixture.cwd, env });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const output = JSON.parse(result.stdout.toString());
      expect(output.sections).toHaveLength(1);
      expect(output.sections[0]).toMatchObject({ id: 'pr-body', content });
    } finally {
      fixture.cleanup();
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });
  test('rejects arbitrary command names before a child runs', () => {
    const result = Bun.spawnSync([installed.anchor, '../../evil'], { timeout: 30_000, cwd: root });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('authority_command_unknown');
  });

  test('runs all release frontends through pinned bundles without loading cwd env files', () => {
    const fixture = profileRepository();
    const anchor = installed.anchor;
    const env = { ...process.env, PATH: '/hostile' };
    try {
      const decision = Bun.spawnSync([anchor, 'gstack-next-version', '--assert-target-ref', 'origin/main', '--bump', 'patch', '--json'], { timeout: 30_000, cwd: fixture.cwd, env });
      expect(decision.exitCode).toBe(0);
      expect(JSON.parse(decision.stdout.toString())).toMatchObject({ applicable: false, release_mode: 'none', title_policy: 'free' });

      const classify = Bun.spawnSync([anchor, 'gstack-version-bump', 'classify', '--assert-target-ref', 'origin/main'], { timeout: 30_000, cwd: fixture.cwd, env });
      expect(classify.exitCode).toBe(0);
      expect(JSON.parse(classify.stdout.toString())).toMatchObject({ applicable: false, state: 'NOT_APPLICABLE' });

      const title = Bun.spawnSync([anchor, 'gstack-pr-title-rewrite', '--lane', 'single_repo_code', '--assert-target-ref', 'origin/main', '--assert-title-policy', 'free', '--title', 'Custom title'], { timeout: 30_000, cwd: fixture.cwd, env });
      expect(title.exitCode).toBe(0);
      expect(title.stdout.toString()).toBe('Custom title\n');

      const wrapper = Bun.spawnSync([path.join(installed.bin, 'gstack-pr-title-rewrite.sh'), '--lane', 'single_repo_code', '--assert-target-ref', 'origin/main', '--assert-title-policy', 'free', '--title', 'Wrapper title'], { timeout: 30_000, cwd: fixture.cwd, env });
      expect(wrapper.exitCode).toBe(0);
      expect(wrapper.stdout.toString()).toBe('Wrapper title\n');
    } finally { fixture.cleanup(); }
  });

  test('compatibility wrapper fails before policy evaluation when its bundle is missing or stale', () => {
    const install = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-title-install-'));
    const bin = path.join(install, 'bin');
    const authority = path.join(install, 'dist/authority');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(authority, { recursive: true });
    fs.copyFileSync(path.join(root, 'bin/gstack-anchor'), path.join(bin, 'gstack-anchor'));
    fs.copyFileSync(path.join(root, 'bin/gstack-pr-title-rewrite.sh'), path.join(bin, 'gstack-pr-title-rewrite.sh'));
    fs.chmodSync(path.join(bin, 'gstack-anchor'), 0o755);
    fs.chmodSync(path.join(bin, 'gstack-pr-title-rewrite.sh'), 0o755);
    fs.writeFileSync(path.join(install, '.ecpe-installed-runtime.json'), JSON.stringify({ tools: { bun: runtimeAttestation(process.execPath) } }));
    fs.writeFileSync(path.join(authority, 'manifest.json'), '{}\n');
    try {
      const missing = Bun.spawnSync([path.join(bin, 'gstack-pr-title-rewrite.sh'), '1.2.3', 'feat: x'], { timeout: 30_000, cwd: install });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr.toString()).toContain('authority_bundle_missing');

      const bundle = path.join(authority, 'gstack-pr-title-rewrite.mjs');
      fs.writeFileSync(bundle, 'throw new Error("policy_evaluated")\n', { mode: 0o755 });
      fs.writeFileSync(path.join(authority, 'manifest.json'), JSON.stringify({ commands: { 'gstack-pr-title-rewrite': { sha256: '0'.repeat(64) } } }) + '\n');
      const stale = Bun.spawnSync([path.join(bin, 'gstack-pr-title-rewrite.sh'), '1.2.3', 'feat: x'], { timeout: 30_000, cwd: install });
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toContain('authority_bundle_mismatch');
      expect(stale.stderr.toString()).not.toContain('policy_evaluated');
    } finally { fs.rmSync(install, { recursive: true, force: true }); }
  });

  test('rejects a Bun executable whose installed identity hash is not attested', () => {
    const install = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-runtime-install-'));
    const bin = path.join(install, 'bin');
    const authority = path.join(install, 'dist/authority');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(authority, { recursive: true });
    fs.copyFileSync(path.join(root, 'bin/gstack-anchor'), path.join(bin, 'gstack-anchor'));
    fs.chmodSync(path.join(bin, 'gstack-anchor'), 0o755);
    const bundle = path.join(authority, 'gstack-effect-scope.mjs');
    fs.writeFileSync(bundle, 'process.stdout.write("policy_evaluated\\n")\n', { mode: 0o755 });
    const bundleHash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(bundle)).digest('hex');
    fs.writeFileSync(path.join(authority, 'manifest.json'), JSON.stringify({ commands: { 'gstack-effect-scope': { sha256: bundleHash } } }) + '\n');
    fs.writeFileSync(path.join(install, '.ecpe-installed-runtime.json'), JSON.stringify({
      tools: { bun: { ...runtimeAttestation(process.execPath), sha256: '0'.repeat(64) } },
    }) + '\n');
    try {
      const result = Bun.spawnSync([path.join(bin, 'gstack-anchor'), 'gstack-effect-scope'], { timeout: 30_000, cwd: install });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr.toString()).toContain('bun_identity_mismatch');
    } finally { fs.rmSync(install, { recursive: true, force: true }); }
  });
});

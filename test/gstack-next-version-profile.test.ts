import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersion } from '../lib/version-source';

describe("integration (smoke)", () => {
  const SCRIPT = join(import.meta.dir, '..', 'bin', 'gstack-next-version');
  const decisionKeys = [
    'applicable', 'release_mode', 'title_policy', 'version', 'reason',
    'trusted_base_sha', 'trusted_base_version', 'current_subject_version',
    'current_pr_identity', 'self_claim_excluded', 'profile_hash',
    'version_source', 'planned_targets', 'changelog_projection',
  ].sort();
  const graphSnapshot = (baseSha: string, nodes: unknown[] = [], pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null }) => JSON.stringify({ data: { repository: {
    id: 'R_1', nameWithOwner: 'owner/repo', viewerPermission: 'READ',
    ref: { target: { oid: baseSha } }, pullRequests: { nodes, pageInfo },
    refs: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  } } });
  const trustedEnv = (stub: string) => ({ ...process.env, PATH: `${stub}:${process.env.PATH}`, ECPE_TESTING: '1', ECPE_TEST_GH_PATH: join(stub, 'gh') });
  function trustedProfileRepo(mode: 'per_pr' | 'required_on_release' | 'none') {
    const root = mkdtempSync(join(tmpdir(), 'nextver-profile-'));
    const bare = join(root, 'github.com', 'owner', 'repo.git');
    const work = join(root, 'work');
    mkdirSync(bare, { recursive: true }); mkdirSync(work);
    Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', bare], { timeout: 30_000 });
    const git = (...args: string[]) => Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { timeout: 30_000, cwd: work });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(work, '.gstack'));
    let profile = readFileSync(join(import.meta.dir, 'fixtures/work-profile/valid.yaml'), 'utf8');
    if (mode !== 'none') profile = profile.replace(
      'release:\n  mode: none\n  title_policy: free\nmetadata_projections: []',
      `release:\n  mode: ${mode}\n  title_policy: version_prefix\n  version_source: { path: VERSION, format: plain_text, selector: whole_file }\n  version_targets:\n    - { path: VERSION, format: plain_text, selector: whole_file, value_encoding: exact }\n  changelog_path: CHANGELOG.md\nmetadata_projections:\n  - { path: VERSION, format: plain_text, selector: whole_file }`,
    );
    writeFileSync(join(work, '.gstack/work-profile.yaml'), profile);
    writeFileSync(join(work, 'VERSION'), '1.0.0\n');
    writeFileSync(join(work, 'CHANGELOG.md'), '# Changelog\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const baseSha = new TextDecoder().decode(git('rev-parse', 'HEAD').stdout).trim();
    git('remote', 'add', 'origin', bare); git('push', '-q', 'origin', 'main');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('remote', 'set-url', 'origin', 'git@github.com:owner/repo.git');
    git('checkout', '-qb', 'feature'); writeFileSync(join(work, 'feature.txt'), 'feature\n'); git('add', '-A'); git('commit', '-qm', 'feature');
    const subjectSha = new TextDecoder().decode(git('rev-parse', 'HEAD').stdout).trim();
    return { root, work, baseSha, subjectSha };
  }

  function legacyRepo(versionPath = 'VERSION', version = '1.0.0') {
    const root = mkdtempSync(join(tmpdir(), 'nextver-legacy-'));
    const bare = join(root, 'origin.git'); const work = join(root, 'work'); const stub = join(root, 'stub');
    mkdirSync(work); mkdirSync(stub);
    Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', bare], { timeout: 30_000 });
    Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { timeout: 30_000, cwd: work });
    mkdirSync(join(work, ...versionPath.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(work, versionPath), `${version}\n`);
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { timeout: 30_000, cwd: work });
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { timeout: 30_000, cwd: work });
    Bun.spawnSync(['git', 'remote', 'add', 'origin', bare], { timeout: 30_000, cwd: work });
    Bun.spawnSync(['git', 'push', '-q', 'origin', 'main'], { timeout: 30_000, cwd: work });
    Bun.spawnSync(['git', 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { timeout: 30_000, cwd: work });
    writeFileSync(join(stub, 'gh'), '#!/bin/sh\nexit 9\n', { mode: 0o755 });
    writeFileSync(join(stub, 'glab'), '#!/bin/sh\nexit 9\n', { mode: 0o755 });
    return { root, work, stub };
  }

  test('trusted inactive policy returns before host or queue commands', () => {
    const { root, work } = trustedProfileRepo('none');
    const stub = join(root, 'stub'); const marker = join(root, 'gh-called'); mkdirSync(stub);
    writeFileSync(join(stub, 'gh'), `#!/bin/sh\necho called > ${JSON.stringify(marker)}\nexit 9\n`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch'], { timeout: 30_000, cwd: work, env: { ...process.env, PATH: `${stub}:${process.env.PATH}` } });
    expect(new TextDecoder().decode(proc.stderr)).toBe('');
    const out = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(proc.exitCode).toBe(0);
    expect(Object.keys(out).sort()).toEqual(decisionKeys);
    expect(out).toMatchObject({ applicable: false, release_mode: 'none', version: null, reason: 'disabled', trusted_base_version: null, current_subject_version: null, current_pr_identity: null, self_claim_excluded: false, planned_targets: [] });
    expect(Bun.file(marker).size).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted active allocation observes the complete queue twice and preserves its decision', () => {
    const { root, work, baseSha } = trustedProfileRepo('per_pr');
    const stub = join(root, 'stub'); mkdirSync(stub);
    const snapshot = graphSnapshot(baseSha);
    writeFileSync(join(stub, 'gh'), `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo '${snapshot}'; exit 0; fi
exit 9
`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch', '--lane', 'single_repo_code', '--assert-release-mode', 'per_pr', '--current-version', '1.0.0'], { timeout: 30_000, cwd: work, env: trustedEnv(stub) });
    expect(new TextDecoder().decode(proc.stderr)).toBe('');
    const out = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(proc.exitCode).toBe(0); expect(out.version).toBe('1.0.1');
    expect(out).toMatchObject({
      applicable: true,
      release_mode: 'per_pr',
      title_policy: 'version_prefix',
      reason: 'per_pr',
      trusted_base_sha: baseSha,
      trusted_base_version: '1.0.0',
      current_subject_version: '1.0.0',
      current_pr_identity: null,
      self_claim_excluded: false,
    });
    expect(out.release_decision).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(decisionKeys);
    expect(out.planned_targets).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted explicit release uses the exact top-level decision contract', () => {
    const { root, work, baseSha } = trustedProfileRepo('required_on_release');
    const stub = join(root, 'stub'); mkdirSync(stub);
    const snapshot = graphSnapshot(baseSha);
    writeFileSync(join(stub, 'gh'), `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo '${snapshot}'; exit 0; fi
exit 9
`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch', '--release-requested'], { timeout: 30_000, cwd: work, env: trustedEnv(stub) });
    const out = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(proc.exitCode).toBe(0);
    expect(Object.keys(out).sort()).toEqual(decisionKeys);
    expect(out).toMatchObject({ applicable: true, release_mode: 'required_on_release', reason: 'explicit_release', version: '1.0.1' });
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted queue requires terminal cursor pagination on both snapshots', () => {
    const { root, work, baseSha } = trustedProfileRepo('per_pr');
    const stub = join(root, 'stub'); const calls = join(root, 'calls'); mkdirSync(stub);
    const firstPage = graphSnapshot(baseSha, [], { hasNextPage: true, endCursor: 'CURSOR1' });
    const finalPage = graphSnapshot(baseSha);
    writeFileSync(join(stub, 'gh'), `#!/bin/sh
echo "$*" >> ${JSON.stringify(calls)}
if [ "$1 $2" = "api graphql" ]; then
  case "$*" in *after=CURSOR1*) echo '${finalPage}' ;; *) echo '${firstPage}' ;; esac
  exit 0
fi
exit 9
`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch'], { timeout: 30_000, cwd: work, env: trustedEnv(stub) });
    expect(proc.exitCode).toBe(0);
    const observedCalls = readFileSync(calls, 'utf8').trim().split('\n');
    expect(observedCalls).toHaveLength(6);
    expect(observedCalls.every((line) => line.includes('qualifiedBase=refs/heads/main'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted queue rejects GraphQL partial errors and null nodes as typed unknown', () => {
    for (const response of [
      (() => { const value = JSON.parse(graphSnapshot('BASE')); value.data.repository.ref.target.oid = '7'.repeat(40); value.errors = [{ message: 'partial' }]; return value; })(),
      null,
    ]) {
      const { root, work, baseSha } = trustedProfileRepo('per_pr');
      const stub = join(root, 'stub'); mkdirSync(stub);
      const payload = response === null ? graphSnapshot(baseSha, [null]) : JSON.stringify({ ...response, data: { ...response.data, repository: { ...response.data.repository, ref: { target: { oid: baseSha } } } } });
      writeFileSync(join(stub, 'gh'), `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo '${payload}'; exit 0; fi
exit 9
`, { mode: 0o755 });
      const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch'], { timeout: 30_000, cwd: work, env: trustedEnv(stub) });
      expect(proc.exitCode).toBe(2);
      expect(new TextDecoder().decode(proc.stderr)).toContain('release_queue_unknown');
      expect(new TextDecoder().decode(proc.stdout)).toBe('');
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('trusted queue does not exclude a possible self claim without durable lineage', () => {
    const { root, work, baseSha, subjectSha } = trustedProfileRepo('per_pr');
    const stub = join(root, 'stub'); mkdirSync(stub);
    const nodes = [{ number: 7, baseRefName: 'main', headRefName: 'feature', headRefOid: subjectSha, headRepository: { id: 'R_1', nameWithOwner: 'owner/repo' }, url: 'https://github.com/owner/repo/pull/7', isDraft: false }];
    const snapshot = graphSnapshot(baseSha, nodes);
    const content = JSON.stringify({ encoding: 'base64', content: Buffer.from('1.0.0\n').toString('base64') });
    writeFileSync(join(stub, 'gh'), `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo '${snapshot}'; exit 0; fi
if [ "$1" = "api" ]; then echo '${content}'; exit 0; fi
exit 9
`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch'], { timeout: 30_000, cwd: work, env: trustedEnv(stub) });
    expect(proc.exitCode).toBe(2);
    expect(new TextDecoder().decode(proc.stderr)).toContain('release_lineage_required');
    expect(new TextDecoder().decode(proc.stdout)).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted queue includes a pushed version claim that has no open PR', () => {
    const { root, work, baseSha } = trustedProfileRepo('per_pr');
    const stub = join(root, 'stub'); mkdirSync(stub);
    const value = JSON.parse(graphSnapshot(baseSha));
    value.data.repository.refs.nodes = [{ name: 'queued-without-pr', target: { oid: '4'.repeat(40) } }];
    const snapshot = JSON.stringify(value);
    const content = JSON.stringify({ encoding: 'base64', content: Buffer.from('1.0.1\n').toString('base64') });
    writeFileSync(join(stub, 'gh'), `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo '${snapshot}'; exit 0; fi
if [ "$1" = "api" ]; then echo '${content}'; exit 0; fi
exit 9
`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch'], { timeout: 30_000, cwd: work, env: trustedEnv(stub) });
    const out = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(proc.exitCode).toBe(0);
    expect(out.version).toBe('1.0.2');
    rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ['same-name advanced ref', (subjectSha: string) => ({ name: 'feature', target: { oid: '5'.repeat(40) } })],
    ['same-oid differently named ref', (subjectSha: string) => ({ name: 'renamed-feature', target: { oid: subjectSha } })],
  ])('trusted queue refuses a possible self claim from a %s', (_label, makeReference) => {
    const { root, work, baseSha, subjectSha } = trustedProfileRepo('per_pr');
    const stub = join(root, 'stub'); mkdirSync(stub);
    const value = JSON.parse(graphSnapshot(baseSha));
    value.data.repository.refs.nodes = [makeReference(subjectSha)];
    const snapshot = JSON.stringify(value);
    const content = JSON.stringify({ encoding: 'base64', content: Buffer.from('1.0.1\n').toString('base64') });
    writeFileSync(join(stub, 'gh'), `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo '${snapshot}'; exit 0; fi
if [ "$1" = "api" ]; then echo '${content}'; exit 0; fi
exit 9
`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch'], { timeout: 30_000, cwd: work, env: trustedEnv(stub) });
    expect(proc.exitCode).toBe(2);
    expect(new TextDecoder().decode(proc.stderr)).toContain('release_lineage_required');
    expect(new TextDecoder().decode(proc.stdout)).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted queue blocks an advanced same-repository branch even on another base', () => {
    const { root, work, baseSha } = trustedProfileRepo('per_pr');
    const stub = join(root, 'stub'); mkdirSync(stub);
    const nodes = [{ number: 8, baseRefName: 'release', headRefName: 'feature', headRefOid: '8'.repeat(40), headRepository: { id: 'R_1', nameWithOwner: 'owner/repo' }, url: 'https://github.com/owner/repo/pull/8', isDraft: false }];
    const snapshot = graphSnapshot(baseSha, nodes);
    writeFileSync(join(stub, 'gh'), `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo '${snapshot}'; exit 0; fi
exit 9
`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch'], { timeout: 30_000, cwd: work, env: trustedEnv(stub) });
    expect(proc.exitCode).toBe(2);
    expect(new TextDecoder().decode(proc.stderr)).toContain('release_lineage_required');
    expect(new TextDecoder().decode(proc.stdout)).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted flags never downgrade to legacy when the trusted base cannot be resolved', () => {
    const root = mkdtempSync(join(tmpdir(), 'nextver-unresolved-trusted-'));
    Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { timeout: 30_000, cwd: root });
    writeFileSync(join(root, 'VERSION'), '1.0.0\n');
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { timeout: 30_000, cwd: root });
    Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { timeout: 30_000, cwd: root });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch', '--assert-release-mode', 'per_pr'], { timeout: 30_000, cwd: root });
    expect(proc.exitCode).toBe(2);
    expect(new TextDecoder().decode(proc.stderr)).toContain('trusted_policy_resolution_required');
    expect(new TextDecoder().decode(proc.stdout)).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted allocation rejects a moved provider target', () => {
    const { root, work } = trustedProfileRepo('per_pr');
    const stub = join(root, 'stub'); mkdirSync(stub);
    const snapshot = graphSnapshot('9'.repeat(40));
    writeFileSync(join(stub, 'gh'), `#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then echo '${snapshot}'; exit 0; fi
exit 9
`, { mode: 0o755 });
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch'], { cwd: work, env: trustedEnv(stub) });
    expect(proc.exitCode).toBe(2);
    expect(new TextDecoder().decode(proc.stderr)).toContain('release_queue_drift');
    expect(new TextDecoder().decode(proc.stdout)).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test('trusted allocation fails closed when current projections already differ from target', () => {
    const { root, work } = trustedProfileRepo('per_pr');
    writeFileSync(join(work, 'VERSION'), '1.0.1\n');
    const proc = Bun.spawnSync(['bun', 'run', SCRIPT, '--bump', 'patch', '--current-version', '1.0.1'], { cwd: work });
    expect(proc.exitCode).toBe(2);
    expect(new TextDecoder().decode(proc.stderr)).toContain('release_lineage_required');
    expect(new TextDecoder().decode(proc.stdout)).toBe('');
    rmSync(root, { recursive: true, force: true });
  });

  test("--current-version is equality-only and cannot replace the observed base", () => {
    const { root, work, stub } = legacyRepo();
    const proc = Bun.spawnSync([
      "bun", "run", SCRIPT, "--base", "main", "--bump", "patch",
      "--current-version", "999.999.999.999", "--workspace-root", "null",
    ], { cwd: work, env: { ...process.env, PATH: `${stub}:${process.env.PATH}` } });
    expect(proc.exitCode).toBe(2);
    expect(new TextDecoder().decode(proc.stderr)).toContain("is an assertion");
    expect(new TextDecoder().decode(proc.stdout)).toBe("");
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  // Bumps timeout to 30s — the test spawns a real `bun run` subprocess that
  // does a `gh pr list` against the live GitHub API to inspect claimed slots.
  // Network latency makes 5s tight on developer machines.
  test("CLI runs against real repo and emits parseable JSON", async () => {
    const { root, work, stub } = legacyRepo();
    const proc = Bun.spawnSync([
      "bun",
      "run",
      SCRIPT,
      "--base",
      "main",
      "--bump",
      "patch",
      "--workspace-root",
      "null", // skip sibling scan in CI
    ], { timeout: 30_000, cwd: work, env: { ...process.env, PATH: `${stub}:${process.env.PATH}` } });
    const out = new TextDecoder().decode(proc.stdout);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("version");
    expect(parseVersion(parsed.version)).not.toBeNull();
    expect(parsed).toHaveProperty("bump", "patch");
    expect(parsed).toHaveProperty("host");
    expect(["github", "gitlab", "unknown"]).toContain(parsed.host);
    expect(parsed).toHaveProperty("claimed");
    expect(Array.isArray(parsed.claimed)).toBe(true);
    expect(parsed).toHaveProperty("siblings");
    expect(parsed.siblings).toEqual([]); // --workspace-root null disabled scanning
    expect(parsed).toHaveProperty("version_path", "VERSION"); // default when no config + no flag
    rmSync(root, { recursive: true, force: true });
  }, 30_000); // Headroom over the 4-5s wall time of the spawned process under load

  test("CLI runs with --version-path and surfaces it in JSON output", async () => {
    const versionPath = 'Tinas Second Brain/health-tracker/VERSION';
    const { root, work, stub } = legacyRepo(versionPath, '1.2.3.4');
    const proc = Bun.spawnSync([
      "bun",
      "run",
      SCRIPT,
      "--base",
      "main",
      "--bump",
      "patch",
      "--workspace-root",
      "null",
      "--version-path",
      versionPath,
    ], { timeout: 30_000, cwd: work, env: { ...process.env, PATH: `${stub}:${process.env.PATH}` } });
    const out = new TextDecoder().decode(proc.stdout);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty("version_path", versionPath);
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});

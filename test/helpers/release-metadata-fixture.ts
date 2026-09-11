import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveTrustedWorkProfile } from '../../lib/trusted-base';
import type { ReleaseMetadataDependencies } from '../../lib/release-metadata';

export function fixtureGit(root: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { timeout: 30_000, cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function releaseFixtureDependencies(root: string, state: string): ReleaseMetadataDependencies {
  return {
    state: { root: state, stateRootId: `state_${'f'.repeat(32)}`, effectiveUid: process.geteuid!() },
    observeQueue: () => ({ claimed: [], snapshot: JSON.stringify({ repositoryId: 'R_fixture', refs: [] }), currentPrIdentity: null, possibleSelfClaim: false, exactSelfClaim: null, unresolvedSelfClaim: false }),
    resolveProfile: () => resolveTrustedWorkProfile({ cwd: root, lane: 'single_repo_code', safetyStateRoot: state }),
  };
}
export function releaseFixture(extraJson = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-metadata-'));
  const root = path.join(directory, 'work'), state = path.join(directory, 'state');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 }); fs.mkdirSync(path.join(root, '.gstack'));
  let profile = fs.readFileSync(path.join(import.meta.dir, '../fixtures/work-profile/valid.yaml'), 'utf8');
  const targets = [
    '    - { path: VERSION, format: plain_text, selector: whole_file, value_encoding: exact }',
    '    - { path: pyproject.toml, format: toml, selector: /project/version, value_encoding: exact }',
    ...(extraJson ? ['    - { path: package-lock.json, format: json, selector: /version, value_encoding: exact }', '    - { path: package-lock.json, format: json, selector: /packages//version, value_encoding: exact }'] : []),
  ].join('\n');
  profile = profile.replace('release:\n  mode: none\n  title_policy: free\nmetadata_projections: []', `release:\n  mode: per_pr\n  title_policy: version_prefix\n  version_source: { path: VERSION, format: plain_text, selector: whole_file }\n  version_targets:\n${targets}\n  changelog_path: CHANGELOG.md\nmetadata_projections:\n${targets.replaceAll(', value_encoding: exact', '')}`);
  fs.writeFileSync(path.join(root, '.gstack/work-profile.yaml'), profile);
  fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '# Keep this comment\r\n[project]\r\nname = "example"\r\nversion  = \'1.0.0\'  # keep spacing\r\ndependencies = ["safe==1"]\r\n[tool.demo]\r\nversion = "9.8.7"\r\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\r\n\r\n## [1.0.0] - 2026-01-01\r\n\r\n- Existing entry.\r\n');
  if (extraJson) fs.writeFileSync(path.join(root, 'package-lock.json'), '{ "version" : "1.0.0", "packages": {"": {"version": "1.0.0"}, "other": {"version":"8.0.0"}}, "lockfileVersion": 3 }\n');
  fs.writeFileSync(path.join(root, 'docs.md'), 'Existing product text.\n');
  fixtureGit(root, 'init', '-q', '-b', 'main'); fixtureGit(root, 'add', '-A'); fixtureGit(root, 'commit', '-qm', 'base');
  fixtureGit(root, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git');
  fixtureGit(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  fixtureGit(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  fixtureGit(root, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(root, 'docs.md'), 'Product text prepared before release.\n');
  const dependencies = releaseFixtureDependencies(root, state);
  const before = new Map(fs.readdirSync(root).filter(name => fs.lstatSync(path.join(root, name)).isFile()).map(name => [name, fs.readFileSync(path.join(root, name))]));
  return { directory, root, state, dependencies, before, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

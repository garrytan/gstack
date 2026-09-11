import { expect, test as bunTest } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseFixture, fixtureGit } from './helpers/release-metadata-fixture';
import { releaseMetadata } from '../lib/release-metadata';
import { parseReleaseMetadataCommand } from '../lib/release-metadata-command';
import { renderLegacyJson } from '../lib/release-projections';

const bin = path.join(import.meta.dir, '../bin/gstack-version-bump');
const test = (name: string, fn: () => void | Promise<void>) => bunTest(name, fn, 30000);
const worker = path.join(import.meta.dir, 'fixtures/release-metadata-cli-worker.ts');
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString();
const bytes = (fixture: ReturnType<typeof releaseFixture>) => new Map([...fixture.before.keys()].map(name => [name, fs.readFileSync(path.join(fixture.root, name))]));
function legacy(seed = false, canonical = false) {
  const fixture = releaseFixture();
  const profile = fs.readFileSync(path.join(fixture.root, '.gstack/work-profile.yaml'));
  fixtureGit(fixture.root, 'rm', '.gstack/work-profile.yaml'); fixtureGit(fixture.root, 'commit', '-qm', 'legacy base');
  fixtureGit(fixture.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(fixture.root, 'docs.md'), 'Existing product text.\n');
  if (seed) { fs.mkdirSync(path.join(fixture.root, '.gstack'), { recursive: true }); fs.writeFileSync(path.join(fixture.root, '.gstack/work-profile.yaml'), profile); }
  if (canonical) fixtureGit(fixture.root, 'remote', 'set-url', 'origin', 'git@github.com:Konghak/PortfolioOps.git');
  fixture.before = bytes(fixture);
  return fixture;
}
function run(fixture: ReturnType<typeof releaseFixture>, args: string[], crash = '', entry = '- CLI release.') {
  return Bun.spawnSync([process.execPath, worker, fixture.root, fixture.state, crash, ...args], { timeout: 30_000, cwd: fixture.root, stdin: Buffer.from(entry) });
}

test('strict frontend accepts only intent and equality assertions', () => {
  expect(parseReleaseMetadataCommand(['write', '--lane','docs_ux','--bump', 'patch', '--assert-target-ref', 'origin/main', '--release-requested', '--assert-release-mode', 'required_on_release', '--entry-stdin'])).toMatchObject({ operation: 'write',lane:'docs_ux', bump: 'patch', releaseRequested: true });
  expect(parseReleaseMetadataCommand(['retire', '--assert-target-ref', 'origin/main', '--assert-version', '1.0.1'])).toEqual({ operation: 'retire', assertTargetRef: 'origin/main', assertVersion: '1.0.1' });
  for (const flag of ['--version', '--release-mode', '--base', '--version-path', '--package-json-path', '--workspace-root', '--exclude-pr', '--state-root', '--gh-path', '--bootstrap', '--changelog-path']) {
    expect(() => parseReleaseMetadataCommand(['write', flag, 'none'])).toThrow('release_argument_forbidden');
  }
  expect(() => parseReleaseMetadataCommand(['write', '--bump', 'patch', '--bump', 'minor'])).toThrow('release_argument_duplicate');
  expect(() => parseReleaseMetadataCommand(['write','--lane','unknown'])).toThrow('release_lane_invalid');
  expect(() => parseReleaseMetadataCommand(['repair', '--entry-stdin'])).toThrow('release_argument_forbidden');
  expect(() => parseReleaseMetadataCommand(['retire', '--entry-stdin'])).toThrow('release_argument_forbidden');
});

for (const mode of ['none', 'required_on_release']) test(`real CLI inactive ${mode}: classify and rejected write/repair do not read metadata or call test tools`, () => {
  const fixture = releaseFixture();
  try {
    const profile = path.join(fixture.root, '.gstack/work-profile.yaml');
    let inactive = fs.readFileSync(profile, 'utf8').replace('mode: per_pr', `mode: ${mode}`);
    if (mode === 'none') inactive = inactive.replace(/  version_source:[\s\S]*?metadata_projections:/, 'metadata_projections:').replace('title_policy: version_prefix', 'title_policy: free');
    fs.writeFileSync(profile, inactive);
    fixtureGit(fixture.root, 'add', '.gstack/work-profile.yaml'); fixtureGit(fixture.root, 'commit', '-qm', 'inactive'); fixtureGit(fixture.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    fs.unlinkSync(path.join(fixture.root, 'VERSION')); fs.mkdirSync(path.join(fixture.root, 'VERSION'));
    const before = fixtureGit(fixture.root, 'status', '--porcelain');
    const environment = { ...process.env, ECPE_TESTING: '1', ECPE_TEST_STATE_ROOT: path.join(fixture.directory, 'must-not-exist'), ECPE_TEST_GH_PATH: '/no/test/command', GSTACK_FORCE_LEGACY: '1' };
    const classify = Bun.spawnSync([process.execPath, bin, 'classify', '--assert-target-ref', 'origin/main'], { timeout: 30_000, cwd: fixture.root, env: environment });
    expect(text(classify.stderr)).toBe(''); expect(classify.exitCode).toBe(0); expect(JSON.parse(text(classify.stdout)).state).toBe('NOT_APPLICABLE');
    for (const command of [['write', '--bump', 'patch'], ['repair']]) {
      const result = Bun.spawnSync([process.execPath, bin, ...command, '--assert-target-ref', 'origin/main'], { timeout: 30_000, cwd: fixture.root, env: environment });
      expect(result.exitCode).toBe(2); expect(text(result.stderr)).toContain('release_not_applicable');
    }
    expect(fixtureGit(fixture.root, 'status', '--porcelain')).toBe(before);
    expect(fs.readdirSync(fixture.state)).toEqual([]); expect(fs.existsSync(environment.ECPE_TEST_STATE_ROOT)).toBe(false);
  } finally { fixture.cleanup(); }
});

test('trusted CLI rejects legacy selection, assertion mismatch and candidate self-disable before mutation', () => {
  const fixture = releaseFixture();
  try {
    const profile = path.join(fixture.root, '.gstack/work-profile.yaml');
    fs.writeFileSync(profile, fs.readFileSync(profile, 'utf8').replace('mode: per_pr', 'mode: none'));
    for (const args of [['write', '--version', '9.9.9'], ['write', '--bump', 'patch', '--version-path', 'other'], ['write', '--bump', 'patch', '--assert-release-mode', 'none']]) {
      const result = run(fixture, args); expect(result.exitCode).toBe(2);
    }
    expect(bytes(fixture)).toEqual(fixture.before); expect(fs.readdirSync(fixture.state)).toEqual([]);
  } finally { fixture.cleanup(); }
});

test('CLI allocate, write, inspect, and repair reuse one owner and original stdin', () => {
  const fixture = releaseFixture();
  try {
    const allocated = run(fixture, ['allocate', '--bump', 'patch']); expect(allocated.exitCode).toBe(0);
    const first = JSON.parse(text(allocated.stdout)); expect(bytes(fixture)).toEqual(fixture.before);
    const write = run(fixture, ['write', '--bump', 'patch', '--entry-stdin']); expect(text(write.stderr)).toBe(''); expect(write.exitCode).toBe(0);
    const written = JSON.parse(text(write.stdout)); expect(written.allocation_id).toBe(first.allocation_id);
    for (const command of ['inspect', 'repair']) {
      const result = run(fixture, [command], '', ''); expect(text(result.stderr)).toBe(''); expect(result.exitCode).toBe(0);
      expect(JSON.parse(text(result.stdout)).release_write_record_id).toBe(written.release_write_record_id);
    }
    expect(fs.readFileSync(path.join(fixture.state, 'trace'), 'utf8').split('\n').filter(line => line.startsWith('replaced:'))).toHaveLength(3);
  } finally { fixture.cleanup(); }
});

test('ordinary legacy Python and a noncanonical seed never select pyproject', async () => {
  for (const seed of [false, true]) {
    const fixture = legacy(seed);
    try {
      const phases: string[] = []; fixture.dependencies.observe = phase => phases.push(phase);
      const result = await releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => '- Legacy release.' }, fixture.dependencies);
      expect(result.profile_hash).toBeNull(); expect(result.policy_source).toBe('legacy_metadata');
      expect(result.planned_targets?.map(item => item.path)).toEqual(['VERSION']);
      expect(fs.readFileSync(path.join(fixture.root, 'pyproject.toml'))).toEqual(fixture.before.get('pyproject.toml'));
      expect(phases.filter(phase => phase === 'replaced:pyproject.toml')).toHaveLength(0);
    } finally { fixture.cleanup(); }
  }
});

test('canonical bootstrap writes exactly VERSION, one TOML selector and one changelog insertion', () => {
  const fixture = legacy(true, true);
  try {
    // Candidate release policy is untrusted even when it names another source.
    const profile = path.join(fixture.root, '.gstack/work-profile.yaml');
    fs.writeFileSync(profile, 'release:\n  mode: none\n  version_targets: [fourth-file]\n');
    const written = run(fixture, ['write', '--bump', 'patch', '--entry-stdin']); expect(text(written.stderr)).toBe(''); expect(written.exitCode).toBe(0);
    const result = JSON.parse(text(written.stdout));
    expect(result.bootstrap_descriptor).toBe('portfolioops-first-profile-v1'); expect(result.profile_hash).toBeNull();
    expect(result.mutated_projections.map((item: any) => [item.path, item.selector])).toEqual([['VERSION', 'whole_file'], ['pyproject.toml', '/project/version'], ['CHANGELOG.md', 'whole_file']]);
    expect(fs.readFileSync(path.join(fixture.root, 'pyproject.toml'), 'utf8')).toBe(fixture.before.get('pyproject.toml')!.toString().replace("'1.0.0'", "'1.0.1'"));
    expect(fs.readFileSync(path.join(fixture.root, 'docs.md'))).toEqual(fixture.before.get('docs.md'));
    const retry = run(fixture, ['repair'], '', ''); expect(text(retry.stderr)).toBe(''); expect(retry.exitCode).toBe(0);
    expect(JSON.parse(text(retry.stdout)).release_write_record_id).toBe(result.release_write_record_id);
    expect(fs.readFileSync(path.join(fixture.state, 'trace'), 'utf8').split('\n').filter(line => line.startsWith('replaced:'))).toHaveLength(3);
  } finally { fixture.cleanup(); }
});

for (const change of ['source', 'other-toml-field', 'version-drift', 'malformed-toml', 'executable-seed', 'prewritten-changelog', 'pin']) test(`bootstrap blocks ${change} before target mutation`, async () => {
  const fixture = legacy(true, true);
  try {
    const toml = path.join(fixture.root, 'pyproject.toml');
    if (change === 'source') fs.writeFileSync(path.join(fixture.root, 'src.ts'), 'source');
    if (change === 'other-toml-field') fs.appendFileSync(toml, 'extra = true\n');
    if (change === 'version-drift') fs.writeFileSync(toml, fs.readFileSync(toml, 'utf8').replace("'1.0.0'", "'1.2.3'"));
    if (change === 'malformed-toml') fs.writeFileSync(toml, '[project\n');
    if (change === 'executable-seed') fs.chmodSync(path.join(fixture.root, '.gstack/work-profile.yaml'), 0o755);
    if (change === 'prewritten-changelog') fs.appendFileSync(path.join(fixture.root, 'CHANGELOG.md'), '\nUnowned entry.\n');
    if (change === 'pin') fs.writeFileSync(path.join(fixture.root, '.gstack/version-path'), 'other');
    const before = bytes(fixture), phases: string[] = []; fixture.dependencies.observe = phase => phases.push(phase);
    await expect(releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => '- Seed.' }, fixture.dependencies)).rejects.toThrow();
    expect(bytes(fixture)).toEqual(before); expect(phases.filter(phase => phase.startsWith('replaced:'))).toHaveLength(0);
  } finally { fixture.cleanup(); }
});

test('bootstrap recovery after TOML replacement uses its durable entry and has no fourth mutation', () => {
  const fixture = legacy(true, true);
  try {
    const killed = run(fixture, ['write', '--bump', 'patch', '--entry-stdin'], 'replaced:pyproject.toml'); expect(killed.exitCode).not.toBe(0);
    const recovered = run(fixture, ['repair'], '', ''); expect(text(recovered.stderr)).toBe(''); expect(recovered.exitCode).toBe(0);
    expect(JSON.parse(text(recovered.stdout)).mutated_projections).toHaveLength(3);
    expect(fs.readFileSync(path.join(fixture.state, 'trace'), 'utf8').split('\n').filter(line => line.startsWith('replaced:'))).toHaveLength(3);
  } finally { fixture.cleanup(); }
});

test('legacy lock renderer preserves missing fields and all unrelated bytes', () => {
  const raw = '{ "packages": {"": {"version":"1.0.0"}, "dep":{"version":"5.0.0"}}, "lockfileVersion": 3 }\n';
  expect(renderLegacyJson(raw, '1.0.1', true)).toEqual({ text: raw.replace('"1.0.0"', '"1.0.1"'), selectors: ['/packages//version'] });
  expect(renderLegacyJson('{"lockfileVersion":1}', '1.0.1', true)).toEqual({ text: '{"lockfileVersion":1}', selectors: [] });
  expect(() => renderLegacyJson('{"version":"1.0.0","packages":{"":{"version":"1.0.2"}}}', '1.0.1', true)).toThrow('release_legacy_lock_drift');
});

test('bootstrap permits only the four seed paths and supports absent CHANGELOG', async () => {
  const fixture = legacy(true, true);
  try {
    fixtureGit(fixture.root, 'rm', 'CHANGELOG.md'); fixtureGit(fixture.root, 'commit', '-qm', 'base without changelog'); fixtureGit(fixture.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    fs.mkdirSync(path.join(fixture.root, 'docs'));
    fs.writeFileSync(path.join(fixture.root, '.gitignore'), '.gstack/*\n!.gstack/work-profile.yaml\n');
    for (const name of ['LOCAL_DEVELOPMENT.md', '00_START_HERE.md']) fs.writeFileSync(path.join(fixture.root, 'docs', name), '# Seed instructions\n');
    const result = await releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => { throw new Error('no changelog input'); } }, fixture.dependencies);
    expect(result.mutated_projections?.map(item => item.path)).toEqual(['VERSION', 'pyproject.toml']); expect(fs.existsSync(path.join(fixture.root, 'CHANGELOG.md'))).toBe(false);
  } finally { fixture.cleanup(); }
});

test('legacy durable owner discovers pinned JSON source and both lock selectors, writing the lock once', async () => {
  const fixture = legacy();
  try {
    fs.mkdirSync(path.join(fixture.root, '.gstack'), { recursive: true }); fs.mkdirSync(path.join(fixture.root, 'web'));
    fs.writeFileSync(path.join(fixture.root, '.gstack/version-path'), 'web/package.json\n');
    const pkg = '{ "name": "web", "version": "1.0.0" }\n';
    const lock = '{ "version": "1.0.0", "packages": {"": {"version": "1.0.0"}, "dep": {"version":"9.9.9"}} }\n';
    fs.writeFileSync(path.join(fixture.root, 'web/package.json'), pkg); fs.writeFileSync(path.join(fixture.root, 'web/package-lock.json'), lock);
    fixtureGit(fixture.root, 'add', '.gstack/version-path', 'web'); fixtureGit(fixture.root, 'commit', '-qm', 'pinned source'); fixtureGit(fixture.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const phases: string[] = []; fixture.dependencies.observe = phase => phases.push(phase);
    const result = await releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => '- Pinned release.' }, fixture.dependencies);
    expect(result.planned_targets?.map(item => [item.path, item.selector])).toEqual([['web/package.json', '/version'], ['web/package-lock.json', '/version'], ['web/package-lock.json', '/packages//version']]);
    expect(fs.readFileSync(path.join(fixture.root, 'web/package-lock.json'), 'utf8')).toBe(lock.replaceAll('1.0.0', '1.0.1'));
    expect(phases.filter(phase => phase === 'replaced:web/package-lock.json')).toHaveLength(1);
    expect(fs.readFileSync(path.join(fixture.root, 'VERSION'), 'utf8')).toBe('1.0.0\n');
  } finally { fixture.cleanup(); }
});

for (const lock of ['{"version":"1.0.0","packages":{"":{"version":"1.0.2"}}}', '{bad', '{"version":null}']) test(`legacy malformed or disagreeing lock blocks all writes: ${lock}`, async () => {
  const fixture = legacy();
  try {
    fs.writeFileSync(path.join(fixture.root, 'package-lock.json'), lock);
    const before = bytes(fixture), phases: string[] = []; fixture.dependencies.observe = phase => phases.push(phase);
    await expect(releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => '- Release.' }, fixture.dependencies)).rejects.toThrow();
    expect(bytes(fixture)).toEqual(before); expect(phases).toEqual([]);
  } finally { fixture.cleanup(); }
});

for (const staged of ['source', 'executable-mode', 'unrelated-toml-field']) test(`bootstrap rejects staged-only ${staged} despite allowed worktree bytes`, async () => {
  const fixture = legacy(true, true);
  try {
    if (staged === 'source') {
      fs.writeFileSync(path.join(fixture.root, 'source.ts'), 'export const forbidden = true;\n');
      fixtureGit(fixture.root, 'add', 'source.ts');
      fs.unlinkSync(path.join(fixture.root, 'source.ts'));
    } else if (staged === 'executable-mode') {
      fixtureGit(fixture.root, 'add', '.gstack/work-profile.yaml');
      fixtureGit(fixture.root, 'update-index', '--chmod=+x', '.gstack/work-profile.yaml');
      expect(fs.statSync(path.join(fixture.root, '.gstack/work-profile.yaml')).mode & 0o111).toBe(0);
    } else {
      fs.appendFileSync(path.join(fixture.root, 'pyproject.toml'), 'unrelated = "indexed only"\n');
      fixtureGit(fixture.root, 'add', 'pyproject.toml');
      fs.writeFileSync(path.join(fixture.root, 'pyproject.toml'), fixture.before.get('pyproject.toml')!);
    }
    const before = bytes(fixture), index = fixtureGit(fixture.root, 'ls-files', '--stage'), phases: string[] = [];
    fixture.dependencies.observe = phase => phases.push(phase);
    await expect(releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => '- Seed.' }, fixture.dependencies)).rejects.toThrow('release_bootstrap_index');
    expect(bytes(fixture)).toEqual(before); expect(fixtureGit(fixture.root, 'ls-files', '--stage')).toBe(index); expect(phases).toEqual([]);
  } finally { fixture.cleanup(); }
});

test('subdirectory invocation cannot bypass committed root profile when trusted resolution fails', () => {
  const fixture = releaseFixture();
  try {
    fixtureGit(fixture.root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    fixtureGit(fixture.root, 'update-ref', '-d', 'refs/remotes/origin/main');
    fs.unlinkSync(path.join(fixture.root, '.gstack/work-profile.yaml'));
    const subdir = path.join(fixture.root, 'app'); fs.mkdirSync(subdir); fs.writeFileSync(path.join(subdir, 'VERSION'), '2.0.0\n');
    const result = Bun.spawnSync([process.execPath, bin, 'write', '--version', '9.9.9'], { timeout: 30_000, cwd: subdir });
    expect(result.exitCode).toBe(2); expect(fs.readFileSync(path.join(subdir, 'VERSION'), 'utf8')).toBe('2.0.0\n'); expect(bytes(fixture)).toEqual(fixture.before);
  } finally { fixture.cleanup(); }
});

for (const stale of ['1.0.0-beta', '', null]) test(`legacy manifest repair accepts stale ${JSON.stringify(stale)} while lockfile rejection stays strict`, () => {
  const fixture = legacy();
  try {
    const pkg = path.join(fixture.root, 'package.json');
    const raw = `{ "name": "legacy", "version": ${JSON.stringify(stale)}, "other": true }\n`;
    fs.writeFileSync(pkg, raw);
    const repaired = Bun.spawnSync([process.execPath, bin, 'repair'], { timeout: 30_000, cwd: fixture.root });
    expect(text(repaired.stderr)).toBe(''); expect(repaired.exitCode).toBe(0);
    expect(fs.readFileSync(pkg, 'utf8')).toBe(raw.replace(`"version": ${JSON.stringify(stale)}`, '"version": "1.0.0"'));
    const locked = path.join(fixture.root, 'package-lock.json'); fs.writeFileSync(locked, raw);
    const before = bytes(fixture), pkgBefore = fs.readFileSync(pkg);
    const refused = Bun.spawnSync([process.execPath, bin, 'write', '--version', '1.0.1'], { timeout: 30_000, cwd: fixture.root });
    expect(refused.exitCode).toBe(3); expect(bytes(fixture)).toEqual(before); expect(fs.readFileSync(pkg)).toEqual(pkgBefore); expect(fs.readFileSync(locked, 'utf8')).toBe(raw);
  } finally { fixture.cleanup(); }
});

test('durable CLI skips symlink lockfile with warning, no target read or write, and stable recovery', () => {
  const fixture = legacy();
  try {
    const outside = path.join(fixture.directory, 'outside-lock.json'), link = path.join(fixture.root, 'package-lock.json');
    const invalid = '{ this target is not parseable JSON and must not be read }\n';
    fs.writeFileSync(outside, invalid); fs.symlinkSync(outside, link);
    const written = run(fixture, ['write', '--bump', 'patch', '--entry-stdin']);
    expect(written.exitCode).toBe(0); expect(text(written.stderr)).toContain('WARNING: package-lock.json is a symlink; not synced.');
    const result = JSON.parse(text(written.stdout)); expect(result.planned_targets.map((item: any) => item.path)).toEqual(['VERSION']);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true); expect(fs.readlinkSync(link)).toBe(outside); expect(fs.readFileSync(outside, 'utf8')).toBe(invalid);
    const recovered = run(fixture, ['recover'], '', ''); expect(recovered.exitCode).toBe(0); expect(JSON.parse(text(recovered.stdout)).release_write_record_id).toBe(result.release_write_record_id);
    expect(fs.readFileSync(path.join(fixture.state, 'trace'), 'utf8')).not.toContain('replaced:package-lock.json');
  } finally { fixture.cleanup(); }
});

test('durable skipped-lockfile link movement after allocation blocks before any metadata write', () => {
  const fixture = legacy();
  try {
    const link = path.join(fixture.root, 'package-lock.json');
    fs.symlinkSync(path.join(fixture.directory, 'absent-one'), link);
    expect(run(fixture, ['allocate', '--bump', 'patch']).exitCode).toBe(0);
    fs.unlinkSync(link); fs.symlinkSync(path.join(fixture.directory, 'absent-two'), link);
    const refused = run(fixture, ['write', '--bump', 'patch', '--entry-stdin']);
    expect(refused.exitCode).toBe(2); expect(text(refused.stderr)).toMatch(/release_lineage_required|release_skipped_lockfile_moved/); expect(bytes(fixture)).toEqual(fixture.before);
    expect(fs.readFileSync(path.join(fixture.state, 'trace'), 'utf8')).not.toContain('replaced:');
  } finally { fixture.cleanup(); }
});

test('durable skipped-lockfile link movement during entry collection blocks before replacement', async () => {
  const fixture = legacy();
  try {
    const link = path.join(fixture.root, 'package-lock.json'); fs.symlinkSync(path.join(fixture.directory, 'absent-one'), link);
    const phases: string[] = []; fixture.dependencies.observe = phase => phases.push(phase);
    await expect(releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => {
      fs.unlinkSync(link); fs.symlinkSync(path.join(fixture.directory, 'absent-two'), link); return '- Entry.';
    } }, fixture.dependencies)).rejects.toThrow('release_skipped_lockfile_moved');
    expect(bytes(fixture)).toEqual(fixture.before); expect(phases.filter(phase => phase.startsWith('replaced:'))).toEqual([]);
  } finally { fixture.cleanup(); }
});

test('trusted exact-target lockfile symlink remains rejected without a compatibility skip', async () => {
  const fixture = releaseFixture(true);
  try {
    const outside = path.join(fixture.directory, 'outside.json'), lock = path.join(fixture.root, 'package-lock.json');
    fs.writeFileSync(outside, fixture.before.get('package-lock.json')!); fs.unlinkSync(lock); fs.symlinkSync(outside, lock);
    const phases: string[] = []; fixture.dependencies.observe = phase => phases.push(phase);
    await expect(releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => '- Entry.' }, fixture.dependencies)).rejects.toThrow('release_version_source_unreadable');
    expect(phases).toEqual([]); expect(fs.readFileSync(outside)).toEqual(fixture.before.get('package-lock.json'));
  } finally { fixture.cleanup(); }
});

test('skipped-lockfile retarget at before_success_publication cannot publish durable success', async () => {
  const fixture = legacy();
  try {
    const link = path.join(fixture.root, 'package-lock.json'), movedTarget = path.join(fixture.directory, 'absent-two');
    fs.symlinkSync(path.join(fixture.directory, 'absent-one'), link);
    const phases: string[] = [];
    fixture.dependencies.observe = phase => {
      phases.push(phase);
      if (phase === 'before_success_publication') { fs.unlinkSync(link); fs.symlinkSync(movedTarget, link); }
    };
    await expect(releaseMetadata({ cwd: fixture.root, operation: 'write', bump: 'patch', entryBody: () => '- Entry.' }, fixture.dependencies)).rejects.toThrow('release_manual_repair_required');
    expect(phases.filter(phase => phase === 'before_success_publication')).toHaveLength(1);
    expect(phases.filter(phase => phase.startsWith('replaced:'))).toHaveLength(2);
    expect(phases).not.toContain('write_result_durable');
    const owners = path.join(fixture.state, 'release-metadata');
    const owner = path.join(owners, fs.readdirSync(owners)[0]);
    const ledger = JSON.parse(fs.readFileSync(path.join(owner, 'ledger.json'), 'utf8')).value;
    expect(ledger.allocations).toHaveLength(1); expect(ledger.allocations[0].phase).toBe('restoring');
    expect(fs.readdirSync(owner).filter(file => file.endsWith('.bundle.json'))).toHaveLength(1);
    expect(fs.readlinkSync(link)).toBe(movedTarget);
    await expect(releaseMetadata({ cwd: fixture.root, operation: 'inspect' }, fixture.dependencies)).rejects.toThrow('release_skipped_lockfile_moved');
  } finally { fixture.cleanup(); }
});

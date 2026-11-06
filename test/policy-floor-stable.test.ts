/**
 * GST-1637: a ship-policy floor above the newest stable gstack release breaks every stable-channel lane.
 * gstack-ship-policy validate and the pregate policy-floor check refuse it by name; the doctor's floor row
 * compares runningGstackVersion (as validatePolicy does) and offers no fast-forward when no release meets it.
 * The stable release comes from fixture repos named by GSTACK_STABLE_REPO, never from the network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { runningGstackVersion, validatePolicy } from '../lib/ship-policy';
import { useDoctorCleanup, REPO, makeFixture, doctor, write as writeFile } from './helpers/doctor-fixture';
import { cleanup as cleanupPregate, commit, makeFixtureRepo as makePregateRepo, runBin as runPregateBin, type FixtureRepo as PregateRepo } from './helpers/pregate-fixture';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

useDoctorCleanup();
const dirs: string[] = [];
const repos: FixtureRepo[] = [];
const pregateRepos: PregateRepo[] = [];
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  while (pregateRepos.length) cleanupPregate(pregateRepos.pop()!);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'fx', GIT_AUTHOR_EMAIL: 'fx@example.com', GIT_COMMITTER_NAME: 'fx', GIT_COMMITTER_EMAIL: 'fx@example.com', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-stable-fx-'))); dirs.push(d); return d; };

/** A gstack stand-in: release tags pushed to its origin (remote), or a stable branch with no origin (local). */
function stableRepo(version: string, how: 'remote' | 'local'): string {
  const base = tmp(), work = path.join(base, 'gstack');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'VERSION'), `${version}\n`);
  git(work, 'add', 'VERSION');
  git(work, 'commit', '-q', '-m', 'release');
  if (how === 'local') { git(work, 'branch', 'stable'); return work; }
  git(base, 'init', '-q', '--bare', 'origin.git');
  git(work, 'tag', '-a', `v${version}`, '-m', `v${version}`);
  git(work, 'tag', '-a', 'v0.0.1', '-m', 'v0.0.1');
  git(work, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
  git(work, 'push', '-q', 'origin', 'main', '--tags');
  git(work, 'tag', '-d', `v${version}`);
  return work;
}

/** A cut that stopped half-way: stable at v<stable>, and a v<tagged> release tag on a later commit stable never reached. */
function halfCutRepo(stable: string, tagged: string, how: 'remote' | 'local'): string {
  const base = tmp(), work = path.join(base, 'gstack');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  for (const v of [stable, tagged]) {
    fs.writeFileSync(path.join(work, 'VERSION'), `${v}\n`);
    git(work, 'add', 'VERSION');
    git(work, 'commit', '-q', '-m', `v${v}`);
    git(work, 'tag', '-a', `v${v}`, '-m', `v${v}`);
    if (v === stable) git(work, 'branch', 'stable');
  }
  if (how === 'local') return work;
  git(base, 'init', '-q', '--bare', 'origin.git');
  git(work, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
  git(work, 'push', '-q', 'origin', 'main', 'stable', '--tags');
  return work;
}

/** A vendored gstack copy: a directory with no .git inside a project repo whose own release tag is v1.2.0.0. */
function vendoredRoot(): string {
  const app = tmp();
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'commit', '-q', '--allow-empty', '-m', 'app');
  git(app, 'tag', '-a', 'v1.2.0.0', '-m', 'v1.2.0.0');
  const vendored = path.join(app, '.claude', 'skills', 'gstack');
  fs.mkdirSync(vendored, { recursive: true });
  return vendored;
}

const FLOOR = runningGstackVersion();
const BELOW = '1.0.0.0';
const policyRepo = (floor: string) => {
  const repo = makeFixtureRepo({ policy: null });
  repos.push(repo);
  fs.mkdirSync(path.join(repo.work, '.gstack'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), JSON.stringify({ min_gstack_version: floor }) + '\n');
  return repo;
};

describe('gstack-ship-policy validate: min_gstack_version against the newest stable release', () => {
  // Value: protects=stable-channel lanes from a policy floor no stable release meets; fails_when=validate passes a floor above stable and every stable lane refuses the policy (POLICY_GSTACK_TOO_OLD) with no upgrade that clears it;
  //   why_new=GST-1637 (FOUN-32, founderstar#626); seam=bin/gstack-ship-policy; no_claim=the network path (fixtures use a local origin)
  test('a floor above the newest stable release tag is refused, naming the floor and the stable version', () => {
    expect(validatePolicy({ min_gstack_version: FLOOR })).toEqual([]);
    const repo = policyRepo(FLOOR);
    const r = runBin(repo, 'gstack-ship-policy', ['validate'], { GSTACK_STABLE_REPO: stableRepo(BELOW, 'remote') });
    expect(r.status, r.out + r.err).toBe(EXIT.fail);
    expect(r.err).toContain(`min_gstack_version ${FLOOR} is above the newest stable gstack release ${BELOW} (release tag v${BELOW} on origin)`);
    expect(r.err).toContain('(POLICY_FLOOR_ABOVE_STABLE)');
    expect(r.out).toMatch(/^POLICY_INVALID: 1 error\(s\)/);
    const j = JSON.parse(runBin(repo, 'gstack-ship-policy', ['validate', '--json'], { GSTACK_STABLE_REPO: stableRepo(BELOW, 'local') }).out);
    expect([j.valid, j.stable, j.errors.map((e: { code: string; path: string }) => `${e.code}:${e.path}`)]).toEqual([false, BELOW, ['POLICY_FLOOR_ABOVE_STABLE:min_gstack_version']]);
    expect(j.errors[0].message).toContain('(stable VERSION (local; origin unreachable))');
  });

  test('a floor at the newest stable release passes', () => {
    const repo = policyRepo(FLOOR);
    const r = runBin(repo, 'gstack-ship-policy', ['validate'], { GSTACK_STABLE_REPO: stableRepo(FLOOR, 'remote') });
    expect(r.status, r.out + r.err).toBe(EXIT.ok);
    expect(r.out).toMatch(/^POLICY_VALID: /);
    expect(r.err).toBe('');
    expect(JSON.parse(runBin(repo, 'gstack-ship-policy', ['validate', '--json'], { GSTACK_STABLE_REPO: stableRepo(FLOOR, 'local') }).out)).toMatchObject({ valid: true, stable: FLOOR, warnings: [] });
  });

  test('no reachable tags or stable ref: a warning that says the floor was not compared, never a refusal', () => {
    const repo = policyRepo(FLOOR);
    const r = runBin(repo, 'gstack-ship-policy', ['validate'], { GSTACK_STABLE_REPO: tmp() });
    expect(r.status, r.out + r.err).toBe(EXIT.ok);
    expect(r.out).toMatch(/^POLICY_VALID: /);
    expect(r.err).toContain(`gstack-ship-policy: WARN could not resolve the newest stable gstack release`);
    expect(r.err).toContain(`so min_gstack_version ${FLOOR} was not compared with it`);
    expect(r.err).toContain('(STABLE_RELEASE_UNKNOWN)');
  });

  // Value: protects=stable-channel lanes during a cut that tagged a release but never moved stable; fails_when=the highest tag wins over the tag at stable and a floor no stable lane can read passes;
  //   why_new=GST-1637 /ship outside voice; seam=lib/stable-release.ts newestStableRelease; no_claim=-
  test('a release tag stable never reached does not count: the floor is judged against the tag at stable', () => {
    const repo = policyRepo(FLOOR);
    const remote = runBin(repo, 'gstack-ship-policy', ['validate'], { GSTACK_STABLE_REPO: halfCutRepo(BELOW, FLOOR, 'remote') });
    expect(remote.status, remote.out + remote.err).toBe(EXIT.fail);
    expect(remote.err).toContain(`min_gstack_version ${FLOOR} is above the newest stable gstack release ${BELOW} (release tag v${BELOW} at origin's stable)`);
    const local = runBin(repo, 'gstack-ship-policy', ['validate'], { GSTACK_STABLE_REPO: halfCutRepo(BELOW, FLOOR, 'local') });
    expect(local.status, local.out + local.err).toBe(EXIT.fail);
    expect(local.err).toContain(`the newest stable gstack release ${BELOW} (stable VERSION (local; origin unreachable))`);
  });

  // Value: protects=vendored installs (a .git-less copy inside a project) from comparing the floor with the project's own release tags; fails_when=git -C walks up to the project repo and its v<version> tags stand in for gstack's;
  //   why_new=GST-1637 /ship red-team; seam=lib/stable-release.ts newestStableRelease; no_claim=-
  test('a gstack root with no .git of its own never reads the enclosing project repo: the floor is not compared', () => {
    const repo = policyRepo(FLOOR);
    const r = runBin(repo, 'gstack-ship-policy', ['validate'], { GSTACK_STABLE_REPO: vendoredRoot() });
    expect(r.status, r.out + r.err).toBe(EXIT.ok);
    expect(r.err).toContain('is not a gstack checkout of its own');
    expect(r.err).toContain('(STABLE_RELEASE_UNKNOWN)');
  });
});

describe('pregate policy-floor: on a branch that changes the policy', () => {
  const pregate = (repo: PregateRepo, stable: string) => runPregateBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'preflight', '--only', 'policy-floor'], { GSTACK_STABLE_REPO: stable });
  const fx = () => { const r = makePregateRepo(); pregateRepos.push(r); return r; };

  test('refuses a floor above stable by name, passes one at stable, warns when stable is unresolvable, and ignores a branch that leaves the policy alone', () => {
    const repo = fx();
    expect(pregate(repo, stableRepo(BELOW, 'remote')).out).toMatch(/^preflight {2}policy-floor +pass .*\.gstack\/ship-policy\.json unchanged/m);
    commit(repo, { '.gstack/ship-policy.json': JSON.stringify({ min_gstack_version: FLOOR }) + '\n' });
    const above = pregate(repo, stableRepo(BELOW, 'remote'));
    expect(above.status, above.out + above.err).toBe(EXIT.fail);
    expect(above.out + above.err).toContain(`min_gstack_version ${FLOOR} is above the newest stable gstack release ${BELOW}`);
    expect(above.err).toContain('(POLICY_FLOOR_ABOVE_STABLE)');
    const at = pregate(repo, stableRepo(FLOOR, 'remote'));
    expect(at.status, at.out + at.err).toBe(EXIT.ok);
    expect(at.out).toContain(`min_gstack_version ${FLOOR} is at or below the newest stable gstack release ${FLOOR}`);
    const unknown = pregate(repo, tmp());
    expect(unknown.out).toMatch(/^preflight {2}policy-floor +warn .*could not resolve the newest stable gstack release/m);
  });
});

describe('gstack-doctor --check floor row', () => {
  const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
  const floorRow = (f: ReturnType<typeof makeFixture>, project: string, extra: Record<string, string> = {}) => {
    const out = doctor(f, ['--check', '--project', project, '--for', 'health'], extra).out;
    const line = out.split('\n').find(l => /^(PASS|WARN|SKIP|FAIL) floor\b/.test(l)) ?? '';
    return { status: line.split(' ')[0], line };
  };
  const project = (f: ReturnType<typeof makeFixture>, floor: string) => {
    const dir = path.join(f.base, 'project');
    writeFile(path.join(dir, '.gstack/ship-policy.json'), `{\n  "min_gstack_version": "${floor}"\n}\n`);
    return dir;
  };

  // Value: protects=sessions on an unstamped main checkout from a floor WARN that no fast-forward clears; fails_when=the doctor compares VERSION while validatePolicy compares runningGstackVersion;
  //   why_new=GST-1637; seam=bin/gstack-doctor-check.sh _dc_check_floor; no_claim=-
  test('an unstamped main checkout gets the verdict validatePolicy gives: the newest policy key it knows counts', () => {
    const f = makeFixture();
    fs.copyFileSync(path.join(REPO, 'lib/ship-policy-keys.ts'), path.join(f.root, 'lib/ship-policy-keys.ts'));
    const known = runningGstackVersion();
    const dir = project(f, known);
    const at = floorRow(f, dir);
    expect(validatePolicy({ min_gstack_version: known })).toEqual([]);
    expect(at.status, at.line).toBe('PASS');
    expect(at.line).toBe(known === VERSION ? `PASS floor ${known} declared by ${dir}/.gstack/ship-policy.json (installed ${VERSION})` : `PASS floor ${known} declared by ${dir}/.gstack/ship-policy.json (installed ${VERSION}, reads policies as ${known})`);
    // A checkout whose VERSION lags a key it carries reads the key's floor (validatePolicy agrees), so the row passes.
    writeFile(path.join(f.root, 'VERSION'), '1.0.0.0\n');
    const lagging = floorRow(f, project(f, known));
    expect(lagging.line).toBe(`PASS floor ${known} declared by ${dir}/.gstack/ship-policy.json (installed 1.0.0.0, reads policies as ${known})`);
    expect(validatePolicy({ min_gstack_version: known }, { gstackVersion: runningGstackVersion() })).toEqual([]);
    const next = known.replace(/^(\d+)\.(\d+)\..*$/, (_, a, b) => `${a}.${Number(b) + 1}.0.0`);
    expect(validatePolicy({ min_gstack_version: next }).map(e => e.code)).toEqual(['POLICY_GSTACK_TOO_OLD']);
    expect(floorRow(f, project(f, next)).status).toBe('WARN');
  });

  test('no fast-forward is offered when the newest stable release does not meet the floor; one is when it does', () => {
    const f = makeFixture();
    const wrapper = '/drive/skills/gstack/scripts/install.sh';
    const dir = project(f, '999.0.0.0');
    for (const how of ['remote', 'local'] as const) {
      const none = floorRow(f, dir, { GSTACK_CAPY_WRAPPER_PATH: wrapper, GSTACK_STABLE_REPO: stableRepo('1.2.0.0', how) });
      expect(none.status, none.line).toBe('WARN');
      expect(none.line).toContain(`installed ${VERSION} is below the floor 999.0.0.0 that ${dir}/.gstack/ship-policy.json declares (min_gstack_version), and no release meets this floor yet: the newest stable gstack is 1.2.0.0`);
      expect(none.line).not.toContain('fast-forwards');
      expect(none.line).not.toContain(wrapper);
      expect(none.line).toContain('(PROJECT_FLOOR_UNMET; ');
    }
    const met = floorRow(f, dir, { GSTACK_CAPY_WRAPPER_PATH: wrapper, GSTACK_STABLE_REPO: stableRepo('999.0.0.0', 'remote') });
    expect(met.status).toBe('WARN');
    expect(met.line).toContain(`fix: bash ${wrapper} --for health (fast-forwards a clean checkout to origin and reinstalls)`);
    expect(met.line).not.toContain('no release meets this floor yet');
    for (const how of ['remote', 'local'] as const) {
      const halfCut = floorRow(f, dir, { GSTACK_CAPY_WRAPPER_PATH: wrapper, GSTACK_STABLE_REPO: halfCutRepo('1.2.0.0', '999.0.0.0', how) });
      expect(halfCut.line).toContain('no release meets this floor yet: the newest stable gstack is 1.2.0.0');
    }
    const vendored = floorRow(f, dir, { GSTACK_CAPY_WRAPPER_PATH: wrapper, GSTACK_STABLE_REPO: vendoredRoot() });
    expect(vendored.line).toContain(`fix: bash ${wrapper} --for health (fast-forwards a clean checkout to origin and reinstalls)`);
    expect(vendored.line).not.toContain('no release meets this floor yet');
  });
});

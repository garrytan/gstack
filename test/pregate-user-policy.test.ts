/**
 * The user-owned pregate policy and `local` lanes. A repo that keeps `.gstack/`
 * out of git declares its policy at `<GSTACK_HOME>/projects/<slug>/pregate.json`;
 * the base branch's copy always wins, and `--policy-from head` never reads the
 * user file. A platform lane named in `local` runs here instead of becoming
 * requires-remote. Every assertion holds on any host platform: each lane the
 * fixture selects is either named in `local` or asserted only by label.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { loadConfigFromUser, validateConfig } from '../lib/pregate/config';
import { buildContext, sha256, userConfigRejection } from '../lib/pregate/context';
import { runPregate } from '../lib/pregate/index';
import { BASE_PREGATE, BIN, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';
import { runScriptSync } from '../lib/script-invocation';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const SLUG = 'userpolicy';
const LOCAL_ALL = ['free-tests.yml/unit', 'windows.yml/windows-shard'];

/** A fixture whose base carries no `.gstack/pregate.json`, a feature commit touching lib/util.js, and the user-file path for its slug. */
function setup(): { repo: FixtureRepo; userPolicy: string; run: (extra?: string[]) => ReturnType<typeof runBin> } {
  const repo = makeFixtureRepo({ pregate: null });
  repos.push(repo);
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
  const userPolicy = path.join(repo.home, 'projects', SLUG, 'pregate.json');
  fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
  const run = (extra: string[] = []) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', ...extra], { GSTACK_PROJECT_SLUG: SLUG });
  return { repo, userPolicy, run };
}
/** setup() with a base that commits `.gstack/pregate.json` (raw text, or a policy object). */
function setupWithBase(base: string | Record<string, unknown>): { repo: FixtureRepo; userPolicy: string } {
  const repo = makeFixtureRepo({ pregate: null, baseFiles: { '.gstack/pregate.json': typeof base === 'string' ? base : JSON.stringify(base) } });
  repos.push(repo);
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
  const userPolicy = path.join(repo.home, 'projects', SLUG, 'pregate.json');
  fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
  return { repo, userPolicy };
}
const writePolicy = (file: string, policy: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ runner: 'node --test {files}', ...policy }));

describe('pregate.json local', () => {
  // Value: protects=`local` accepts only <workflow file>/<job id> lane ids, shared with selection keys; fails_when=a bare job name or a
  //   string is accepted and silently matches no lane; why_new=the key is new; seam=none; no_claim=none beyond protects
  test('takes <workflow>/<job> ids only', () => {
    expect(validateConfig({ local: ['test.yml/unit'] })).toEqual([]);
    expect(validateConfig({ local: ['unit'] }).map(e => e.path)).toEqual(['local[0]']);
    expect(validateConfig({ local: 'test.yml/unit' }).map(e => e.path)).toEqual(['local']);
    expect(validateConfig({ local: [7] }).map(e => e.path)).toEqual(['local']);
    expect(validateConfig({ selection: { unit: 'true' } }).map(e => e.path)).toEqual(['selection["unit"]']);
  });
});

describe('loadConfigFromUser', () => {
  // Value: protects=a missing user file falls back (null) while any other read error refuses at the file's path, never defaults;
  //   fails_when=every read error is treated as absent and the user's guards silently vanish; why_new=the loader is new; seam=none;
  //   no_claim=EACCES specifically (a directory, and a dangling symlink, stand in for an unreadable file)
  test('ENOENT is null; an unreadable file refuses at its path', () => {
    const { userPolicy } = setup();
    expect(loadConfigFromUser(userPolicy)).toBeNull();
    fs.mkdirSync(userPolicy);
    const load = loadConfigFromUser(userPolicy);
    expect(load && 'errors' in load ? load.errors.map(e => [e.code, e.path]) : null).toEqual([['PREGATE_CONFIG_INVALID', userPolicy]]);
    expect(load && 'kind' in load ? [load.kind, load.label] : null).toEqual(['user', `user ${userPolicy}`]);
    fs.rmSync(userPolicy, { recursive: true });
    fs.symlinkSync(path.join(path.dirname(userPolicy), 'not-yet-cloned.json'), userPolicy);
    const dangling = loadConfigFromUser(userPolicy);
    expect(dangling && 'errors' in dangling ? dangling.errors.map(e => [e.code, e.path]) : null).toEqual([['PREGATE_CONFIG_INVALID', userPolicy]]);
    fs.unlinkSync(userPolicy);
    // A dangling link one level up (the project directory) is the same intent.
    const dir = path.dirname(userPolicy);
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(path.join(path.dirname(dir), 'not-yet-cloned'), dir);
    expect(loadConfigFromUser(userPolicy)).not.toBeNull();
    fs.unlinkSync(dir);
    fs.mkdirSync(dir);
    // Malformed JSON reaches the sealed/price_file probe too; it must still come back as a refusal, never a throw.
    fs.writeFileSync(userPolicy, '{"local": [');
    const bad = loadConfigFromUser(userPolicy);
    expect(bad && 'errors' in bad ? bad.errors.map(e => e.message.startsWith('not valid JSON')) : null).toEqual([true]);
    // The JSON error names this file, not the repo copy parseConfig assumes.
    expect(bad && 'errors' in bad ? bad.errors.map(e => e.path) : null).toEqual([userPolicy]);
  });
});

describe('gstack-pregate with a user-owned policy', () => {
  // Value: protects=with no base copy the user file is the policy and its `local` lanes run here, while an unnamed platform lane stays
  //   requires-remote; fails_when=the user fallback or the `local` branch in selectLanes is dropped; why_new=both are new;
  //   seam=none; no_claim=a real CI host (lanes are judged by the fixture's workflows)
  test('the user file is read when the base has none, and a local lane runs here instead of requires-remote', () => {
    const { repo, userPolicy, run } = setup();
    expect(run().out).toContain('(no .gstack/pregate.json)');

    // The lane left off `local` must be foreign to this host: on Windows the windows lane is native and runs anyway.
    const [named, foreign] = process.platform === 'win32'
      ? [['windows.yml/windows-shard', 'windows'], ['free-tests.yml/unit', 'linux']]
      : [['free-tests.yml/unit', 'linux'], ['windows.yml/windows-shard', 'windows']];
    writePolicy(userPolicy, { local: [named[0]] });
    const partial = run();
    expect(partial.out).toContain(`policy user ${userPolicy}`);
    expect(partial.out).toContain(`requires-remote ${foreign[0]} (${foreign[1]})`);
    expect(partial.out).not.toContain(`requires-remote ${named[0]}`);

    writePolicy(userPolicy, { local: LOCAL_ALL });
    const all = run(['--explain']);
    expect(all.status).toBe(EXIT.ok);
    // The record pins the user file's bytes, since no commit does.
    const lanes = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === 'lanes');
    expect(lanes.inputs.policy).toBe(sha256(fs.readFileSync(userPolicy, 'utf8')));
    expect(all.out).toContain('Tiers ran: unit; requires-remote: none');
    expect(all.out).toContain(`lane ${foreign[0]}: ${foreign[1]} lane satisfied locally (pregate.json local)`);
    expect(all.out).toMatch(/^tests {6}lanes {5}pass /m);
  }, 60_000);

  // Value: protects=a fix that says where to declare policy names the user file when it is the active policy, since an edit to the
  //   repo's .gstack/pregate.json is never read on a base that carries none; fails_when=the fix hardcodes .gstack/pregate.json;
  //   why_new=the user source is new; seam=none; no_claim=every fix string (strays, runner, remote_gate share ctx.configFile)
  test('the no-lane fix names the user file when it is the active policy', () => {
    const { repo, userPolicy, run } = setup();
    writePolicy(userPolicy, { local: LOCAL_ALL });
    commit(repo, { 'lib/orphan.js': 'exports.lonely = () => 2;\n' });
    expect(run().status).not.toBe(EXIT.ok);
    const lanes = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === 'lanes');
    expect(lanes.code).toBe('PREGATE_NO_LANE');
    expect(lanes.fix).toContain(`under dependencies — or empty_lanes for other documentation — in ${userPolicy}`);
  }, 60_000);

  // Value: protects=an invalid, sealed-bearing or unreadable user file refuses with PREGATE_CONFIG_INVALID naming the file, with a fix
  //   that points at the file rather than the base branch; fails_when=user-file errors run on defaults, or sealed/price_file are accepted
  //   and look active while nothing reads them; why_new=the user source is new; seam=none; no_claim=the sealed guard itself
  test('an invalid, sealed or unreadable user file refuses and names the file', () => {
    const { userPolicy, run } = setup();
    writePolicy(userPolicy, { local: ['not-a-lane'] });
    const invalid = run();
    expect(invalid.status).toBe(EXIT.refused);
    expect(invalid.err).toContain('PREGATE_CONFIG_INVALID');
    expect(invalid.err).toContain(`user ${userPolicy}`);
    expect(invalid.err).toContain(`fix: edit ${userPolicy} directly`);
    expect(invalid.err).not.toContain('.gstack/pregate.json has');

    for (const [key, value] of [['sealed', { paths: ['evals/**'] }], ['price_file', 'evals/calls.json']] as const) {
      writePolicy(userPolicy, { [key]: value });
      const r = run();
      expect(r.status).toBe(EXIT.refused);
      expect(r.err).toContain(`covers gstack-pregate run only; ${key}`);
    }
    // A null price_file is the documented default, not a policy, so it is accepted.
    writePolicy(userPolicy, { price_file: null, local: LOCAL_ALL });
    expect(run().err).not.toContain('PREGATE_CONFIG_INVALID');

    fs.rmSync(userPolicy);
    fs.mkdirSync(userPolicy);
    const unreadable = run();
    expect(unreadable.status).toBe(EXIT.refused);
    expect(unreadable.err).toContain('cannot read the user-owned policy');
  }, 60_000);

  // Value: protects=the user file is consulted only for --policy-from base with no base copy: head mode and a committed base copy never
  //   read it; fails_when=either guard on the fallback is dropped and an unreviewed user file overrides reviewed policy; why_new=the
  //   fallback is new; seam=none; no_claim=none beyond protects
  test('--policy-from head and a base copy never read the user file', () => {
    const { repo, userPolicy, run } = setup();
    writePolicy(userPolicy, { local: ['not-a-lane'] });

    const head = run(['--policy-from', 'head']);
    expect(head.err).not.toContain('PREGATE_CONFIG_INVALID');
    expect(head.out).not.toContain('policy user');

    commit(repo, { '.gstack/pregate.json': JSON.stringify(BASE_PREGATE) + '\n' });
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' });
    const based = run();
    expect(based.err).not.toContain('PREGATE_CONFIG_INVALID');
    expect(based.out).toContain('origin/main@');
    expect(based.out).not.toContain('policy user');
    // A base copy is pinned by inputs.base; no user digest is recorded.
    const lanes = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === 'lanes');
    expect(lanes.inputs.base).toContain('origin/main@');
    expect('policy' in lanes.inputs).toBe(false);
  }, 60_000);

  // Value: protects=the --remote refusal for a policy with no remote_gate tells the user where to declare it: the repo copy "on the
  //   base branch", the user file by its path (never "on the base branch", which the user file is not on); fails_when=the
  //   configFile ternary is dropped or inverted and the user is sent to edit a file nothing reads; why_new=no test reaches the
  //   no-remote_gate branch and the user source is new; seam=none (userConfigPath and remote are existing buildContext options);
  //   no_claim=the remote gate run itself
  test('--remote with no remote_gate names the file to declare it in', async () => {
    const lanesFix = async (repo: FixtureRepo, userConfigPath?: string) => {
      const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 16, testBackend: 'local', remote: { spendCapUsd: 1 }, userConfigPath });
      if (!('ctx' in loaded)) throw new Error('fixture context refused');
      const lanes = (await runPregate(loaded.ctx, { stage: 'tests' })).checks.find(c => c.id === 'lanes')!;
      expect([lanes.status, lanes.code]).toEqual(['incomplete', 'PREGATE_INCOMPLETE']);
      return lanes.fix!;
    };
    const { repo, userPolicy } = setup();
    writePolicy(userPolicy, { local: LOCAL_ALL });
    const user = await lanesFix(repo, userPolicy);
    expect(user).toContain(`in ${userPolicy}, or run the tests locally`);
    expect(user).not.toContain('on the base branch');

    const based = makeFixtureRepo({ pregate: { ...BASE_PREGATE, local: LOCAL_ALL } });
    repos.push(based);
    commit(based, { 'lib/util.js': 'exports.add = (a, b) => b + a;\n' });
    expect(await lanesFix(based)).toContain('in .gstack/pregate.json on the base branch, or run the tests locally');
  }, 60_000);

  // Value: protects=the strays fail fix, the strays warn fix and the PREGATE_STALLED fix each name the user file when it is the active
  //   policy, so the user edits the file that is read; fails_when=any of the three reverts to a hardcoded .gstack/pregate.json, which a
  //   base carrying none never reads; why_new=existing strays and stall tests assert detail and lines, never the fix, and only with a
  //   repo copy; seam=none; no_claim=the stall timing itself (pregate-supervise covers it)
  test('strays (fail and warn) and stall fixes name the user file', () => {
    const { repo, userPolicy, run } = setup();
    writePolicy(userPolicy, { local: LOCAL_ALL });
    const check = (id: string) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: { id: string }) => c.id === id);
    const strays = (files: Record<string, string | null>) => {
      commit(repo, files);
      runBin(repo, 'gstack-pregate', ['--base', 'main', '--stage', 'preflight', '--only', 'strays'], { GSTACK_PROJECT_SLUG: SLUG });
      return check('strays');
    };

    const fail = strays({ 'notes.txt': 'x\n', 'newtop/thing.js': 'module.exports = 1;\n' });
    expect([fail.status, fail.code]).toEqual(['fail', 'PREGATE_STRAYS']);
    expect(fail.fix).toContain(`goes in ${userPolicy} strays.allow`);

    const warn = strays({ 'notes.txt': null });
    expect([warn.status, warn.code]).toEqual(['warn', 'PREGATE_STRAYS']);
    expect(warn.fix).toContain(`allow it in ${userPolicy} strays.allow`);

    commit(repo, { 'newtop/thing.js': null, 'test/hang.test.js': 'setInterval(() => {}, 1000);\n' });
    run(['--stall-timeout', '2']);
    const stalled = check('lanes');
    expect(stalled.code).toBe('PREGATE_STALLED');
    expect(stalled.fix).toContain(`stall_timeout_s in ${userPolicy}; 0 disables`);
  }, 60_000);

  // Value: protects=a user path inside the checkout (GSTACK_HOME under the repo, or a relative state root when HOME is unset) is
  //   never read, so a PR cannot commit its own "user" policy; fails_when=userConfigRejection is dropped and the in-repo file
  //   becomes the policy; why_new=the trust check is new; seam=none (userConfigPath is an existing buildContext option);
  //   no_claim=a symlinked state root (the next test)
  test('a user path inside the repository or relative is ignored, with an explain line', () => {
    const { repo } = setup();
    const inside = path.join(repo.work, '.gstack', 'projects', 'x', 'pregate.json');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, JSON.stringify({ local: ['not-a-lane'] }));
    for (const [file, why] of [[inside, 'inside the repository'], [path.join('.gstack', 'projects', 'x', 'pregate.json'), 'not an absolute path']] as const) {
      const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 16, testBackend: 'local', userConfigPath: file });
      if (!('ctx' in loaded)) throw new Error(`refused: ${loaded.refused.message}`);
      expect(loaded.ctx.configLabel).not.toStartWith('user ');
      expect(loaded.ctx.explain).toContain(`user policy: ${file} ignored (${why}${why === 'inside the repository' ? '; a PR could supply it' : ''})`);
    }
  }, 60_000);

  // Value: protects=a base copy that exists but git show cannot read (over spawnSync's 1 MB buffer, or its blob missing)
  //   refuses instead of letting the user file replace it; fails_when=a git show failure is read as "no base copy" and the
  //   unreviewed user file governs a repo that commits its policy; why_new=the user-file fallback is new; seam=none;
  //   no_claim=timeouts (they take the same failure branch)
  test('a base copy git show cannot read refuses rather than reading the user file', () => {
    const { repo, userPolicy } = setupWithBase(`{"runner": "node --test {files}"${' '.repeat(1_200_000)}}\n`);
    writePolicy(userPolicy, { local: LOCAL_ALL });
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 16, testBackend: 'local', userConfigPath: userPolicy });
    expect('refused' in loaded ? [loaded.refused.code, loaded.refused.message] : null).toEqual(['POLICY_SOURCE_UNAVAILABLE', 'origin/main:.gstack/pregate.json could not be read and git cannot confirm it is absent']);
  }, 60_000);

  // Value: protects=absence is decided from the tree, not the blob; fails_when=cat-file -e (a blob check) stands in for absence
  //   and a missing or corrupt blob lets the user file govern; why_new=the fallback is new; seam=none; no_claim=partial clones
  test('a base copy whose blob is missing refuses rather than reading the user file', () => {
    const { repo, userPolicy } = setupWithBase({ runner: 'node --test {files}' });
    const blob = repo.git('rev-parse', 'origin/main:.gstack/pregate.json');
    fs.rmSync(path.join(repo.work, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    writePolicy(userPolicy, { local: LOCAL_ALL });
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, progress: () => {}, cores: 16, testBackend: 'local', userConfigPath: userPolicy });
    expect('refused' in loaded ? loaded.refused.code : null).toBe('POLICY_SOURCE_UNAVAILABLE');
  }, 60_000);

  // Value: protects=the containment check sees through a symlinked state root and does not mistake an in-repo `..name`
  //   directory for a parent; fails_when=the realpath half or the `..`-segment test regresses and a file a PR committed is read
  //   as the user policy; why_new=both edges are new; seam=none; no_claim=case-only path differences (realpathSync.native)
  test('a state root symlinked into the checkout, or under an in-repo ..name directory, is inside', () => {
    const { repo } = setup();
    fs.mkdirSync(path.join(repo.work, '.st'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pregate-sr-'));
    try {
      const link = path.join(outside, 'root');
      fs.symlinkSync(path.join(repo.work, '.st'), link);
      expect(userConfigRejection(repo.work, path.join(link, 'projects', 'x', 'pregate.json'))).toContain('inside the repository');
      expect(userConfigRejection(repo.work, path.join(repo.work, '..st', 'projects', 'x', 'pregate.json'))).toContain('inside the repository');
      expect(userConfigRejection(repo.work, path.join(outside, 'projects', 'x', 'pregate.json'))).toBeNull();
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  // Value: protects=--explain says when the user file was looked for and absent, and names a `local` id that matches no workflow lane;
  //   fails_when=either line is dropped and a typo'd slug or lane id silently does nothing; why_new=both lines are new; seam=none;
  //   no_claim=the line wording beyond its path and id
  test('--explain names an absent user file and a local id that matches no workflow lane', () => {
    const { userPolicy, run } = setup();
    expect(run(['--explain']).out).toContain(`user policy: ${userPolicy} (absent)`);
    writePolicy(userPolicy, { local: [...LOCAL_ALL, 'ci.yml/nope'] });
    const r = run(['--explain']);
    expect(r.out).toContain('local: ci.yml/nope matches no workflow lane; ignored');
    expect(r.out).not.toContain('local: free-tests.yml/unit matches');
  }, 60_000);

  // Value: protects=with no GSTACK_PROJECT_SLUG the bin finds the user file under the slug gstack-slug resolves for the repo;
  //   fails_when=the bin computes the slug some other way (a different cwd or state root) and the documented path is never read;
  //   why_new=every other test pins GSTACK_PROJECT_SLUG; seam=none; no_claim=slug rules themselves (state-root tests cover them)
  test('the default slug path is the one gstack-slug prints', () => {
    const { repo } = setup();
    const noSlug = { GSTACK_PROJECT_SLUG: '' };
    const slug = /^SLUG=(.+)$/m.exec(runBin(repo, 'gstack-slug', [], noSlug).out)?.[1];
    expect(slug).toBeTruthy();
    const userPolicy = path.join(repo.home, 'projects', slug!, 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    writePolicy(userPolicy, { local: LOCAL_ALL });
    expect(runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'], noSlug).out).toContain(`policy user ${userPolicy}`);
  }, 60_000);

  // Value: protects=a branch's committed .env cannot choose the slug or state root behind the user policy, whether pregate is
  //   launched through scriptInvocation, by its shebang, or as a bare `bun <bin>` (which refuses on any loaded dotenv file,
  //   since Bun's syntax admits `KEY: value` and bare-CR lines a key scan misses); fails_when=Bun's dotenv
  //   loading reaches slugFromEnvironment and a branch picks which pregate.json governs it; why_new=maintainer review of #3286;
  //   seam=none; no_claim=a .env in a parent of the working directory (Bun reads the launch directory only)
  test('a committed .env cannot redirect the user policy', () => {
    const { repo } = setup();
    const env: Record<string, string | undefined> = { ...process.env, ...repo.env };
    delete env.GSTACK_PROJECT_SLUG;
    const slug = /^SLUG=(.+)$/m.exec(runScriptSync(BIN('gstack-slug'), [], { cwd: repo.work, encoding: 'utf8', env }).stdout)?.[1];
    expect(slug).toBeTruthy();
    const userPolicy = path.join(repo.home, 'projects', slug!, 'pregate.json');
    fs.mkdirSync(path.dirname(userPolicy), { recursive: true });
    writePolicy(userPolicy, { local: LOCAL_ALL });
    commit(repo, { '.env': 'GSTACK_PROJECT_SLUG=elsewhere\n' });
    const args = ['--base', 'main', '--allow-repo-commands', '--stage', 'tests'];
    expect(runScriptSync(BIN('gstack-pregate'), args, { cwd: repo.work, encoding: 'utf8', env, timeout: 120_000 }).stdout).toContain(`policy user ${userPolicy}`);
    if (process.platform !== 'win32') expect(spawnSync(BIN('gstack-pregate'), args, { cwd: repo.work, encoding: 'utf8', env, timeout: 120_000 }).stdout).toContain(`policy user ${userPolicy}`);
    const bare = spawnSync(process.execPath, [BIN('gstack-pregate'), ...args], { cwd: repo.work, encoding: 'utf8', env, timeout: 120_000 });
    expect(bare.status).toBe(EXIT.refused);
    expect(bare.stderr).toContain('POLICY_SOURCE_UNAVAILABLE');
    expect(bare.stderr).toContain('bun loaded .env from the working directory');
  }, 120_000);

  // Value: protects=a recorded pass stops verifying once the user-owned policy behind it is edited or deleted, or once a user
  //   file appears where the run used the defaults; fails_when=verify checks only the tree and a weakened or removed policy
  //   keeps an old pass publishable; why_new=maintainer review of #3286; seam=none; no_claim=a base-branch copy that changes
  //   (pinned by the recorded base, not re-read); both paths come from the record, so the verifier's environment is not read
  test('verify goes stale when the user-owned policy changes, disappears, or appears after a defaults run', () => {
    const { repo, userPolicy, run } = setup();
    const verify = () => JSON.parse(runBin(repo, 'gstack-pregate', ['verify', '--json'], { GSTACK_PROJECT_SLUG: SLUG }).out);
    writePolicy(userPolicy, { local: LOCAL_ALL });
    expect(run().status).toBe(EXIT.ok);
    expect(verify().ok).toBe(true);
    writePolicy(userPolicy, { local: ['free-tests.yml/unit'] });
    expect([verify().code, verify().message]).toEqual(['PREGATE_STALE', `the user-owned policy ${userPolicy} changed after pregate.json was recorded; rerun gstack-pregate`]);
    fs.rmSync(userPolicy);
    expect(verify().message).toContain('is gone or unreadable');
    run();
    expect(verify().code).toBe('PREGATE_REMOTE_UNCLEARED');
    writePolicy(userPolicy, { local: LOCAL_ALL });
    expect([verify().code, verify().message]).toEqual(['PREGATE_STALE', `${userPolicy} now holds a user-owned policy, and pregate.json was recorded under the defaults; rerun gstack-pregate`]);
  }, 120_000);
});

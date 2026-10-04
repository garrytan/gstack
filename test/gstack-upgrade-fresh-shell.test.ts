/**
 * C9: destructive gstack-upgrade and /spec fences in a fresh shell.
 *
 * Hosts run each fenced block in a new shell, so variables from Step 2 are
 * gone. `cd ""` succeeds and stays put, which used to point
 * `git checkout -- '*\/SKILL.md'`, `git stash` and `git reset --hard` at the
 * user's own project. Every host's render is executed with the guarded
 * variable unset, empty, missing, unreadable and pointing at the wrong
 * repository: each must exit before any mutating git command and leave the
 * scratch project byte-for-byte unchanged. Positive controls prove the guard
 * still lets a real gstack checkout through.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { runGeneration } from '../scripts/gen-skill-docs';
import { ALL_HOST_CONFIGS } from '../hosts/index';

const IS_WINDOWS = process.platform === 'win32';
let root = '';
let renders = '';

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...fixtureEnv(), ...env } });
}
function fixtureEnv(): Record<string, string> {
  return {
    HOME: join(root, 'home'),
    GIT_CONFIG_GLOBAL: join(root, 'home', '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
  };
}
function mustSh(cwd: string, cmd: string) {
  const r = sh(cwd, cmd);
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** A directory that looks like a gstack checkout (VERSION, setup, bin/gstack-config). */
function makeGstackLike(dir: string, git: boolean) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'VERSION'), '1.0.0.0\n');
  writeFileSync(join(dir, 'setup'), '#!/bin/sh\necho SETUP_RAN "$@"\n', { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'gstack-config'), '#!/bin/sh\necho false\n', { mode: 0o755 });
  if (git) mustSh(dir, 'git init -q -b main && git add -A && git commit -q -m init');
}

function bashFences(text: string): string[] {
  return [...text.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)].map(m => m[1]);
}

function fence(fences: string[], marker: string): string {
  const hits = fences.filter(f => f.includes(marker));
  if (hits.length !== 1) throw new Error(`expected one fence containing ${marker}, found ${hits.length}`);
  return hits[0];
}

const execFileAsync = promisify(execFile);
async function bashAsync(cwd: string, script: string, env: Record<string, string>) {
  try {
    const r = await execFileAsync('bash', ['-c', script], { cwd, timeout: 20_000, env: { ...process.env, ...fixtureEnv(), ...env } });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    return { status: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(error) };
  }
}

/** Tree snapshot of the scratch project: file bytes + git HEAD, index, status and stash. */
async function snapshot(dir: string): Promise<string> {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${p}\0`).update(readFileSync(p));
    }
  };
  walk(dir);
  const state = await bashAsync(dir, 'git rev-parse HEAD; git status --porcelain=v1 -uall; git stash list; git ls-files -s; git worktree list --porcelain', {});
  h.update(state.stdout);
  return h.digest('hex');
}

interface HostRender { host: string; upgrade: string[]; spec: string[]; localDir: string }
const hostRenders: HostRender[] = [];

beforeAll(async () => {
  if (IS_WINDOWS) return;
  root = mkdtempSync(join(tmpdir(), 'gstack-c9-'));
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(join(root, 'home', '.gitconfig'), '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  renders = join(root, 'render');
  const result = await runGeneration({ host: 'all', outputRoot: renders });
  if (result.exitCode !== 0) throw new Error(result.diagnostics.map(d => d.message).join('\n'));
  for (const config of ALL_HOST_CONFIGS) {
    const base = config.name === 'claude' ? renders : join(renders, config.hostSubdir, 'skills');
    const upgradePath = config.name === 'claude' ? join(base, 'gstack-upgrade', 'SKILL.md') : join(base, 'gstack-upgrade', 'SKILL.md');
    const specPath = config.name === 'claude' ? join(base, 'spec', 'sections', 'gate-and-file.md') : join(base, 'gstack-spec', 'SKILL.md');
    const upgrade = bashFences(readFileSync(upgradePath, 'utf8'));
    const spec = bashFences(readFileSync(specPath, 'utf8'));
    const team = fence(upgrade, 'git rm -r --cached');
    const localDir = team.match(/git rm -r --cached (\S+)\/ /)![1];
    hostRenders.push({ host: config.name, upgrade, spec, localDir });
  }
});

afterAll(() => {
  if (!root) return;
  spawnSync('chmod', ['-R', 'u+rwx', root], { timeout: 20_000 });
  rmSync(root, { recursive: true, force: true });
});

/** Per-host world: a user project with a vendored copy and a dirty tracked file. */
function world(host: HostRender) {
  const w = mkdtempSync(join(root, `${host.host}-`));
  const project = join(w, 'project');
  const stub = join(w, 'stub');
  mkdirSync(join(project, 'app'), { recursive: true });
  mkdirSync(stub);
  makeGstackLike(join(project, host.localDir), false);
  writeFileSync(join(project, 'app', 'SKILL.md'), 'committed\n');
  mustSh(project, 'git init -q -b main && git add -A && git commit -q -m init');
  writeFileSync(join(project, 'app', 'SKILL.md'), 'user edit in progress\n');
  writeFileSync(join(project, 'notes.txt'), 'untracked user work\n');
  const gitLog = join(w, 'git.log');
  const realGit = mustSh(w, 'command -v git').trim();
  // Logs every call; clone never reaches the network (the vendored fence would fetch GitHub).
  writeFileSync(join(stub, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${gitLog}"\n[ "$1" = clone ] && exit 128\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(stub, 'claude'), `#!/bin/sh\ncat > /dev/null\necho spawned >> "${join(w, 'claude.log')}"\n`, { mode: 0o755 });
  const gstack = join(w, 'gstack');
  makeGstackLike(gstack, true);
  mustSh(w, `git clone -q --bare gstack origin.git && cd gstack && git remote add origin "${join(w, 'origin.git')}"`);
  const plainRepo = join(w, 'plain');
  mkdirSync(join(plainRepo, 'bin'), { recursive: true });
  writeFileSync(join(plainRepo, 'VERSION'), '0.1.0\n');
  writeFileSync(join(plainRepo, 'setup'), '#!/bin/sh\n');
  mustSh(plainRepo, 'git init -q -b main && git add -A && git commit -q -m init');
  return { w, project, stub, gitLog, gstack, plainRepo };
}

async function run(wd: ReturnType<typeof world>, script: string, vars: Record<string, string | undefined>) {
  writeFileSync(wd.gitLog, '');
  const env: Record<string, string> = { PATH: `${wd.stub}:${process.env.PATH}`, GSTACK_ROOT: wd.gstack, GSTACK_BIN: join(wd.gstack, 'bin') };
  const unset: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) unset.push(k); else env[k] = v;
  }
  const r = await bashAsync(wd.project, `unset ${unset.join(' ') || '_NONE_'}\n${script}`, env);
  const gitCalls = readFileSync(wd.gitLog, 'utf8').split('\n').filter(Boolean);
  return { ...r, gitCalls };
}

const BAD_VALUES = ['unset', 'empty', 'nonexistent', 'unreadable', 'wrong-repo', 'subdirectory'] as const;
function badValue(wd: ReturnType<typeof world>, kind: typeof BAD_VALUES[number]): string | undefined {
  switch (kind) {
    case 'unset': return undefined;
    case 'empty': return '';
    case 'nonexistent': return join(wd.w, 'missing');
    case 'unreadable': {
      const locked = join(wd.w, 'locked');
      if (!existsSync(locked)) { mkdirSync(locked); chmodSync(locked, 0o000); }
      return locked;
    }
    case 'wrong-repo': return wd.plainRepo;
    case 'subdirectory': return join(wd.gstack, 'bin');
  }
}

describe.skipIf(IS_WINDOWS)('C9: destructive upgrade/spec fences refuse bad paths on every host', () => {
  type Kind = typeof BAD_VALUES[number];
  const UNUSABLE: Kind[] = ['unset', 'empty', 'nonexistent', 'unreadable'];
  const cases: Array<{ name: string; doc: 'upgrade' | 'spec'; marker: string; target: string; kinds?: Kind[]; others: (wd: ReturnType<typeof world>, h: HostRender) => Record<string, string> }> = [
    { name: 'ff-only upgrade', doc: 'upgrade', marker: 'git pull --ff-only', target: 'INSTALL_DIR', others: () => ({}) },
    { name: 'reset fallback', doc: 'upgrade', marker: 'git reset --hard origin/main', target: 'INSTALL_DIR', others: () => ({}) },
    { name: 'vendored swap', doc: 'upgrade', marker: 'git clone --depth 1', target: 'INSTALL_DIR', others: () => ({}) },
    { name: 'local copy detection', doc: 'upgrade', marker: '_RESOLVED_PRIMARY=', target: 'INSTALL_DIR', kinds: UNUSABLE, others: () => ({}) },
    { name: 'team-mode removal', doc: 'upgrade', marker: 'git rm -r --cached', target: 'LOCAL_GSTACK', others: () => ({}) },
    { name: 'vendored sync (local)', doc: 'upgrade', marker: 'LOCAL_SYNC_OK', target: 'LOCAL_GSTACK', others: (wd, h) => ({ INSTALL_DIR: wd.gstack }) },
    { name: 'vendored sync (primary)', doc: 'upgrade', marker: 'LOCAL_SYNC_OK', target: 'INSTALL_DIR', others: (wd, h) => ({ LOCAL_GSTACK: join(wd.project, h.localDir) }) },
    { name: 'spec worktree add', doc: 'spec', marker: 'git worktree add', target: 'SPAWN_PATH', kinds: ['unset', 'empty'], others: () => ({ SPAWN_BRANCH: 'spec/x-1', PIN_SHA: 'HEAD' }) },
    { name: 'spec spawn', doc: 'spec', marker: 'claude -p', target: 'SPAWN_PATH', kinds: [...UNUSABLE, 'subdirectory'], others: (wd) => ({ SPAWN_BRANCH: 'spec/x-1', ARCHIVE_PATH: join(wd.gstack, 'VERSION') }) },
  ];

  async function refusals(h: HostRender): Promise<string[]> {
    const wd = world(h);
    const failures: string[] = [];
    const baseline = await snapshot(wd.project);
    for (const c of cases) {
      const script = fence(c.doc === 'upgrade' ? h.upgrade : h.spec, c.marker);
      for (const kind of c.kinds ?? BAD_VALUES) {
        const r = await run(wd, script, { ...c.others(wd, h), [c.target]: badValue(wd, kind) });
        const mutating = r.gitCalls.filter(call => !/^rev-parse\b/.test(call));
        const changed = (await snapshot(wd.project)) !== baseline;
        const spawned = existsSync(join(wd.w, 'claude.log'));
        if (r.status === 0 || mutating.length > 0 || changed || spawned) {
          failures.push(`${h.host}: ${c.name} with ${c.target} ${kind}: exit=${r.status} git=[${mutating.join(' | ')}] changed=${changed} spawned=${spawned}\n${r.stderr.slice(0, 400)}`);
        }
      }
    }
    return failures;
  }

  test('every host: each guarded fence exits before mutating git and leaves the project unchanged', async () => {
    expect(hostRenders.length).toBe(ALL_HOST_CONFIGS.length);
    const failures = (await Promise.all(hostRenders.map(refusals))).flat();
    expect(failures).toEqual([]);
  }, 120_000);

  async function controls(h: HostRender): Promise<string[]> {
    const wd = world(h);
    const problems: string[] = [];
    const ff = await run(wd, fence(h.upgrade, 'git pull --ff-only'), { INSTALL_DIR: wd.gstack });
    if (!ff.stdout.includes('FF_OK') || !ff.gitCalls.some(c => c.startsWith('fetch'))) problems.push(`${h.host}: ff-only upgrade did not run: ${ff.stderr}`);
    const local = join(wd.project, h.localDir);
    const team = await run(wd, fence(h.upgrade, 'git rm -r --cached'), { LOCAL_GSTACK: local });
    if (team.status !== 0 || existsSync(local)) problems.push(`${h.host}: team-mode removal did not run: ${team.stderr}`);
    mustSh(wd.project, `git worktree add -q "${join(wd.w, 'wt')}" -b spec/x-1 HEAD`);
    const spawn = await run(wd, fence(h.spec, 'claude -p'), { SPAWN_PATH: join(wd.w, 'wt'), SPAWN_BRANCH: 'spec/x-1', ARCHIVE_PATH: join(wd.gstack, 'VERSION') });
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(wd.w, 'claude.log')) && Date.now() < deadline) await Bun.sleep(50);
    if (spawn.status !== 0 || !existsSync(join(wd.w, 'claude.log'))) problems.push(`${h.host}: spec spawn did not start claude: ${spawn.stderr}`);
    return problems;
  }

  test('every host: positive controls still run on a real checkout', async () => {
    const problems = (await Promise.all(hostRenders.map(controls))).flat();
    expect(problems).toEqual([]);
  }, 60_000);
});

describe.skipIf(IS_WINDOWS)('DX-7: Step 2 finds the registered source checkout for this host', () => {
  test('codex: the README ~/gstack clone recorded in the install registry is the install dir', () => {
    const step2 = fence(hostRenders.find(r => r.host === 'codex')!.upgrade, 'Install type: $INSTALL_TYPE at $INSTALL_DIR');
    const w = mkdtempSync(join(root, 'dx7-'));
    const home = join(w, 'home');
    const state = join(w, 'state');
    const clone = join(home, 'gstack');
    makeGstackLike(clone, true);
    mkdirSync(state, { recursive: true });
    // Setup's Codex runtime root carries bin/ and lib/ linked from the clone; it has no .git.
    const runtime = join(home, '.codex', 'skills', 'gstack');
    mkdirSync(join(runtime, 'bin'), { recursive: true });
    mkdirSync(join(runtime, 'lib'), { recursive: true });
    writeFileSync(join(runtime, 'bin', 'gstack-paths'), `#!/bin/sh\necho "${state}"\n`, { mode: 0o755 });
    writeFileSync(join(state, 'installs.tsv'), [
      ['claude', 'global', '-', '/x', '/x', '/elsewhere', '1.0', '-', 'committed', '0'].join('\t'),
      ['codex', 'global', '-', join(home, '.codex', 'skills'), runtime, clone, '1.0.0.0', 'false', 'committed', '0'].join('\t'),
    ].join('\n') + '\n');
    const cwd = mkdtempSync(join(w, 'cwd-'));
    const run = () => spawnSync('env', ['-i', `HOME=${home}`, `PATH=${process.env.PATH}`, 'bash', '-c', step2], { cwd, encoding: 'utf8', timeout: 20_000 });
    const r = run();
    expect(r.stdout.trim(), r.stderr).toBe(`Install type: global-git at ${clone}`);
    rmSync(join(state, 'installs.tsv'));
    expect(run().stdout).toContain('ERROR: gstack not found');
  });
});

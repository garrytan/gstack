/**
 * bin/gstack-ff-update moves a gstack install's tree: the session-start
 * updater, /gstack-upgrade Step 4 and the held-install recovery commands call
 * it. Edits that ride over the update stay in place; an edit that conflicts,
 * a staged change or an unmerged file is shelved in refs/gstack/rescue/<oid>
 * (first parent the pre-update HEAD, second the staged state) and the install
 * lands clean on the target. Nothing is ever left as conflict markers, and a
 * refusal changes nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const FF = path.join(ROOT, 'bin', 'gstack-ff-update');
const UPDATER = path.join(ROOT, 'bin', 'gstack-session-update');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}
function gitStatus(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
}
const FIXED_DATES = { GIT_AUTHOR_DATE: '2026-10-15T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-15T12:00:00Z' };

/** A bare origin, a seed that publishes releases, and an install cloned from it. */
function makeFixture(dirName = 'install') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ff-')));
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, dirName);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
  fs.mkdirSync(path.join(seed, 'qa', 'sections'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, 'notes.txt'), 'top\nmiddle\nbottom\n');
  fs.writeFileSync(path.join(seed, 'other.txt'), 'other\n');
  fs.writeFileSync(path.join(seed, 'fix.txt'), 'bug\n');
  fs.writeFileSync(path.join(seed, 'SKILL.md'), 'name: gstack\nbody\n');
  fs.writeFileSync(path.join(seed, 'qa', 'SKILL.md'), 'name: qa\nbody\n');
  fs.writeFileSync(path.join(seed, 'qa', 'sections', 'one.md'), 'one\n');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
  return { base, origin, seed, install };
}
type Fx = ReturnType<typeof makeFixture>;

function release(fx: Fx, files: Record<string, string>, version = '1.1.0'): string {
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(fx.seed, f), body);
  fs.writeFileSync(path.join(fx.seed, 'VERSION'), `${version}\n`);
  git(fx.seed, 'add', '-A');
  git(fx.seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `release ${version}`);
  git(fx.seed, 'push', '-q', 'origin', 'main');
  git(fx.install, 'fetch', '-q');
  return git(fx.seed, 'rev-parse', 'HEAD');
}

/** An environment with no user identity, no global or system git config. */
function isolatedEnv(base: string, extra: Record<string, string> = {}) {
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { PATH: process.env.PATH!, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', TMPDIR: base, ...extra };
}
function ff(fx: Fx, rev = 'origin/main', extra: Record<string, string> = {}, bin = FF, cwd = fx.base) {
  return spawnSync('bash', [bin, fx.install, rev], { cwd, encoding: 'utf8', env: isolatedEnv(fx.base, extra), timeout: 60_000 });
}
const read = (fx: Fx, f: string) => fs.readFileSync(path.join(fx.install, f), 'utf8');
const write = (fx: Fx, f: string, body: string) => fs.writeFileSync(path.join(fx.install, f), body);
/** Moves mtimes 10 s back so no entry is racily clean against the index (a same-second edit can trip the barrier's recapture). */
const backdate = (fx: Fx, ...files: string[]) => { const s = Date.now() / 1000 - 10; for (const f of files) fs.utimesSync(path.join(fx.install, f), s, s); };
const rescueRef = (out: string) => out.match(/^rescued [0-9a-f]+ [0-9a-f]+ (refs\/gstack\/rescue\/[0-9a-f]{40}) unmerged=([01])$/m);
function makeUnmerged(fx: Fx, file: string) {
  const blob = (body: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: fx.install, input: body, encoding: 'utf8', timeout: 30_000 }).trim();
  const stages = [blob('top\nmiddle\nbottom\n'), blob('top OURS\nmiddle\nbottom\n'), blob('top THEIRS\nmiddle\nbottom\n')];
  git(fx.install, 'update-index', '--force-remove', file);
  execFileSync('git', ['update-index', '--index-info'], { cwd: fx.install, timeout: 30_000, input: stages.map((s, i) => `100644 ${s} ${i + 1}\t${file}\n`).join('') });
  write(fx, file, '<<<<<<< ours\ntop OURS\n=======\ntop THEIRS\n>>>>>>> theirs\n');
}

describe.skipIf(process.platform === 'win32')('gstack-ff-update: moving the tree', () => {
  test('a clean install fast-forwards; the real index matches the target', () => {
    const fx = makeFixture();
    const target = release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const old = git(fx.install, 'rev-parse', 'HEAD');
    const r = ff(fx);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toBe(`ok ${old} ${target}\n`);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
    expect(git(fx.install, 'status', '--porcelain')).toBe('');
    expect(ff(fx).stdout).toBe(`already ${target}\n`);
  });

  test('edits that merge cleanly ride over the update unstaged, and nothing is shelved', () => {
    const fx = makeFixture();
    write(fx, 'notes.txt', 'top\nmiddle\nbottom LOCAL\n');
    write(fx, 'other.txt', 'other LOCAL\n');
    release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const r = ff(fx);
    expect(r.stdout).toMatch(/^ok /);
    expect(read(fx, 'notes.txt')).toBe('top UPSTREAM\nmiddle\nbottom LOCAL\n');
    expect(read(fx, 'other.txt')).toBe('other LOCAL\n');
    expect(git(fx.install, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(fx.install, 'diff', '--name-only').split('\n').sort()).toEqual(['notes.txt', 'other.txt']);
    expect(git(fx.install, 'for-each-ref', 'refs/gstack/rescue')).toBe('');
  });

  test('a conflicting edit is shelved: no markers, the patch holds only the person\'s delta, and an upstream fix survives restoring it', () => {
    const fx = makeFixture();
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    const target = release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n', 'fix.txt': 'fixed\n' });
    const r = ff(fx);
    expect(r.status).toBe(0);
    const m = rescueRef(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(m![2]).toBe('0');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
    expect(git(fx.install, 'status', '--porcelain')).toBe('');
    expect(read(fx, 'notes.txt')).toBe('top UPSTREAM\nmiddle\nbottom\n');
    const ref = m![1];
    expect(git(fx.install, 'diff', '--name-only', `${ref}^`, ref)).toBe('notes.txt');
    // Restore the person's edit in a scratch checkout of the target, as the banner says.
    const patch = execFileSync('git', ['diff', `${ref}^`, ref], { cwd: fx.install, encoding: 'utf8', timeout: 30_000 });
    const scratch = path.join(fx.base, 'scratch');
    execFileSync('git', ['clone', '-q', fx.origin, scratch], { timeout: 30_000 });
    const applied = spawnSync('git', ['apply', '-3'], { cwd: scratch, input: patch, encoding: 'utf8', timeout: 30_000 });
    expect(fs.readFileSync(path.join(scratch, 'fix.txt'), 'utf8')).toBe('fixed\n');
    expect(applied.status === 0 || fs.readFileSync(path.join(scratch, 'notes.txt'), 'utf8').includes('top LOCAL')).toBe(true);
    expect(fs.readFileSync(path.join(scratch, 'notes.txt'), 'utf8')).toContain('top LOCAL');
    // stderr gives the inspect, export and delete commands.
    expect(r.stderr).toContain(`show --stat '${ref}'`);
    expect(r.stderr).toContain(`diff '${ref}^' '${ref}' > ~/gstack-local-edits.patch`);
    expect(r.stderr).toContain(`update-ref -d '${ref}'`);
  });

  test('staged-only changes and differing staged and unstaged versions of one file are both kept', () => {
    const fx = makeFixture();
    write(fx, 'other.txt', 'other STAGED\n');
    git(fx.install, 'add', 'other.txt');
    write(fx, 'notes.txt', 'top STAGED\nmiddle\nbottom\n');
    git(fx.install, 'add', 'notes.txt');
    write(fx, 'notes.txt', 'top WORKTREE\nmiddle\nbottom\n');
    const indexBefore = git(fx.install, 'ls-files', '-s');
    release(fx, { 'fix.txt': 'fixed\n' });
    const r = ff(fx);
    const m = rescueRef(r.stdout);
    expect(m, r.stdout + r.stderr).not.toBeNull();
    const ref = m![1];
    expect(git(fx.install, 'show', `${ref}:notes.txt`)).toBe('top WORKTREE\nmiddle\nbottom');
    expect(git(fx.install, 'show', `${ref}^2:notes.txt`)).toBe('top STAGED\nmiddle\nbottom');
    expect(git(fx.install, 'show', `${ref}^2:other.txt`)).toBe('other STAGED');
    expect(git(fx.install, 'show', `${ref}:other.txt`)).toBe('other STAGED');
    expect(git(fx.install, 'rev-parse', `${ref}^2^`)).toBe(git(fx.install, 'rev-parse', `${ref}^`));
    expect(git(fx.install, 'status', '--porcelain')).toBe('');
    expect(indexBefore).not.toBe(git(fx.install, 'ls-files', '-s'));
  });

  test('an already-unmerged install is rescued, labelled as needing manual resolution, and lands clean', () => {
    const fx = makeFixture();
    makeUnmerged(fx, 'notes.txt');
    const target = release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const r = ff(fx);
    const m = rescueRef(r.stdout);
    expect(m, r.stdout + r.stderr).not.toBeNull();
    expect(m![2]).toBe('1');
    expect(r.stderr).toContain('needs manual resolution');
    expect(git(fx.install, 'log', '-1', '--format=%B', m![1])).toContain('Needs manual resolution');
    expect(git(fx.install, 'show', `${m![1]}:notes.txt`)).toContain('<<<<<<< ours');
    expect(git(fx.install, 'ls-files', '-u')).toBe('');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
    expect(read(fx, 'notes.txt')).toBe('top UPSTREAM\nmiddle\nbottom\n');
  });

  test('the regenerable footprint rides over when it merges and takes the target otherwise; it is never rescued', () => {
    const fx = makeFixture();
    write(fx, 'SKILL.md', 'name: gstack-prefixed\nbody\n');
    write(fx, 'qa/SKILL.md', 'name: gstack-qa\nbody\n');
    release(fx, { 'qa/SKILL.md': 'name: qa-renamed\nbody\n' });
    const r = ff(fx);
    expect(r.stdout).toMatch(/^ok /);
    expect(read(fx, 'SKILL.md')).toBe('name: gstack-prefixed\nbody\n');
    expect(read(fx, 'qa/SKILL.md')).toBe('name: qa-renamed\nbody\n');
    expect(git(fx.install, 'for-each-ref', 'refs/gstack/rescue')).toBe('');
  });

  test('an untracked file in the way refuses with autostash-unrecoverable and changes nothing', () => {
    const fx = makeFixture();
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    release(fx, { 'new.txt': 'upstream new\n' });
    write(fx, 'new.txt', 'mine\n');
    const head = git(fx.install, 'rev-parse', 'HEAD');
    const r = ff(fx);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/^autostash-unrecoverable: git refused to update /);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(head);
    expect(read(fx, 'new.txt')).toBe('mine\n');
    expect(read(fx, 'notes.txt')).toBe('top LOCAL\nmiddle\nbottom\n');
    expect(git(fx.install, 'for-each-ref', 'refs/gstack/rescue')).toBe('');
    expect(fs.existsSync(path.join(fx.install, '.git', 'index.lock'))).toBe(false);
  });

  test('an edit written between the capture and the move is refused and kept (barrier)', () => {
    const fx = makeFixture();
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const head = git(fx.install, 'rev-parse', 'HEAD');
    // The first commit-tree (the rescue's staged-state commit) runs after the
    // capture and before the move: the shim writes a late edit right then.
    const shimDir = path.join(fx.base, 'barrier');
    fs.mkdirSync(shimDir);
    const real = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 30_000 }).trim(), 'git');
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/bash\ncase " $* " in *" commit-tree "*) [ -e "${fx.base}/barrier.done" ] || { echo LATE >> "${fx.install}/other.txt"; : > "${fx.base}/barrier.done"; } ;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const r = ff(fx, 'origin/main', { PATH: `${shimDir}:${process.env.PATH}` });
    expect(r.status, r.stdout).toBe(3);
    expect(r.stdout).toContain('changed while the update ran');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(head);
    expect(read(fx, 'other.txt')).toBe('other\nLATE\n');
    expect(read(fx, 'notes.txt')).toBe('top LOCAL\nmiddle\nbottom\n');
    expect(git(fx.install, 'for-each-ref', 'refs/gstack/rescue')).toBe('');
  });

  test('rescue refs are compare-and-create: same-second recoveries, an identical rescue, and a pre-existing ref', () => {
    const fx = makeFixture();
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const head = git(fx.install, 'rev-parse', 'HEAD');
    const copies = ['a', 'b', 'c'].map((n) => { const d = path.join(fx.base, `copy-${n}`); fs.cpSync(fx.install, d, { recursive: true }); return d; });
    // Same second, same content: the same oid, and a second run reuses the ref.
    const first = ff({ ...fx, install: copies[0] }, 'origin/main', FIXED_DATES);
    const ref = rescueRef(first.stdout)![1];
    fs.writeFileSync(path.join(copies[1], 'notes.txt'), 'top OTHER\nmiddle\nbottom\n');
    const second = ff({ ...fx, install: copies[1] }, 'origin/main', FIXED_DATES);
    expect(rescueRef(second.stdout)![1]).not.toBe(ref);
    // A pre-existing ref with this rescue's name and another commit: refused.
    git(copies[2], 'update-ref', ref, head);
    const third = ff({ ...fx, install: copies[2] }, 'origin/main', FIXED_DATES);
    expect(third.status).toBe(3);
    expect(third.stdout).toContain(`rescue ref ${ref} already exists and names another commit`);
    expect(git(copies[2], 'rev-parse', ref)).toBe(head);
    expect(git(copies[2], 'rev-parse', 'HEAD')).toBe(head);
    // The same ref already naming this very rescue is accepted.
    git(fx.install, 'fetch', '-q', copies[0], `${ref}:${ref}`);
    const again = ff(fx, 'origin/main', FIXED_DATES);
    expect(again.status, again.stdout).toBe(0);
    expect(rescueRef(again.stdout)![1]).toBe(ref);
  });

  test('rescue commits carry gstack\'s own identity with no user config at all', () => {
    const fx = makeFixture();
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    // The real git binary first on PATH: a host wrapper that injects its own
    // identity must not stand in for what the bin asks for.
    const realDir = path.join(fx.base, 'real-git');
    fs.mkdirSync(realDir);
    fs.symlinkSync(path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 30_000 }).trim(), 'git'), path.join(realDir, 'git'));
    const r = ff(fx, 'origin/main', { PATH: `${realDir}:${process.env.PATH}` });
    const ref = rescueRef(r.stdout)![1];
    expect(git(fx.install, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', ref)).toBe('gstack rescue <gstack@localhost>|gstack rescue <gstack@localhost>');
  });

  // Value: protects=the one move every upgrade path shares refuses (exit 6, nothing changed) when an enclosing project tracks the install or
  //   VERSION was put back behind HEAD, even with nothing to move (#1022); fails_when=the preflight is skipped, runs after "already", or counts a gitlink;
  //   why_new=no case had an enclosing project; seam=none
  test('preflight: a tracking project or a reverted VERSION refuses with exit 6 and changes nothing; a gitlink and --preflight on a clean install pass', () => {
    const fx = makeFixture();
    const old = git(fx.install, 'rev-parse', 'HEAD');
    expect(spawnSync('bash', [FF, '--preflight', fx.install], { encoding: 'utf8', env: isolatedEnv(fx.base), timeout: 60_000 }).status).toBe(0);
    git(fx.base, 'init', '-q', '-b', 'main');
    git(fx.base, 'update-index', '--add', '--cacheinfo', `160000,${old},install`);
    expect(spawnSync('bash', [FF, '--preflight', fx.install], { encoding: 'utf8', env: isolatedEnv(fx.base), timeout: 60_000 }).status).toBe(0);
    git(fx.base, 'update-index', '--force-remove', 'install');
    git(fx.base, 'update-index', '--add', '--', 'install/VERSION', 'install/notes.txt');
    release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const tracked = ff(fx);
    expect(tracked.status, tracked.stdout + tracked.stderr).toBe(6);
    expect(tracked.stdout).toStartWith(`tracked-by-project: ${fx.base} tracks 2 files of the gstack install at install,`);
    expect(tracked.stdout.trim().split('\n')).toHaveLength(1);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(old);
    fs.rmSync(path.join(fx.base, '.git'), { recursive: true, force: true });
    expect(ff(fx).status).toBe(0);
    write(fx, 'VERSION', '1.0.0\n');
    const reverted = ff(fx);
    expect(reverted.status).toBe(6);
    expect(reverted.stdout).toStartWith('version-reverted: VERSION says 1.0.0 but the checkout is at 1.1.0');
    expect(read(fx, 'VERSION')).toBe('1.0.0\n');
    write(fx, 'VERSION', '9.9.9\n');
    expect(ff(fx).stdout).toStartWith('version-reverted: VERSION says 9.9.9 but the checkout is at 1.1.0: files changed outside git');
  });

  // Value: protects=an unmerged VERSION still takes the existing rescue, which the unmerged-files banner's command relies on;
  //   fails_when=the version-reverted preflight fires on conflict markers; why_new=the preflight is new; seam=none
  test('preflight: an unmerged VERSION is rescued, not refused as version-reverted', () => {
    const fx = makeFixture();
    makeUnmerged(fx, 'VERSION');
    const target = release(fx, { 'notes.txt': 'x\n' });
    const r = ff(fx, target);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^rescued .* unmerged=1/);
  });

  // Value: protects=the preflight runs no code from the enclosing project (its core.fsmonitor hook); fails_when=an enclosing-repo git call
  //   drops the fsmonitor override; why_new=the enclosing-project probe is new; seam=none
  test('preflight: an enclosing project\'s core.fsmonitor hook never runs', () => {
    const fx = makeFixture();
    const sentinel = path.join(fx.base, 'fsmonitor-ran');
    git(fx.base, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(fx.base, 'hook.sh'), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
    git(fx.base, 'config', 'core.fsmonitor', path.join(fx.base, 'hook.sh'));
    const r = spawnSync('bash', [FF, '--preflight', fx.install], { encoding: 'utf8', env: isolatedEnv(fx.base), timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  // Value: protects=the printed repair untracks only the install, even when its name holds glob characters, and prints whole at any path length;
  //   fails_when=the rm drops --literal-pathspecs, the ignore rule is unescaped, or the message is capped short; why_new=review pass 1; seam=none
  test('preflight: the tracked-by-project repair is literal and printed whole', () => {
    const fx = makeFixture(`gstack*${'x'.repeat(150)}`);
    const name = path.basename(fx.install);
    git(fx.base, 'init', '-q', '-b', 'main');
    const decoy = `gstack-data${'x'.repeat(150)}`;
    fs.writeFileSync(path.join(fx.base, decoy), 'keep\n');
    git(fx.base, 'add', '--', decoy);
    git(fx.base, 'update-index', '--add', '--', `${name}/VERSION`);
    const r = spawnSync('bash', [FF, '--preflight', fx.install], { encoding: 'utf8', env: isolatedEnv(fx.base), timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(6);
    expect(r.stdout.trimEnd()).toEndWith('and re-run');
    expect(r.stdout).toContain(`add /gstack\\*${'x'.repeat(150)}/ to`);
    const rm = r.stdout.match(/fix: (git -C .*? rm -r -q --cached -- '[^']*')/)?.[1];
    expect(rm).toContain('--literal-pathspecs');
    expect(spawnSync('bash', ['-c', rm!], { encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    expect(git(fx.base, 'ls-files').split('\n')).toEqual([decoy]);
  });

  // Value: protects=a dirty VERSION beside an unmerged file still takes the rescue (stash cannot run there); a VERSION that differs only in mode is no
  //   revert; a held lock wins over the VERSION check; fails_when=the check looks only at VERSION's own stage, compares bytes, or runs before the lock;
  //   why_new=review pass 1; seam=none
  test('preflight: version-reverted yields to the rescue, to a same-text VERSION, and to a held lock', () => {
    const fx = makeFixture();
    makeUnmerged(fx, 'notes.txt');
    write(fx, 'VERSION', '0.9.0\n');
    backdate(fx, 'VERSION', 'notes.txt');
    const mixed = ff(fx, release(fx, { 'other.txt': 'x\n' }));
    expect(mixed.status, mixed.stdout + mixed.stderr).toBe(0);
    expect(mixed.stdout).toMatch(/^rescued .* unmerged=1/);

    const fy = makeFixture();
    fs.chmodSync(path.join(fy.install, 'VERSION'), 0o755);
    expect(spawnSync('bash', [FF, '--preflight', fy.install], { encoding: 'utf8', env: isolatedEnv(fy.base), timeout: 60_000 }).status).toBe(0);

    const fz = makeFixture();
    release(fz, { 'other.txt': 'x\n' });
    write(fz, 'VERSION', '0.9.0\n');
    const holder = spawn('sleep', ['30']);
    try {
      const lock = path.join(fz.install, '.git', 'gstack-ff.lock');
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), `${holder.pid}\n`);
      expect(ff(fz, 'origin/main', { GSTACK_FF_LOCK_WAIT: '0' }).status).toBe(75);
      expect(spawnSync('bash', [FF, '--preflight', fz.install], { encoding: 'utf8', env: isolatedEnv(fz.base), timeout: 60_000 }).status).toBe(6);
    } finally {
      holder.kill();
    }
  });

  // Value: protects=a move interrupted after the tree was written but before HEAD moved still finishes on the next run, not held as
  //   version-reverted; fails_when=the in-lock check ignores the target's VERSION; why_new=review pass 2; seam=none
  test('an interrupted move (tree at the target, HEAD old) finishes instead of holding', () => {
    const fx = makeFixture();
    const target = release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    execFileSync('bash', ['-c', `git archive ${target} | tar -x`], { cwd: fx.install, timeout: 30_000 });
    expect(read(fx, 'VERSION')).toBe('1.1.0\n');
    backdate(fx, 'VERSION', 'notes.txt');
    const r = ff(fx, target);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
    expect(spawnSync('bash', [FF, '--preflight', fx.install], { encoding: 'utf8', env: isolatedEnv(fx.base), timeout: 60_000 }).status).toBe(0);
  });

  test('refusals: not a fast-forward, an unresolvable target, and a missing checkout', () => {
    const fx = makeFixture();
    write(fx, 'VERSION', 'local\n');
    git(fx.install, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'local');
    release(fx, { 'notes.txt': 'x\n' });
    const head = git(fx.install, 'rev-parse', 'HEAD');
    const nf = ff(fx);
    expect(nf.status).toBe(4);
    expect(nf.stdout).toMatch(/^not-fast-forward: /);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(head);
    expect(ff(fx, 'no-such-rev').status).toBe(2);
    expect(spawnSync('bash', [FF, path.join(fx.base, 'missing'), 'HEAD'], { encoding: 'utf8', timeout: 30_000 }).stdout).toMatch(/^not-a-checkout: /);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-ff-update: the install-scoped lock', () => {
  test('lives in the absolute git common dir, shared by a linked worktree, never in the caller\'s project', () => {
    const fx = makeFixture();
    release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const wt = path.join(fx.base, 'linked');
    git(fx.install, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    const project = path.join(fx.base, 'project');
    fs.mkdirSync(project);
    // A live holder in the common dir blocks an update started from the linked worktree.
    const holder = spawn('sleep', ['30']);
    try {
      const lock = path.join(fx.install, '.git', 'gstack-ff.lock');
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), `${holder.pid}\n`);
      const r = spawnSync('bash', [FF, wt, 'origin/main'], { cwd: project, encoding: 'utf8', env: isolatedEnv(fx.base, { GSTACK_FF_LOCK_WAIT: '0' }), timeout: 30_000 });
      expect(r.status).toBe(75);
      expect(r.stdout).toContain(`ff-busy: another gstack update is moving ${wt} (lock ${lock} held by pid ${holder.pid})`);
      expect(fs.readdirSync(project)).toEqual([]);
      expect(fs.existsSync(path.join(wt, 'gstack-ff.lock'))).toBe(false);
      // A dead holder is reclaimed.
      fs.writeFileSync(path.join(lock, 'pid'), '999999\n');
      const ok = spawnSync('bash', [FF, wt, 'origin/main'], { cwd: project, encoding: 'utf8', env: isolatedEnv(fx.base, { GSTACK_FF_LOCK_WAIT: '0' }), timeout: 30_000 });
      expect(ok.status, ok.stdout).toBe(0);
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readdirSync(project)).toEqual([]);
    } finally {
      holder.kill();
    }
  });

  test('a live holder that outlasts the TTL keeps its lock through the heartbeat', async () => {
    const fx = makeFixture();
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const shimDir = path.join(fx.base, 'slow');
    fs.mkdirSync(shimDir);
    const real = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 30_000 }).trim(), 'git');
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/bash\ncase " $* " in *" commit-tree "*) : > "${fx.base}/slow.started"; sleep 4 ;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const lock = path.join(fx.install, '.git', 'gstack-ff.lock');
    const holder = spawn('bash', [FF, fx.install, 'origin/main'], { env: isolatedEnv(fx.base, { PATH: `${shimDir}:${process.env.PATH}`, GSTACK_FF_HEARTBEAT_SECONDS: '1' }) });
    const done = new Promise<number | null>((resolve) => holder.on('exit', resolve));
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(path.join(fx.base, 'slow.started')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    // The pidfile looks 40 minutes old; the holder's next beat freshens it.
    const past = new Date(Date.now() - 40 * 60 * 1000);
    fs.utimesSync(path.join(lock, 'pid'), past, past);
    await new Promise((r) => setTimeout(r, 1600));
    const contender = spawnSync('bash', [FF, fx.install, 'origin/main'], { encoding: 'utf8', env: isolatedEnv(fx.base, { GSTACK_FF_LOCK_WAIT: '0' }), timeout: 30_000 });
    expect(contender.status, contender.stdout).toBe(75);
    expect(await done).toBe(0);
    expect(fs.existsSync(lock)).toBe(false);
    expect(git(fx.install, 'ls-files', '-u')).toBe('');
  }, 30_000);

  test('the heartbeat and its sleeper are reaped when the bin exits', () => {
    const fx = makeFixture();
    release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const beat = String(3000 + (process.pid % 997));
    const sleepers = (delay = '') => execFileSync('bash', ['-c', `${delay}pgrep -f "^sleep ${beat}$" | wc -l`], { encoding: 'utf8', timeout: 30_000 }).trim();
    const before = sleepers();
    expect(before).toBe('0');
    expect(ff(fx, 'origin/main', { GSTACK_FF_HEARTBEAT_SECONDS: beat }).status).toBe(0);
    expect(sleepers('sleep 0.3; ')).toBe(before);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-ff-update: callers', () => {
  test('/gstack-upgrade Step 4 racing a background updater (two state roots) leaves one clean result and no lost edit', async () => {
    const fx = makeFixture();
    fs.mkdirSync(path.join(fx.seed, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(fx.seed, 'bin', 'gstack-config'), '#!/usr/bin/env bash\n[ "$1" = get ] && [ "$2" = auto_upgrade ] && echo true\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fx.seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fx.seed, 'setup'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const target = release(fx, { 'notes.txt': 'top\nmiddle\nbottom\n' }, '1.0.1');
    git(fx.install, 'merge', '-q', '--ff-only', 'origin/main');
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    const incoming = release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    expect(incoming).not.toBe(target);
    const stateA = path.join(fx.base, 'state-a');
    const stateB = path.join(fx.base, 'state-b');
    fs.mkdirSync(stateA); fs.mkdirSync(stateB);
    const env = (state: string) => ({ ...isolatedEnv(fx.base), PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, GSTACK_DIR: fx.install, GSTACK_STATE_ROOT: state });
    const bg = spawnSync('bash', [UPDATER], { encoding: 'utf8', env: env(stateA), timeout: 30_000 });
    expect(bg.status).toBe(0);
    const step4 = spawnSync('bash', [FF, fx.install, 'origin/main'], { encoding: 'utf8', env: env(stateB), timeout: 60_000 });
    const log = path.join(stateA, 'analytics', 'session-update.log');
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !/UPDATED|UP_TO_DATE|SKIP ff_busy|PULL_FAILED|HELD/.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')) await new Promise((r) => setTimeout(r, 100));
    while (fs.existsSync(path.join(stateA, '.setup-lock')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect([0, 75]).toContain(step4.status ?? -1);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(incoming);
    expect(git(fx.install, 'ls-files', '-u')).toBe('');
    expect(read(fx, 'notes.txt')).toBe('top UPSTREAM\nmiddle\nbottom\n');
    const refs = git(fx.install, 'for-each-ref', '--format=%(refname)', 'refs/gstack/rescue').split('\n').filter(Boolean);
    expect(refs).toHaveLength(1);
    expect(git(fx.install, 'show', `${refs[0]}:notes.txt`)).toBe('top LOCAL\nmiddle\nbottom');
  }, 60_000);

  test('/gstack-upgrade Step 4\'s git block leaves no conflict markers: FF_OK with the edit in a rescue ref', () => {
    const fx = makeFixture();
    for (const f of ['setup', 'bin/gstack-config']) {
      fs.mkdirSync(path.join(fx.seed, path.dirname(f)), { recursive: true });
      fs.writeFileSync(path.join(fx.seed, f), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    fs.copyFileSync(FF, path.join(fx.seed, 'bin', 'gstack-ff-update'));
    const base = release(fx, {}, '1.0.1');
    git(fx.install, 'merge', '-q', '--ff-only', base);
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    const target = release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const tmpl = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md.tmpl'), 'utf8');
    const block = tmpl.slice(tmpl.indexOf('**For git installs**')).match(/```bash\n([\s\S]*?)\n```/)![1]!.replaceAll('{{SETUP_COMMAND}}', './setup');
    const r = spawnSync('bash', ['-c', block], { cwd: fx.base, encoding: 'utf8', env: { ...isolatedEnv(fx.base), INSTALL_DIR: fx.install }, timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('FF_OK');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
    expect(git(fx.install, 'ls-files', '-u')).toBe('');
    expect(read(fx, 'notes.txt')).toBe('top UPSTREAM\nmiddle\nbottom\n');
    const ref = rescueRef(r.stdout)![1];
    expect(git(fx.install, 'show', `${ref}:notes.txt`)).toBe('top LOCAL\nmiddle\nbottom');
  });

  test('the bin copied outside any checkout recovers an install that has no gstack-ff-update', () => {
    const fx = makeFixture();
    write(fx, 'notes.txt', 'top LOCAL\nmiddle\nbottom\n');
    const target = release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n' });
    const outside = path.join(fx.base, 'outside');
    fs.mkdirSync(outside);
    fs.copyFileSync(FF, path.join(outside, 'gstack-ff-update'));
    const r = spawnSync('bash', [path.join(outside, 'gstack-ff-update'), '.', 'origin/main'], { cwd: fx.install, encoding: 'utf8', env: isolatedEnv(fx.base), timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(rescueRef(r.stdout)).not.toBeNull();
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
  });
});

describe('gstack-ff-update: self-contained, with twins pinned', () => {
  const ffSrc = fs.readFileSync(FF, 'utf8');
  const updSrc = fs.readFileSync(UPDATER, 'utf8');
  const fn = (src: string, name: string) => src.match(new RegExp(`\\n( *)${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\1\\}\\n`))?.[0].replace(/^\n/, '').replace(/^ +/gm, '').replace(/^#.*\n/gm, '');

  test('sources nothing', () => {
    expect(ffSrc).not.toMatch(/^\s*(\.|source)\s/m);
  });

  test('ff_flatten is byte-identical to the updater\'s', () => {
    expect(fn(ffSrc, 'ff_flatten')).toBeDefined();
    expect(fn(ffSrc, 'ff_flatten')).toBe(fn(updSrc, 'ff_flatten'));
  });

  test('the lock keeps the updater\'s TTL check, atomic mv-aside reap and heartbeat reaping', () => {
    expect(fn(ffSrc, 'lock_is_expired')).toBe(fn(updSrc, 'lock_is_expired'));
    expect(fn(ffSrc, 'cleanup_heartbeat')).toBe(fn(updSrc, 'cleanup_heartbeat'));
    expect(ffSrc).toContain('mv "$LOCK_DIR" "$LOCK_DIR.reap.$$" 2>/dev/null || return 1');
    expect(updSrc).toContain('mv "$LOCK_DIR" "$LOCK_DIR.reap.$$" 2>/dev/null ||');
    expect(ffSrc).toContain('[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$MYPID" ] && rm -rf "$LOCK_DIR" 2>/dev/null');
  });

  test.skipIf(process.platform === 'win32')('ff_flatten flattens newlines and strips control characters and escape sequences', () => {
    const r = spawnSync('bash', ['-c', `eval "$(sed -n '/^ff_flatten() {/,/^}/p' "${FF}")"; ff_flatten "$(printf 'bad\\nstages=x \\033[31mred\\033[0m\\001end')" 200`], { encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout).toBe('bad stages=x redend');
  });
});

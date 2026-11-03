/**
 * The session-start lines for a held update, a stage that did not finish and
 * edits a recovery shelved. Each hold reason has its own line naming the exact
 * command and a troubleshooting anchor; the hold prints before the stage line;
 * no setup fix prints while the install has unmerged files; every path is
 * shell-quoted. The emitted commands are executed here against an install
 * whose path holds a space and an apostrophe.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-session-update');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'troubleshooting.md'), 'utf8');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

function makeFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-banner-')));
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, "it's an install");
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
  fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, 'notes.txt'), 'top\nmiddle\nbottom\n');
  fs.writeFileSync(path.join(seed, 'bin', 'gstack-config'),
    '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; *) echo "";; esac; fi\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.copyFileSync(path.join(ROOT, 'bin', 'gstack-ff-update'), path.join(seed, 'bin', 'gstack-ff-update'));
  fs.writeFileSync(path.join(seed, 'setup'), '#!/usr/bin/env bash\necho "$*" >> "$SETUP_CALLS"\nexit 0\n', { mode: 0o755 });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
  return { base, seed, install, state, home, calls: path.join(base, 'calls') };
}
type Fx = ReturnType<typeof makeFixture>;

function release(fx: Fx, notes: string, version = '1.1.0'): string {
  fs.writeFileSync(path.join(fx.seed, 'notes.txt'), notes);
  fs.writeFileSync(path.join(fx.seed, 'VERSION'), `${version}\n`);
  git(fx.seed, 'add', '-A');
  git(fx.seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `release ${version}`);
  git(fx.seed, 'push', '-q', 'origin', 'main');
  return git(fx.seed, 'rev-parse', 'HEAD');
}
const env = (fx: Fx, extra: Record<string, string> = {}) => ({
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: fx.home, GSTACK_DIR: fx.install, GSTACK_STATE_ROOT: fx.state, SETUP_CALLS: fx.calls, TMPDIR: fx.base, ...extra,
});
/** One session start in the foreground only (the throttle keeps the background check off). */
function banner(fx: Fx): string {
  fs.writeFileSync(path.join(fx.state, '.last-session-update'), `${Math.floor(Date.now() / 1000)}\n`);
  return spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: env(fx), timeout: 20_000 }).stdout;
}
function pending(fx: Fx, fields: Record<string, string>) {
  const all = { stages: '', from: '', failures: '0', next: '0', reason: '', pull: '', ...fields };
  fs.writeFileSync(path.join(fx.state, 'session-update-pending'), Object.entries(all).map(([k, v]) => `${k}=${v}\n`).join(''));
}
/** The command after "Fix now (…):", up to the closing `./setup`. */
function fixCommand(line: string): string {
  const m = line.match(/Fix now \(in a terminal; Git Bash on Windows\): (.*?&& \.\/setup)/);
  expect(m, line).not.toBeNull();
  return m![1];
}
function run(fx: Fx, command: string, extra: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', command], { cwd: fx.base, encoding: 'utf8', env: env(fx, extra), timeout: 60_000 });
}
async function waitFor(fx: Fx, pattern: RegExp, ms = 30_000): Promise<string> {
  const logFile = path.join(fx.state, 'analytics', 'session-update.log');
  const deadline = Date.now() + ms;
  let content = '';
  while (Date.now() < deadline) {
    content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (pattern.test(content) && !fs.existsSync(path.join(fx.state, '.setup-lock'))) return content;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${pattern}; log:\n${content}`);
}
const quoted = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

describe.skipIf(process.platform === 'win32')('gstack-session-update: held-update lines', () => {
  test('hook-check-unavailable: the hold prints before the stage line, and its command updates the install', () => {
    const fx = makeFixture();
    const target = release(fx, 'top UPSTREAM\nmiddle\nbottom\n');
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top\nmiddle\nbottom LOCAL\n');
    pending(fx, { stages: 'setup', reason: 'bun not found on PATH', pull: 'hook-check-unavailable: cannot extract the incoming revision: tar: x' });
    const lines = banner(fx).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('gstack auto-update: update held (hook-check-unavailable: cannot extract the incoming revision: tar: x)');
    expect(lines[0]).toContain('troubleshooting.md#auto-update-hook-check-unavailable');
    expect(lines[1]).toContain(`setup did not finish (bun not found on PATH)`);
    expect(lines[1]).toContain(`then cd ${quoted(fx.install)} && ./setup`);
    const cmd = fixCommand(lines[0]);
    expect(cmd).toBe(`cd ${quoted(fx.install)} && git fetch origin && bash bin/gstack-ff-update . '@{upstream}' && ./setup`);
    const r = run(fx, cmd);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
    expect(fs.readFileSync(path.join(fx.install, 'notes.txt'), 'utf8')).toBe('top UPSTREAM\nmiddle\nbottom LOCAL\n');
    expect(fs.readFileSync(fx.calls, 'utf8')).toBe('\n');
  });

  test('unmerged files: no stage fix prints, and the command rescues them before it updates', () => {
    const fx = makeFixture();
    const target = release(fx, 'top UPSTREAM\nmiddle\nbottom\n');
    const blob = (body: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: fx.install, input: body, encoding: 'utf8', timeout: 30_000 }).trim();
    const stages = [blob('top\nmiddle\nbottom\n'), blob('top OURS\nmiddle\nbottom\n'), blob('top THEIRS\nmiddle\nbottom\n')];
    git(fx.install, 'update-index', '--force-remove', 'notes.txt');
    execFileSync('git', ['update-index', '--index-info'], { cwd: fx.install, timeout: 30_000, input: stages.map((s, i) => `100644 ${s} ${i + 1}\tnotes.txt\n`).join('') });
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), '<<<<<<< ours\ntop OURS\n=======\ntop THEIRS\n>>>>>>> theirs\n');
    pending(fx, { stages: 'setup', reason: './setup exited 1', pull: '' });
    const out = banner(fx);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(out).not.toContain('did not finish');
    expect(lines[0]).toContain('update held (unmerged-files: the install has unmerged files (first: notes.txt))');
    expect(lines[0]).toContain('troubleshooting.md#auto-update-unmerged-files');
    const r = run(fx, fixCommand(lines[0]));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(fx.install, 'ls-files', '-u')).toBe('');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
    const ref = git(fx.install, 'for-each-ref', '--format=%(refname)', 'refs/gstack/rescue');
    expect(git(fx.install, 'show', `${ref}:notes.txt`)).toContain('<<<<<<< ours');
  });

  test('autostash-unrecoverable: inspection first, then the command once the cause is gone', () => {
    const fx = makeFixture();
    const target = release(fx, 'top UPSTREAM\nmiddle\nbottom\n');
    pending(fx, { pull: 'autostash-unrecoverable: git refused to update x: untracked new.txt would be overwritten' });
    const out = banner(fx).trim();
    expect(out).toContain(`Look first: git -C ${quoted(fx.install)} status --short.`);
    expect(out).toContain('troubleshooting.md#auto-update-autostash-unrecoverable');
    expect(run(fx, `git -C ${quoted(fx.install)} status --short`).status).toBe(0);
    const r = run(fx, fixCommand(out));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
  });

  test('bun-too-old: Bun is upgraded first, then the same command', () => {
    const fx = makeFixture();
    const target = release(fx, 'top UPSTREAM\nmiddle\nbottom\n');
    pending(fx, { pull: 'bun-too-old: found Bun 1.3.2 at /x/bun; gstack 1.1.0 needs 1.3.3 or newer' });
    const out = banner(fx).trim();
    const m = out.match(/Fix now \(in a terminal; Git Bash on Windows\): (bun upgrade && .*&& \.\/setup)$/);
    expect(m, out).not.toBeNull();
    const stub = path.join(fx.base, 'bun-stub');
    fs.mkdirSync(stub);
    fs.writeFileSync(path.join(stub, 'bun'), `#!/usr/bin/env bash\necho "$*" >> "${fx.base}/bun-calls"\n`, { mode: 0o755 });
    const r = run(fx, m![1], { PATH: `${stub}:${process.env.PATH}` });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(fx.base, 'bun-calls'), 'utf8')).toBe('upgrade\n');
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
  });

  // Value: protects=the auto-updater holds, instead of rescuing and re-updating forever, an install whose enclosing project tracks its files (#1022);
  //   fails_when=gstack-ff-update's exit 6 is not a hold, or the banner's command does not print the full fix; why_new=no case had an enclosing project; seam=none
  test('tracked-by-project: the update holds with HEAD unchanged; the banner names the preflight, which prints the full fix', async () => {
    const fx = makeFixture();
    const old = git(fx.install, 'rev-parse', 'HEAD');
    release(fx, 'top UPSTREAM\nmiddle\nbottom\n');
    git(fx.base, 'init', '-q', '-b', 'main');
    git(fx.base, 'update-index', '--add', '--', ...git(fx.install, 'ls-files').split('\n').map((f) => `it's an install/${f}`));
    spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: env(fx), timeout: 20_000 });
    await waitFor(fx, /Z HELD tracked-by-project: /);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(old);
    expect(git(fx.install, 'for-each-ref', 'refs/gstack/rescue')).toBe('');
    const lines = banner(fx).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(`gstack auto-update: update held (tracked-by-project: ${fx.base} tracks`);
    expect(lines[0]).toContain('troubleshooting.md#auto-update-tracked-by-project');
    const cmd = lines[0].match(/The full fix: (bash .*?)\. https:/)![1];
    const r = run(fx, cmd);
    expect(r.status).toBe(6);
    expect(r.stdout).toContain(`git -C ${quoted(fx.base)} --literal-pathspecs rm -r -q --cached -- ${quoted("it's an install")}`);
  });

  // Value: protects=a project holding the install as a submodule gitlink keeps auto-updating; fails_when=the #1022 check counts a gitlink;
  //   why_new=negative control for the case above; seam=none
  test('a gitlink in the enclosing project is not a hold: the update lands', async () => {
    const fx = makeFixture();
    const target = release(fx, 'top UPSTREAM\nmiddle\nbottom\n');
    git(fx.base, 'init', '-q', '-b', 'main');
    git(fx.base, 'update-index', '--add', '--cacheinfo', `160000,${git(fx.install, 'rev-parse', 'HEAD')},it's an install`);
    spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: env(fx), timeout: 20_000 });
    await waitFor(fx, /Z UPDATED /);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);
  });

  // Value: protects=a VERSION behind HEAD with no enclosing project holds (not rescued) and its preflight prints the stash fix;
  //   fails_when=session-update's exit-6 arm drops version-reverted; why_new=review pass 2; seam=none
  test('version-reverted: the update holds with HEAD unchanged; the preflight prints the stash fix', async () => {
    const fx = makeFixture();
    const old = git(fx.install, 'rev-parse', 'HEAD');
    release(fx, 'top UPSTREAM\nmiddle\nbottom\n');
    fs.writeFileSync(path.join(fx.install, 'VERSION'), '0.0.1\n');
    spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: env(fx), timeout: 20_000 });
    await waitFor(fx, /Z HELD version-reverted: /);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(old);
    expect(git(fx.install, 'for-each-ref', 'refs/gstack/rescue')).toBe('');
    const line = banner(fx).trim();
    expect(line).toStartWith('gstack auto-update: update held (version-reverted: VERSION says 0.0.1 but the checkout is at 1.0.0');
    const r = run(fx, line.match(/The full fix: (bash .*?)\. https:/)![1]);
    expect(r.status).toBe(6);
    expect(r.stdout).toContain(`git -C ${quoted(fx.install)} stash push`);
  });

  test('every anchor the lines link to exists', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const anchors = [...src.matchAll(/troubleshooting\.md#([a-z0-9-]+)/g)].map((m) => m[1]!);
    for (const a of ['auto-update-unmerged-files', 'auto-update-autostash-unrecoverable', 'auto-update-rescued-edits', 'auto-update-tracked-by-project']) expect(anchors).toContain(a);
    for (const a of anchors) expect(DOC, a).toContain(`<a id="${a}"></a>`);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-session-update: shelved edits are never silent', () => {
  test('background rescue, then a daily line naming the files and the ref; its commands inspect, export only the delta, and delete', async () => {
    const fx = makeFixture();
    fs.writeFileSync(path.join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
    const target = release(fx, 'top UPSTREAM\nmiddle\nbottom\n');
    spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: env(fx), timeout: 20_000 });
    const log = await waitFor(fx, /Z UPDATED /);
    const ref = log.match(/kept_ref=(refs\/gstack\/rescue\/[0-9a-f]{40})/)![1];
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(target);

    // Background → foreground: the next session start names it.
    const first = banner(fx).trim();
    expect(first).toContain(`your local edits in the install (notes.txt) conflicted with an update, so they were saved in ${ref}`);
    expect(first).toContain('troubleshooting.md#auto-update-rescued-edits');
    // Once a day: the next session start the same day is quiet.
    expect(banner(fx)).toBe('');

    const show = first.match(/Inspect \(in a terminal; Git Bash on Windows\): (git -C .*? show --stat '[^']+')\./)![1];
    expect(run(fx, show).stdout).toContain('notes.txt');
    const exp = first.match(/not in the install: (git -C .*? diff '[^']+\^' '[^']+' > ~\/gstack-local-edits\.patch)/)![1];
    expect(run(fx, exp).status).toBe(0);
    const patch = fs.readFileSync(path.join(fx.home, 'gstack-local-edits.patch'), 'utf8');
    expect(patch).toContain('+top LOCAL');
    expect([...patch.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1])).toEqual(['notes.txt']);

    // The next day it repeats.
    const notes = path.join(fx.state, 'session-update-rescues');
    fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace(/ \d{4}-\d{2}-\d{2}$/m, ' 2000-01-01'));
    expect(banner(fx)).toContain(ref);

    const del = first.match(/Delete when done: (git -C .*? update-ref -d '[^']+')\./)![1];
    expect(run(fx, del).status).toBe(0);
    expect(git(fx.install, 'for-each-ref', 'refs/gstack/rescue')).toBe('');
    expect(banner(fx)).toBe('');
    expect(fs.existsSync(notes)).toBe(false);
  }, 60_000);
});

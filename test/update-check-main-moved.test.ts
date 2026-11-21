/**
 * W12 (field list 2; #2378's Claude Code half): bin/gstack-update-check at an
 * equal VERSION whose main moved past this checkout. Real git fixtures: a bare
 * "origin" whose main the script reads with ls-remote, a gstack checkout at an
 * older commit, the SHA-pinned raw VERSION and the GitHub compare API served
 * from file:// fixtures (GSTACK_REMOTE_RAW_BASE, GSTACK_COMPARE_API). A git
 * shim on PATH logs every fetch, pull or merge: the check never fetches.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-update-check');

interface Fx { root: string; gstack: string; origin: string; state: string; raw: string; compare: string; gitLog: string; env: Record<string, string> }
let fx: Fx;

function sh(cwd: string, cmd: string, env: Record<string, string> = fx.env): string {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(cmd + ' failed: ' + r.stderr);
  return r.stdout.trim();
}

/** A commit on the origin's main made from a scratch clone (the checkout never fetches it). */
function pushUpstream(message: string): string {
  const clone = path.join(fx.root, 'upstream-' + Math.random().toString(36).slice(2));
  sh(fx.root, 'git clone -q "' + fx.origin + '" "' + clone + '"');
  sh(clone, 'echo "' + message + '" >> NOTES && git add -A && git commit -q -m "' + message + '" && git push -q origin HEAD:main');
  const sha = sh(clone, 'git rev-parse HEAD');
  serveVersion(sha, '1.0.0');
  return sha;
}

function serveVersion(sha: string, version: string): void {
  fs.mkdirSync(path.join(fx.raw, sha), { recursive: true });
  fs.writeFileSync(path.join(fx.raw, sha, 'VERSION'), version + '\n');
}

/** The compare API's answer for base...head, in GitHub's shape (page 2 of one commit per page: no file list). */
function serveCompare(base: string, head: string, status: string, ahead: number, behind = 0): void {
  fs.writeFileSync(path.join(fx.compare, base + '...' + head), JSON.stringify({
    url: 'https://api.github.com/repos/garrytan/gstack/compare/' + base + '...' + head,
    base_commit: { sha: base, commit: { message: 'base', verification: { verified: false, reason: 'unsigned' } } },
    status, ahead_by: ahead, behind_by: behind, total_commits: ahead, commits: [],
  }, null, 2));
}

function run(args: string[] = [], extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...fx.env, GSTACK_DIR: fx.gstack, GSTACK_STATE_DIR: fx.state, GSTACK_REMOTE_REPO: fx.origin, GSTACK_REMOTE_RAW_BASE: 'file://' + fx.raw, GSTACK_COMPARE_API: 'file://' + fx.compare, PATH: path.join(fx.root, 'shim') + ':' + process.env.PATH, ...extra };
  for (const k of ['GSTACK_STATE_ROOT', 'GSTACK_HOME', 'GSTACK_REMOTE_URL']) if (!(k in extra)) delete env[k];
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000, env });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '' };
}

const cache = () => fs.readFileSync(path.join(fx.state, 'last-update-check'), 'utf8').split('\n');
const head = () => sh(fx.gstack, 'git rev-parse HEAD');
const short = (sha: string) => sha.slice(0, 7);

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-upd-main-'));
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  fx = { root, gstack: path.join(root, 'gstack'), origin: path.join(root, 'origin.git'), state: path.join(root, 'state'), raw: path.join(root, 'raw'), compare: path.join(root, 'compare'), gitLog: path.join(root, 'git.log'), env: { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: root } };
  for (const d of [fx.gstack, fx.state, fx.raw, fx.compare, path.join(root, 'shim'), path.join(fx.gstack, 'bin')]) fs.mkdirSync(d, { recursive: true });
  const realGit = sh(root, 'command -v git');
  fs.writeFileSync(path.join(root, 'shim', 'git'), '#!/usr/bin/env bash\ncase "$1" in fetch|pull|merge) echo "git $*" >> "' + fx.gitLog + '" ;; esac\nexec "' + realGit + '" "$@"\n', { mode: 0o755 });
  for (const name of ['gstack-config', 'gstack-egress-lib.sh', 'gstack-state-root.sh', 'gstack-egress-receipt']) fs.symlinkSync(path.join(ROOT, 'bin', name), path.join(fx.gstack, 'bin', name));
  fs.writeFileSync(path.join(fx.gstack, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(fx.gstack, '.gitignore'), 'bin/\n');
  sh(root, 'git init -q --bare "' + fx.origin + '"');
  sh(fx.gstack, 'git init -q -b main && git add -A && git commit -q -m base && git remote add origin "' + fx.origin + '" && git push -q origin main');
  serveVersion(head(), '1.0.0');
});
afterEach(() => {
  expect(fs.existsSync(fx.gitLog) ? fs.readFileSync(fx.gitLog, 'utf8') : '').toBe('');
  fs.rmSync(fx.root, { recursive: true, force: true });
});

describe('equal VERSION, main moved past the checkout', () => {
  test('a checkout at main stays silent and caches its identity', () => {
    const r = run();
    expect(r.stdout).toBe('');
    expect(cache()).toEqual(['UP_TO_DATE 1.0.0', 'IDENTITY head=' + head() + ' remote=' + head() + ' upstream=' + fx.origin, '']);
  });

  test('two unreleased commits print UPGRADE_AVAILABLE <ver> <ver>+2 <sha>; the cache replays it without another compare, also after its TTL while main is unchanged', () => {
    const local = head();
    pushUpstream('c2');
    const main = pushUpstream('c3');
    serveCompare(local, main, 'ahead', 2);
    const line = 'UPGRADE_AVAILABLE 1.0.0 1.0.0+2 ' + short(main);
    expect(run().stdout).toBe(line);
    expect(cache()).toEqual([line, 'IDENTITY head=' + local + ' remote=' + main + ' upstream=' + fx.origin, '']);
    fs.rmSync(fx.compare, { recursive: true, force: true });
    fs.rmSync(fx.raw, { recursive: true, force: true });
    expect(run().stdout).toBe(line);
    const old = new Date(Date.now() - 13 * 3600_000);
    fs.utimesSync(path.join(fx.state, 'last-update-check'), old, old);
    expect(run().stdout).toBe(line);
  });

  test('after a cached upgrade, fast-forwarding the checkout to main invalidates the cache: silent, UP_TO_DATE at the new HEAD', () => {
    const local = head();
    const main = pushUpstream('c2');
    serveCompare(local, main, 'ahead', 1);
    expect(run().stdout).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.0+1 ' + short(main));
    spawnSync('git', ['-C', fx.gstack, 'fetch', '-q', 'origin'], { timeout: 30_000, env: { ...process.env, ...fx.env } });
    sh(fx.gstack, 'git merge -q --ff-only origin/main');
    expect(head()).toBe(main);
    expect(run().stdout).toBe('');
    expect(cache()[0]).toBe('UP_TO_DATE 1.0.0');
    expect(cache()[1]).toBe('IDENTITY head=' + main + ' remote=' + main + ' upstream=' + fx.origin);
  });

  test('after a cached upgrade, a diverged local commit is unknown: silent CHECK_FAILED, and --force says diverged, never up to date', () => {
    const main = pushUpstream('c2');
    serveCompare(head(), main, 'ahead', 1);
    expect(run().stdout).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.0+1 ' + short(main));
    sh(fx.gstack, 'echo local >> LOCAL && git add LOCAL && git commit -q -m local');
    const local = head();
    serveCompare(local, main, 'diverged', 1, 1);
    expect(run().stdout).toBe('');
    expect(cache()[0]).toStartWith('CHECK_FAILED 1.0.0 ');
    expect(cache()[0]).toEndWith(' diverged');
    expect(cache()[1]).toBe('IDENTITY head=' + local + ' remote=' + main + ' upstream=' + fx.origin);
    const forced = run(['--force']);
    expect(forced.stdout).toBe('CHECK_FAILED this checkout (' + local.slice(0, 12) + ') has diverged from main (' + main.slice(0, 12) + ') at the same VERSION 1.0.0 — update status UNKNOWN, not up-to-date');
  });

  test('an unreadable compare (API down, rate limited) is unknown, not up to date and not an upgrade', () => {
    pushUpstream('c2');
    expect(run().stdout).toBe('');
    expect(cache()[0]).toMatch(/^CHECK_FAILED 1\.0\.0 file:\/\/.*\/compare\/[0-9a-f]{12}\.\.\.[0-9a-f]{12} unreadable$/);
    expect(run(['--force']).stdout).toMatch(/^CHECK_FAILED could not compare this checkout \([0-9a-f]{12}\) with main \([0-9a-f]{12}\) at .* — update status UNKNOWN, not up-to-date$/);
  });

  test('a checkout ahead of main (compare status behind) is up to date', () => {
    const main = head();
    sh(fx.gstack, 'echo dev >> DEV && git add DEV && git commit -q -m dev');
    serveCompare(head(), main, 'behind', 0, 1);
    expect(run().stdout).toBe('');
    expect(cache()[0]).toBe('UP_TO_DATE 1.0.0');
  });

  test('a legacy one-line cache in a git checkout is ignored, and a different upstream invalidates a cached result', () => {
    const local = head();
    const main = pushUpstream('c2');
    serveCompare(local, main, 'ahead', 1);
    fs.writeFileSync(path.join(fx.state, 'last-update-check'), 'UP_TO_DATE 1.0.0\n');
    expect(run().stdout).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.0+1 ' + short(main));
    const mirror = path.join(fx.root, 'mirror.git');
    sh(fx.root, 'git init -q --bare "' + mirror + '" && git -C "' + fx.gstack + '" push -q "' + mirror + '" ' + local + ':refs/heads/main');
    expect(run([], { GSTACK_REMOTE_REPO: mirror }).stdout).toBe('');
    expect(cache()).toEqual(['UP_TO_DATE 1.0.0', 'IDENTITY head=' + local + ' remote=' + local + ' upstream=' + mirror, '']);
  });

  test('the snooze is keyed by the main SHA: a snoozed SHA is quiet, the next main commit asks again once the cache expires', () => {
    const local = head();
    const main = pushUpstream('c2');
    serveCompare(local, main, 'ahead', 1);
    fs.writeFileSync(path.join(fx.state, 'update-snoozed'), short(main) + ' 1 ' + Math.floor(Date.now() / 1000) + '\n');
    expect(run().stdout).toBe('');
    expect(cache()[0]).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.0+1 ' + short(main));
    const next = pushUpstream('c3');
    serveCompare(local, next, 'ahead', 2);
    const old = new Date(Date.now() - 13 * 3600_000);
    fs.utimesSync(path.join(fx.state, 'last-update-check'), old, old);
    expect(run().stdout).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.0+2 ' + short(next));
  });

  // #4561: the block takes the whole line and derives the key itself, so an agent never picks the field by hand.
  test("gstack-upgrade's Not-now block, given the whole four-field line, snoozes exactly that SHA", () => {
    const local = head();
    const main = pushUpstream('c2');
    serveCompare(local, main, 'ahead', 1);
    const line = run().stdout;
    const fields = line.split(' ');
    expect(fields).toHaveLength(4);
    const skill = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md'), 'utf8');
    const block = /```bash\n(GSTACK_STATE_ROOT=\$\(~\/\.claude\/skills\/gstack\/bin\/gstack-paths[^\n]*\n_SNOOZE_FILE=[\s\S]*?)```/.exec(skill)![1]!;
    expect(block).toContain('_UPGRADE_LINE="{line}"');
    expect(block).not.toContain('{new}');
    const bin = path.join(fx.root, '.claude', 'skills', 'gstack', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(path.dirname(bin), 'lib'), { recursive: true });
    for (const name of ['gstack-paths', 'gstack-state-root.sh']) fs.copyFileSync(path.join(ROOT, 'bin', name), path.join(bin, name));
    for (const name of ['gstack-paths', 'gstack-state-root.sh']) fs.chmodSync(path.join(bin, name), 0o755);
    const r = spawnSync('bash', ['-c', block.replace('{line}', line.trim())], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, HOME: fx.root, GSTACK_STATE_ROOT: fx.state, GSTACK_ROOT: path.dirname(bin) } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(fx.state, 'update-snoozed'), 'utf8')).toMatch(new RegExp('^' + short(main) + ' 1 \\d+\\n$'));
    expect(run().stdout).toBe('');
  });

  test('unattended skill-end reports the four-field line from the two-line cache', () => {
    fs.writeFileSync(path.join(fx.state, 'last-update-check'), 'UPGRADE_AVAILABLE 1.0.0 1.0.0+2 abc1234\nIDENTITY head=' + head() + ' remote=' + 'a'.repeat(40) + ' upstream=' + fx.origin + '\n');
    const env: Record<string, string | undefined> = { ...process.env, ...fx.env, GSTACK_HOME: fx.state, GSTACK_SESSION_KIND: 'unattended' };
    delete env.GSTACK_STATE_ROOT;
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-skill-end'), ['--skill', 'review', '--outcome', 'success', '--session-id', 'sid-w12', '--tel-start', '1'], { cwd: fx.root, encoding: 'utf8', timeout: 30_000, env });
    expect(r.stdout).toMatch(/^UPGRADE_AVAILABLE: 1\.0\.0\+2 \(main at abc1234\); run \/gstack-upgrade$/m);
  });
});

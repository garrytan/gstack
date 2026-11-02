/**
 * bin/gstack-lease: the workflow lease on a shared gstack installation (field
 * wave residual R4). Eight Capy subagents share one checkout; each session
 * start touches `<git dir>/gstack-leases/<harness pid>` (install-scoped, like
 * gstack-upgrade.pending), and an updater refuses to move the checkout while
 * a lease whose pid is alive and not in its own ancestry exists. Pinned:
 * `touch` writes and prunes (older than 120 min), `live` lists live foreign
 * leases (exit 0) or nothing (exit 1), `list` shows every lease with its age
 * and alive|dead, and bin/gstack-skill-start touches the lease for the
 * harness pid it derives. Fixture: a throwaway git checkout, a sleeping child
 * process as the live pid, an exited process as the dead pid.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(import.meta.dir, '..');
const LEASE = path.join(REPO, 'bin/gstack-lease');
const START = path.join(REPO, 'bin/gstack-skill-start');
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function checkout() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-')));
  dirs.push(dir);
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return { dir, leases: path.join(dir, '.git/gstack-leases') };
}

// These cases assert the default lease location, <git dir>/gstack-leases of a
// temp checkout; the test preload's GSTACK_LEASE_DIR (which keeps every other
// suite out of this repo's .git) would override it, so strip it here.
const { GSTACK_LEASE_DIR: _preloadLeaseDir, ...baseEnv } = process.env as Record<string, string>;
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [LEASE, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 30_000 });

/** A child that stays alive for the test: its pid is a live, foreign (non-ancestor) lease holder. */
function sleeper(): number {
  const c = spawn('sleep', ['300'], { stdio: 'ignore' });
  children.push(c);
  return c.pid!;
}

/** A pid that no longer exists: a child that has already exited. */
function deadPid(): number {
  const r = spawnSync('true', [], { timeout: 30_000 });
  return r.pid!;
}

/** The same backend's identity for a different process start (what a reused pid shows). */
function otherStart(recorded: string): string {
  return recorded.startsWith('linux ') ? recorded.replace(/\d+$/, (n) => String(Number(n) + 1)) : 'ps Thu Jan  1 00:00:00 1970';
}

/** A directory lock as gstack-lease takes it: <path>/owner holds the holder's token. */
function plantLock(lockPath: string, token: string) {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner'), token + '\n');
}
const ownerOf = (lockPath: string) => fs.readFileSync(path.join(lockPath, 'owner'), 'utf8').trim();
/** Backdate a lock a minute: an ownerless lock is broken only once it is 2 s old. */
function age(lockPath: string) {
  const minuteAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, minuteAgo, minuteAgo);
}

/** Each lock layout a holder can leave: the directory lock, and the symlink lock an older gstack took. */
const LAYOUTS: Array<[string, (lockPath: string, token: string) => void]> = [
  ['directory lock', plantLock],
  ['legacy symlink lock', (lockPath, token) => fs.symlinkSync(token, lockPath)],
];

/** A BASH_ENV file whose functions shadow commands inside the lease script (fault injection). */
function bashEnv(dir: string, body: string): string {
  const file = path.join(dir, 'bash-env.sh');
  fs.writeFileSync(file, body);
  return file;
}

describe('gstack-lease', () => {
  test('bash -n passes and the bin is executable', () => {
    expect(fs.existsSync(LEASE), LEASE).toBe(true);
    expect(fs.statSync(LEASE).mode & 0o111).not.toBe(0);
    const r = spawnSync('bash', ['-n', LEASE], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const help = spawnSync('bash', [LEASE, '--help'], { encoding: 'utf8', timeout: 30_000 });
    expect(help.stdout).toContain('print `<pid> <age>m alive|dead|stale` for every lease');
  });

  test('touch writes <git dir>/gstack-leases/<pid> for --pid and prunes leases older than 120 minutes', () => {
    const { dir, leases } = checkout();
    fs.mkdirSync(leases, { recursive: true });
    fs.writeFileSync(path.join(leases, '99999991'), '');
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(path.join(leases, '99999991'), threeHoursAgo, threeHoursAgo);
    fs.writeFileSync(path.join(leases, '99999992'), '');
    const r = run(['touch', '--root', dir, '--pid', '4242']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(leases).sort()).toEqual(['4242', '99999992']);
  });

  test('live: a sleeping child is a live lease (exit 0, pid and age printed); a dead pid alone is none (exit 1)', () => {
    const { dir } = checkout();
    const dead = deadPid();
    expect(run(['touch', '--root', dir, '--pid', String(dead)]).status).toBe(0);
    const none = run(['live', '--root', dir]);
    expect(none.status, none.stdout + none.stderr).toBe(1);
    expect(none.stdout.trim()).toBe('');

    const live = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(live)]).status).toBe(0);
    const some = run(['live', '--root', dir]);
    expect(some.status, some.stdout + some.stderr).toBe(0);
    expect(some.stdout.trim().split('\n')).toEqual([expect.stringMatching(new RegExp(`^${live} \\d+m sleep$`))]);

    const list = run(['list', '--root', dir]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`^${live} \\d+m alive$`, 'm'));
    expect(list.stdout).toMatch(new RegExp(`^${dead} \\d+m dead$`, 'm'));
  });

  // GBRA-105 / GBRA-106: after a machine wake the recorded pid was dbus-daemon
  // and systemd-logind, and every upgrade refused with UPGRADE_BUSY.
  test('a reused pid is not a holder: a lease whose recorded start identity differs is reclaimed by live and listed stale', () => {
    const { dir, leases } = checkout();
    const reused = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(reused)]).status).toBe(0);
    const recorded = fs.readFileSync(path.join(leases, String(reused)), 'utf8').trim();
    expect(recorded).toMatch(/^(linux [0-9a-f-]+ \d+|ps .+)$/);
    fs.writeFileSync(path.join(leases, String(reused)), otherStart(recorded) + '\n');
    expect(run(['list', '--root', dir]).stdout).toMatch(new RegExp(`^${reused} \\d+m stale$`, 'm'));
    const live = run(['live', '--root', dir]);
    expect(live.status, live.stdout + live.stderr).toBe(1);
    expect(live.stdout.trim()).toBe('');
    expect(live.stderr).toMatch(new RegExp(`^gstack-lease: reclaimed stale lease ${reused} \\(\\d+m; recorded '.+', pid ${reused} is now sleep '.+'\\)$`, 'm'));
    expect(fs.existsSync(path.join(leases, String(reused)))).toBe(false);
  });

  test('missing evidence never reclaims a live lease: an unreadable current identity, a malformed record or another backend keeps it', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const file = path.join(leases, String(holder));
    expect(run(['touch', '--root', dir, '--pid', String(holder)]).status).toBe(0);
    const recorded = fs.readFileSync(file, 'utf8').trim();
    const blind = bashEnv(dir, 'cat() { case "$1" in /proc/*/stat) return 1 ;; esac; command cat "$@"; }\nps() { case "$*" in *lstart*) return 1 ;; esac; command ps "$@"; }\n');
    const unreadable = run(['live', '--root', dir], { BASH_ENV: blind });
    expect(unreadable.status, unreadable.stdout + unreadable.stderr).toBe(0);
    expect(unreadable.stderr).not.toContain('reclaimed');
    for (const record of ['linux not-a-boot-id 12', 'linux ' + '0'.repeat(36) + ' x1', recorded.startsWith('linux ') ? 'ps Thu Jan  1 00:00:00 1970' : 'linux ' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + ' 1']) {
      fs.writeFileSync(file, record + '\n');
      const r = run(['live', '--root', dir]);
      expect(r.status, record + ': ' + r.stderr).toBe(0);
      expect(fs.existsSync(file), record).toBe(true);
    }
  });

  test('the recorded identity does not depend on the caller\'s timezone or locale', () => {
    const { dir } = checkout();
    const holder = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(holder)], { TZ: 'UTC', LC_ALL: 'C' }).status).toBe(0);
    const r = run(['live', '--root', dir], { TZ: 'Pacific/Kiritimati', LC_ALL: 'C.UTF-8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('reclaimed');
  });

  test('a renewal that lands between the stale verdict and the reclaim survives: reclaim rereads under the lock', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const file = path.join(leases, String(holder));
    expect(run(['touch', '--root', dir, '--pid', String(holder)]).status).toBe(0);
    const fresh = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, otherStart(fresh.trim()) + '\n');
    const renewed = path.join(dir, 'renewed');
    fs.writeFileSync(renewed, fresh);
    // The holder renews just before reclaim takes the lock, as if touch ran after the stale verdict.
    const racing = bashEnv(dir, `mkdir() { case "$*" in *"/.lock") command cp "${renewed}" "${file}" ;; esac; command mkdir "$@"; }\n`);
    const r = run(['live', '--root', dir], { BASH_ENV: racing });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('reclaimed');
    expect(fs.readFileSync(file, 'utf8')).toBe(fresh);
    expect(fs.readdirSync(leases).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  test.each(LAYOUTS)('a %s whose holder died, or whose pid now belongs to another process, is broken at once', (_layout, plant) => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    fs.mkdirSync(leases, { recursive: true });
    plant(path.join(leases, '.lock'), `${deadPid()} `);
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(leases, '.lock'))).toBe(false);
    const identity = fs.readFileSync(path.join(leases, String(holder)), 'utf8').trim();
    expect(identity).toMatch(/^(linux|ps) /);
    plant(path.join(leases, '.lock'), `${holder} ${otherStart(identity)}`);
    const again = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(fs.existsSync(path.join(leases, '.lock'))).toBe(false);
    expect(fs.readdirSync(leases).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  test.each(LAYOUTS)('a live holder\'s %s is never broken, however old: touch exits 3 without writing and a reclaim keeps the lease', (layout, plant) => {
    const { dir, leases } = checkout();
    const owner = sleeper();
    const holder = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(owner)]).status).toBe(0);
    expect(run(['touch', '--root', dir, '--pid', String(holder)]).status).toBe(0);
    const ownerToken = `${owner} ${fs.readFileSync(path.join(leases, String(owner)), 'utf8').trim()}`;
    const lockPath = path.join(leases, '.lock');
    plant(lockPath, ownerToken);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.lutimesSync(lockPath, old, old);
    if (layout === 'directory lock') fs.utimesSync(path.join(lockPath, 'owner'), old, old);
    const holderFile = path.join(leases, String(holder));
    const stale = otherStart(fs.readFileSync(holderFile, 'utf8').trim()) + '\n';
    fs.writeFileSync(holderFile, stale);
    const t = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(t.status, t.stdout + t.stderr).toBe(3);
    expect(t.stderr).toContain(`locked by live process ${owner}`);
    expect(fs.readFileSync(holderFile, 'utf8')).toBe(stale);
    const l = run(['live', '--root', dir], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(l.status, l.stdout + l.stderr).toBe(0);
    expect(l.stderr).not.toContain('reclaimed');
    expect(l.stdout).toContain(`${holder} `);
    expect(fs.existsSync(holderFile)).toBe(true);
    expect(layout === 'directory lock' ? ownerOf(lockPath) : fs.readlinkSync(lockPath)).toBe(ownerToken);
  });

  test('two breakers of one dead lock: the second rereads under .lock.break and leaves the lock the first one took', () => {
    const { dir, leases } = checkout();
    const owner = sleeper();
    const holder = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(owner)]).status).toBe(0);
    const ownerToken = `${owner} ${fs.readFileSync(path.join(leases, String(owner)), 'utf8').trim()}`;
    const lockPath = path.join(leases, '.lock');
    plantLock(lockPath, `${deadPid()} `);
    // Between this breaker's dead verdict and its .lock.break, another breaker removes the dead lock and takes it.
    const first = bashEnv(dir, `mkdir() { case "$*" in *"/.lock.break") command rm -rf "${lockPath}"; command mkdir "${lockPath}"; printf '%s\\n' "${ownerToken}" > "${lockPath}/owner" ;; esac; command mkdir "$@"; }\n`);
    const t = run(['touch', '--root', dir, '--pid', String(holder)], { BASH_ENV: first, GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(t.status, t.stdout + t.stderr).toBe(3);
    expect(ownerOf(lockPath)).toBe(ownerToken);
    expect(fs.readdirSync(leases).filter((n) => n.startsWith('.')).sort()).toEqual(['.lock']);
  });

  test.each(LAYOUTS)('a .lock.break (%s) left by a dead breaker is cleared and the dead lock is still broken', (_layout, plant) => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    fs.mkdirSync(leases, { recursive: true });
    plant(path.join(leases, '.lock'), `${deadPid()} `);
    plant(path.join(leases, '.lock.break'), `${deadPid()} `);
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '5' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(true);
    expect(fs.readdirSync(leases).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  test('unlock removes only its own lock: a lock that changed hands during a reclaim stays', () => {
    const { dir, leases } = checkout();
    const owner = sleeper();
    const holder = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(owner)]).status).toBe(0);
    expect(run(['touch', '--root', dir, '--pid', String(holder)]).status).toBe(0);
    const ownerToken = `${owner} ${fs.readFileSync(path.join(leases, String(owner)), 'utf8').trim()}`;
    const holderFile = path.join(leases, String(holder));
    fs.writeFileSync(holderFile, otherStart(fs.readFileSync(holderFile, 'utf8').trim()) + '\n');
    const lockPath = path.join(leases, '.lock');
    // While reclaim deletes the stale lease under its lock, the lock changes hands.
    const swap = bashEnv(dir, `rm() { if [ "$*" = "-f ${holderFile}" ]; then command rm -rf "${lockPath}"; command mkdir "${lockPath}"; printf '%s\\n' "${ownerToken}" > "${lockPath}/owner"; fi; command rm "$@"; }\n`);
    const r = run(['live', '--root', dir, '--exclude-ancestry-of', String(owner)], { BASH_ENV: swap });
    expect(r.stderr).toContain(`reclaimed stale lease ${holder}`);
    expect(ownerOf(lockPath)).toBe(ownerToken);
  });

  test('a lock held by a running gstack-lease excludes a second taker, which names it; both leases land once it is released', async () => {
    const { dir, leases } = checkout();
    const [first, second] = [sleeper(), sleeper()];
    // The first touch holds the lock across its prune (find runs under the lock) until the test releases it.
    const release = path.join(dir, 'release');
    const slow = bashEnv(dir, `find() { case "$*" in *'+120'*) until [ -e "${release}" ]; do sleep 0.05; done ;; esac; command find "$@"; }\n`);
    const holder = spawn('bash', [LEASE, 'touch', '--root', dir, '--pid', String(first)], { env: { ...baseEnv, BASH_ENV: slow }, stdio: 'ignore' });
    children.push(holder);
    const exited = new Promise<number | null>((resolve) => holder.on('exit', resolve));
    const owner = path.join(leases, '.lock', 'owner');
    for (let i = 0; i < 500 && !fs.existsSync(owner); i++) await Bun.sleep(20);
    expect(fs.readFileSync(owner, 'utf8')).toMatch(new RegExp(`^${holder.pid} `));
    const blocked = run(['touch', '--root', dir, '--pid', String(second)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    fs.writeFileSync(release, '');
    expect(blocked.status, blocked.stdout + blocked.stderr).toBe(3);
    expect(blocked.stderr).toContain(`locked by live process ${holder.pid};`);
    expect(await exited).toBe(0);
    expect(run(['touch', '--root', dir, '--pid', String(second)]).status).toBe(0);
    expect(fs.readdirSync(leases).sort()).toEqual([String(first), String(second)].sort());
  }, 30_000);

  test('parallel touches all take the lock in turn and leave no lock, claim or temp file behind', async () => {
    const { dir, leases } = checkout();
    const pids = Array.from({ length: 16 }, (_, i) => 4300 + i);
    // The prune runs under the lock: a second process inside it at the same time logs an overlap.
    const inside = path.join(dir, 'inside');
    const overlaps = path.join(dir, 'overlaps.log');
    const probe = bashEnv(dir, `find() { case "$*" in *'+120'*) command mkdir "${inside}" 2>/dev/null || echo overlap >> "${overlaps}"; sleep 0.05; command rmdir "${inside}" 2>/dev/null ;; esac; command find "$@"; }\n`);
    const codes = await Promise.all(pids.map((p) => new Promise<number | null>((resolve) => {
      const c = spawn('bash', [LEASE, 'touch', '--root', dir, '--pid', String(p)], { env: { ...baseEnv, BASH_ENV: probe }, stdio: 'ignore' });
      children.push(c);
      c.on('exit', resolve);
    })));
    expect(codes).toEqual(pids.map(() => 0));
    expect(fs.existsSync(overlaps), 'two touches were inside the lock at once').toBe(false);
    expect(fs.readdirSync(leases).sort()).toEqual(pids.map(String).sort());
  }, 30_000);

  // #3330: a taker killed between its mkdir and its owner rename leaves an ownerless lock.
  test('an ownerless lock is broken once every claimant is gone, and kept while a live claimant may still own it', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const lockPath = path.join(leases, '.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    age(lockPath);
    fs.writeFileSync(path.join(leases, `.lock.claim.${holder}`), `${holder} \n`);
    const kept = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(kept.status, kept.stdout + kept.stderr).toBe(3);
    expect(kept.stderr).toContain('cannot take the lease directory lock');
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(false);
    expect(fs.readdirSync(lockPath)).toEqual([]);

    const dead = deadPid();
    fs.renameSync(path.join(leases, `.lock.claim.${holder}`), path.join(leases, `.lock.claim.${dead}`));
    fs.writeFileSync(path.join(leases, `.lock.claim.${dead}`), `${dead} \n`);
    fs.writeFileSync(path.join(leases, '.lock.claim.1'), '');
    age(lockPath);
    const broken = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(broken.status, broken.stdout + broken.stderr).toBe(0);
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);

    fs.rmSync(path.join(leases, `.lock.claim.${dead}`));
    fs.mkdirSync(lockPath);
    age(lockPath);
    const unclaimed = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(unclaimed.status, unclaimed.stdout + unclaimed.stderr).toBe(0);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  // Value: protects=an ownerless lock younger than 2 s is never broken, so a live taker whose claim landed after the breaker read the claims keeps
  //   the lock it is about to publish; a malformed lock (empty owner, pid 0, or a stray file) is broken once old instead of wedging every touch;
  //   fails_when=orphaned() drops its age check, or treats only a missing owner file (not an empty or invalid one) as ownerless;
  //   why_new=the ownerless cases above all backdate the lock; nothing pins the young-lock guard or the malformed shapes;
  //   seam=none; no_claim=the claim-read race itself (a young unclaimed lock stands in for a taker whose claim the breaker missed)
  test('an ownerless lock is broken only once it is 2 s old, and a malformed lock is treated as ownerless', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const lockPath = path.join(leases, '.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    // The clock reads the lock's own mtime, so the lock stays 0 s old however slow the runner is.
    const frozen = bashEnv(dir, `date() { case "$1" in +%s) command stat -c %Y "${lockPath}" 2>/dev/null || command stat -f %m "${lockPath}" ;; *) command date "$@" ;; esac; }\n`);
    const young = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3', BASH_ENV: frozen });
    expect(young.status, young.stdout + young.stderr).toBe(3);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(false);

    const shapes: Array<[string, () => void]> = [
      ['an empty owner file', () => plantLock(lockPath, '')],
      ['owner pid 0', () => plantLock(lockPath, '0 ')],
      ['a zero-padded owner pid', () => plantLock(lockPath, '00 ')],
      ['a non-numeric owner', () => plantLock(lockPath, 'garbage x')],
      ['an ownerless lock an hour ahead (clock skew)', () => fs.mkdirSync(lockPath)],
      ['a stray file', () => { fs.rmSync(lockPath, { recursive: true, force: true }); fs.writeFileSync(lockPath, ''); }],
    ];
    for (const [shape, plant] of shapes) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.rmSync(path.join(leases, String(holder)), { force: true });
      plant();
      age(lockPath);
      if (shape.includes('clock skew')) {
        const hourAhead = new Date(Date.now() + 3_600_000);
        fs.utimesSync(lockPath, hourAhead, hourAhead);
      }
      const r = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
      expect(r.status, `${shape}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(fs.readdirSync(leases), shape).toEqual([String(holder)]);
    }
  });

  // Value: protects=a claim without a start identity left by a killed taker neither blocks recovery of an ownerless lock (even when its pid is
  //   alive again) nor lingers once 2 minutes old, while a claim whose recorded identity is still live is honored however old;
  //   fails_when=orphaned() honors identity-less claims of any age, expires live identified claims, or touch's prune skips claim files;
  //   why_new=the ownerless cases plant fresh claims only; nothing ages one or checks the prune for claims;
  //   seam=none; no_claim=real pid reuse (a live sleeper stands in for the reused pid)
  test('an identity-less claim older than 2 minutes is abandoned and pruned; an old claim with a live identity is honored', () => {
    const { dir, leases } = checkout();
    const [holder, reused] = [sleeper(), sleeper()];
    const lockPath = path.join(leases, '.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    age(lockPath);
    const claim = path.join(leases, `.lock.claim.${reused}`);
    fs.writeFileSync(claim, `${reused} \n`);
    const fiveMinutesAgo = new Date(Date.now() - 300_000);
    fs.utimesSync(claim, fiveMinutesAgo, fiveMinutesAgo);
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(leases)).toEqual([String(holder)]);

    // A claim that records its claimant's start identity is honored however old, so a stalled live taker keeps its lock.
    expect(run(['touch', '--root', dir, '--pid', String(reused)]).status).toBe(0);
    const identity = fs.readFileSync(path.join(leases, String(reused)), 'utf8').trim();
    expect(identity, 'this host records start identities').not.toBe('');
    fs.rmSync(path.join(leases, String(reused)));
    fs.mkdirSync(lockPath);
    age(lockPath);
    fs.writeFileSync(claim, `${reused} ${identity}\n`);
    fs.utimesSync(claim, fiveMinutesAgo, fiveMinutesAgo);
    const kept = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(kept.status, kept.stdout + kept.stderr).toBe(3);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(claim)).toBe(true);
  });

  // Value: protects=a live holder's lock is never broken because its owner file could not be read (a Windows sharing violation, a permission error);
  //   fails_when=orphaned() treats an unreadable owner (empty owner_of output) as no owner;
  //   why_new=every ownerless case removes or empties the owner file; none makes a present owner unreadable;
  //   seam=none; no_claim=a real sharing violation (a head shim fails reads of the owner file)
  test('a lock whose owner file cannot be read is kept, not taken for ownerless', () => {
    const { dir, leases } = checkout();
    const [holder, owner] = [sleeper(), sleeper()];
    const lockPath = path.join(leases, '.lock');
    plantLock(lockPath, `${owner} `);
    age(lockPath);
    const shim = bashEnv(dir, 'head() { case "$*" in *"/.lock/owner") return 1 ;; esac; command head "$@"; }\n');
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3', BASH_ENV: shim });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(ownerOf(lockPath)).toBe(String(owner));
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(false);
  });

  // Value: protects=a live holder that never lets go bounds touch at 30 s even with the default 300 tries, a non-numeric
  //   GSTACK_LEASE_LOCK_TRIES falls back to the default instead of looping forever, and a visibly held lock is never mkdir'd;
  //   fails_when=lock() loses its SECONDS deadline or its tries validation, or take() stops checking the path first;
  //   why_new=every live-holder case lowers the tries; none runs the default budget, a bad value or counts mkdir calls;
  //   seam=none; no_claim=real elapsed time (a sleep shim advances SECONDS 10 s per wait)
  test('a live holder bounds touch by a 30 s deadline, and a non-numeric tries value cannot loop forever', () => {
    const { dir, leases } = checkout();
    const [holder, owner] = [sleeper(), sleeper()];
    plantLock(path.join(leases, '.lock'), `${owner} `);
    const waits = path.join(dir, 'waits.log');
    const mkdirs = path.join(dir, 'mkdirs.log');
    const shim = bashEnv(dir, `sleep() { echo "$*" >> "${waits}"; SECONDS=$((SECONDS + 10)); }\nmkdir() { case "$*" in *"/.lock") echo "$*" >> "${mkdirs}" ;; esac; command mkdir "$@"; }\n`);
    for (const tries of [undefined, 'abc']) {
      fs.rmSync(waits, { force: true });
      const env: Record<string, string> = { BASH_ENV: shim };
      if (tries) env.GSTACK_LEASE_LOCK_TRIES = tries;
      const r = spawnSync('bash', [LEASE, 'touch', '--root', dir, '--pid', String(holder)], { encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 20_000 });
      expect(r.error?.message ?? '', `tries=${tries}: touch did not end`).not.toContain('ETIMEDOUT');
      expect(r.status, `tries=${tries}: ${r.stdout}${r.stderr}`).toBe(3);
      expect(r.stderr).toContain(`locked by live process ${owner};`);
      expect(r.stderr).not.toContain('integer expression');
      expect(fs.readFileSync(waits, 'utf8').trim().split('\n').length, `tries=${tries}`).toBeLessThanOrEqual(3);
    }
    expect(fs.existsSync(mkdirs), 'take() ran mkdir on a visibly held lock').toBe(false);
    expect(ownerOf(path.join(leases, '.lock'))).toBe(String(owner));
  }, 30_000);

  // Value: protects=a holder that resumes past the 120-minute prune window keeps its own lock metadata, so unlock still recognizes and removes it;
  //   fails_when=touch's prune recurses into .lock (deleting owner) or matches lock files at the top level;
  //   why_new=the prune test plants only lease files; none ages the lock's owner file before the prune runs;
  //   seam=none; no_claim=a real suspension (a BASH_ENV find shim backdates the owner file just before the prune)
  test('the 120-minute prune never deletes the lock it runs under', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const shim = bashEnv(dir, 'find() { command touch -d "3 hours ago" "$1/.lock/owner" 2>/dev/null || command touch -t 197001010000 "$1/.lock/owner"; command find "$@"; }\n');
    // Renamed-aside copies a failed delete left behind are pruned too.
    fs.mkdirSync(path.join(leases, '.lock.gone.99999'), { recursive: true });
    fs.writeFileSync(path.join(leases, '.lock.gone.99999', 'owner'), '99999 \n');
    fs.mkdirSync(path.join(leases, '.lock.break.gone.99998'));
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { BASH_ENV: shim });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(leases)).toEqual([String(holder)]);
  });

  // Value: protects=once a lock is renamed aside it is released: a failed delete of the renamed copy never removes a lock a new taker made at .lock;
  //   fails_when=drop() reports failure after a successful rename, so unlock's in-place rm -rf fallback runs on the new taker's lock;
  //   why_new=the rename-aside tests fail the rename itself; none lets the rename succeed and the delete fail;
  //   seam=none; no_claim=a real new taker in that window (the rm shim plants one, then fails like a Windows file in use)
  test('a renamed-aside lock that cannot be deleted never takes a new taker\'s lock with it', () => {
    const { dir, leases } = checkout();
    const [holder, taker] = [sleeper(), sleeper()];
    const lockPath = path.join(leases, '.lock');
    const shim = bashEnv(dir, `rm() { case "$*" in *".lock.gone."*) command mkdir "${lockPath}" && printf '%s \\n' "${taker}" > "${lockPath}/owner"; return 1 ;; esac; command rm "$@"; }\n`);
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { BASH_ENV: shim });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(ownerOf(lockPath)).toBe(String(taker));
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(true);
  });

  test('a lock that cannot be taken while nobody holds it fails at once instead of waiting out the tries', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const waits = path.join(dir, 'waits.log');
    const broken = bashEnv(dir, `mkdir() { case "$*" in *"/.lock") return 1 ;; esac; command mkdir "$@"; }\nsleep() { echo "$*" >> "${waits}"; command sleep "$@"; }\n`);
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { BASH_ENV: broken });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(fs.existsSync(waits), 'lock() slept between tries').toBe(false);
    expect(r.stderr).toContain('cannot take the lease directory lock');
    expect(r.stderr).not.toContain('locked by live process');
    expect(fs.readdirSync(leases)).toEqual([]);
  });

  // Value: protects=a .lock.break held by a live breaker (owner, or claim on an ownerless dir) is never cleared; an ownerless one with no claimant is;
  //   fails_when=break_lock's liveness check on .lock.break is dropped, or orphaned() ignores a live claim;
  //   why_new=the existing .lock.break test plants only a dead breaker's owner, never a live breaker or an ownerless one;
  //   seam=none; no_claim=two live breakers racing for real (sleeping children stand in as the live holders)
  test('a .lock.break whose breaker lives (owner or claim) is never cleared; an ownerless one with no live claimant is', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const breaker = sleeper();
    const lockPath = path.join(leases, '.lock');
    const breakPath = path.join(leases, '.lock.break');
    plantLock(lockPath, `${deadPid()} `);
    plantLock(breakPath, `${breaker} `);
    const owned = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(owned.status, owned.stdout + owned.stderr).toBe(3);
    expect(ownerOf(breakPath)).toBe(String(breaker));
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(false);

    fs.rmSync(breakPath, { recursive: true });
    fs.mkdirSync(breakPath);
    age(breakPath);
    fs.writeFileSync(path.join(leases, `.lock.break.claim.${breaker}`), `${breaker} \n`);
    const claimed = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(claimed.status, claimed.stdout + claimed.stderr).toBe(3);
    expect(fs.readdirSync(breakPath)).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(false);

    fs.rmSync(path.join(leases, `.lock.break.claim.${breaker}`));
    age(breakPath);
    const orphaned = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '5' });
    expect(orphaned.status, orphaned.stdout + orphaned.stderr).toBe(0);
    expect(fs.readdirSync(leases)).toEqual([String(holder)]);
  });

  // Value: protects=a lock dir whose owner rename failed is removed, never left ownerless; touch exits 3 saying it cannot take the lock;
  //   fails_when=take() stops removing the lock dir after a failed owner rename;
  //   why_new=the ownerless-lock test plants the dir by hand; none fails take() between its mkdir and its owner rename;
  //   seam=none; no_claim=real mv failure modes (a BASH_ENV shim fails the claim-to-owner rename)
  test('a lock whose owner cannot be published is removed, not left ownerless, and touch fails at once', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const shim = bashEnv(dir, 'mv() { case "$*" in *".lock.claim."*) return 1 ;; esac; command mv "$@"; }\n');
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { BASH_ENV: shim });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain('cannot take the lease directory lock');
    expect(r.stderr).not.toContain('locked by live process');
    expect(fs.readdirSync(leases)).toEqual([]);
  });

  // Value: protects=a lock that vanishes between a failed take and its check is retaken at once: touch writes its lease, no sleep, no lock left;
  //   fails_when=the vanished-lock retry limit drops to 1, so one release race exits 3;
  //   why_new=the fails-at-once test pins only the upper bound (every take fails); no test fails a single take;
  //   seam=none; no_claim=a real release race (a BASH_ENV shim fails the first mkdir of the lock)
  test('a lock released between a failed take and its check is retaken without waiting', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const waits = path.join(dir, 'waits.log');
    const once = path.join(dir, 'failed-once');
    const shim = bashEnv(dir, `mkdir() { case "$*" in *"/.lock") if [ ! -e "${once}" ]; then : > "${once}"; return 1; fi ;; esac; command mkdir "$@"; }\nsleep() { echo "$*" >> "${waits}"; command sleep "$@"; }\n`);
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { BASH_ENV: shim });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(once), 'the shim never failed a take').toBe(true);
    expect(fs.existsSync(waits), 'lock() slept between tries').toBe(false);
    expect(fs.readdirSync(leases)).toEqual([String(holder)]);
  });

  // Value: protects=unlock removes the caller's own lock even when renaming it aside fails: touch exits 0, lease written, no .lock left behind;
  //   fails_when=the rm -rf fallback after drop in unlock() is removed;
  //   why_new=no test fails the rename-aside step of drop(), so unlock's fallback never runs;
  //   seam=none; no_claim=real mv failure modes such as a Windows file in use (a BASH_ENV shim fails the .lock.gone rename)
  test('unlock still removes its own lock when renaming it aside fails', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const shim = bashEnv(dir, 'mv() { case "$*" in *".lock.gone."*) return 1 ;; esac; command mv "$@"; }\n');
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { BASH_ENV: shim });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(leases)).toEqual([String(holder)]);
  });

  // Value: protects=a dead holder's lock that cannot be renamed aside is removed in place, and one that cannot be removed at all ends touch
  //   with exit 3 within the tries limit instead of spinning, without calling the dead holder live;
  //   fails_when=break_lock reports success after a failed drop and lock() loops without sleeping or counting tries;
  //   why_new=the dead-holder tests always let the rename-aside succeed; the tries limit is only reached through the live-holder path;
  //   seam=none; no_claim=real mv/rm failure modes such as a Windows file in use (a BASH_ENV shim fails the .lock.gone rename and the rm)
  test('a dead holder\'s lock that cannot be renamed aside ends touch with a verdict instead of spinning', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const dead = deadPid();
    const touch = (shim: string) => spawnSync('bash', [LEASE, 'touch', '--root', dir, '--pid', String(holder)], {
      encoding: 'utf8', env: { ...baseEnv, BASH_ENV: shim, GSTACK_LEASE_LOCK_TRIES: '3' }, timeout: 8_000,
    });
    const noRename = 'mv() { case "$*" in *".lock.gone."*) return 1 ;; esac; command mv "$@"; }\n';
    plantLock(path.join(leases, '.lock'), `${dead} `);
    const removed = touch(bashEnv(dir, noRename));
    expect(removed.error?.message ?? '', 'touch did not end within 8 s').not.toContain('ETIMEDOUT');
    expect(removed.status, removed.stdout + removed.stderr).toBe(0);
    expect(fs.readdirSync(leases)).toEqual([String(holder)]);

    fs.rmSync(path.join(leases, String(holder)));
    plantLock(path.join(leases, '.lock'), `${dead} `);
    const stuck = touch(bashEnv(dir, noRename + 'rm() { case "$*" in *"/.lock") return 1 ;; esac; command rm "$@"; }\n'));
    expect(stuck.error?.message ?? '', 'touch did not end within 8 s').not.toContain('ETIMEDOUT');
    expect(stuck.status, stuck.stdout + stuck.stderr).toBe(3);
    expect(stuck.stderr).toContain('cannot take the lease directory lock');
    expect(stuck.stderr).not.toContain('locked by live process');
    expect(ownerOf(path.join(leases, '.lock'))).toBe(String(dead));
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(false);
  }, 20_000);

  test('a lease without a recorded identity (older gstack) counts while fresh and is stale past the 120-minute window', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    fs.mkdirSync(leases, { recursive: true });
    fs.writeFileSync(path.join(leases, String(holder)), '');
    expect(run(['live', '--root', dir]).status).toBe(0);
    const old = new Date(Date.now() - 130 * 60_000);
    fs.utimesSync(path.join(leases, String(holder)), old, old);
    const r = run(['live', '--root', dir]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain(`reclaimed stale lease ${holder}`);
  });

  test('live --exclude-ancestry-of <pid> drops a lease held by that pid or one of its ancestors (this test process)', () => {
    const { dir } = checkout();
    expect(run(['touch', '--root', dir, '--pid', String(process.pid)]).status).toBe(0);
    const unfiltered = run(['live', '--root', dir]);
    expect(unfiltered.status, unfiltered.stdout + unfiltered.stderr).toBe(0);
    expect(unfiltered.stdout).toMatch(new RegExp(`^${process.pid} \\d+m \\S+$`, 'm'));
    // $$ inside the bin is a child of this bun process, so our own lease is ancestry.
    const own = spawnSync('bash', ['-c', `"$LEASE" live --root "$ROOT" --exclude-ancestry-of $$`], {
      encoding: 'utf8', env: { ...baseEnv, LEASE, ROOT: dir }, timeout: 30_000,
    });
    expect(own.status, own.stdout + own.stderr).toBe(1);
    expect(own.stdout.trim()).toBe('');
    const foreign = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(foreign)]).status).toBe(0);
    const mixed = spawnSync('bash', ['-c', `"$LEASE" live --root "$ROOT" --exclude-ancestry-of $$`], {
      encoding: 'utf8', env: { ...baseEnv, LEASE, ROOT: dir }, timeout: 30_000,
    });
    expect(mixed.status).toBe(0);
    expect(mixed.stdout.trim().split('\n')).toEqual([expect.stringMatching(new RegExp(`^${foreign} \\d+m sleep$`))]);
  });

  // GST-396: on Capy every session runs under one capy-server, so its lease is in every caller's ancestry.
  test('live --count-shared-harness keeps a capy-server ancestor\'s lease while it is under 120 minutes old; without the flag that ancestor is still dropped', () => {
    const { dir, leases } = checkout();
    const harness = path.join(dir, 'harness', 'capy-server');
    fs.mkdirSync(path.dirname(harness), { recursive: true });
    fs.copyFileSync(fs.realpathSync(spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8', timeout: 30_000 }).stdout.trim()), harness);
    fs.chmodSync(harness, 0o755);
    const script = [
      '"$LEASE" touch --root "$ROOT" --pid $$ || exit 9',
      '[ "$AGE" -gt 0 ] && "$BUN" -e "const t = Date.now() / 1000 - Number(process.argv[2]) * 60; require(\'fs\').utimesSync(process.argv[1], t, t)" "$ROOT/.git/gstack-leases/$$" "$AGE"',
      'echo "plain=$(bash -c \'"$LEASE" live --root "$ROOT" --exclude-ancestry-of $$\')"',
      'echo "shared=$(bash -c \'"$LEASE" live --root "$ROOT" --exclude-ancestry-of $$ --count-shared-harness\')"',
      'echo "pid=$$"',
    ].join('\n');
    const go = (age: number) => spawnSync(harness, ['-c', script], { encoding: 'utf8', env: { ...baseEnv, LEASE, ROOT: dir, AGE: String(age), BUN: process.execPath }, timeout: 30_000 }).stdout;
    const fresh = go(0);
    const pid = fresh.match(/^pid=(\d+)$/m)![1];
    expect(fresh).toMatch(/^plain=$/m);
    expect(fresh).toMatch(new RegExp(`^shared=${pid} 0m capy-server$`, 'm'));
    fs.rmSync(leases, { recursive: true, force: true });
    const aged = go(121);
    expect(aged).toMatch(/^plain=$/m);
    expect(aged).toMatch(/^shared=$/m);
  });

  test('touch without --pid uses the same harness pid gstack-skill-start derives (this process past the tool-call shell)', () => {
    const { dir, leases } = checkout();
    const r = spawnSync('bash', ['-c', `"$LEASE" touch --root "$ROOT"; true`], {
      encoding: 'utf8', env: { ...baseEnv, LEASE, ROOT: dir }, timeout: 30_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(leases)).toEqual([String(process.pid)]);
  });

  test('a directory that is not a git checkout fails closed for the caller (exit 2) and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-plain-'));
    dirs.push(dir);
    const r = run(['touch', '--root', dir, '--pid', '1']);
    expect(r.status).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(run(['live', '--root', dir]).status).toBe(2);
  });

  test('gstack-skill-start touches the lease for its --parent-pid (GSTACK_LEASE_DIR hermetic), fail-open', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-home-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-state-'));
    dirs.push(home, state);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\n');
    const leaseDir = path.join(state, 'leases');
    const lease = path.join(leaseDir, '424243');
    try {
      const r = spawnSync(START, ['--skill', 'testskill', '--parent-pid', '424243'], {
        encoding: 'utf8', cwd: home, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state, GSTACK_LEASE_DIR: leaseDir }, timeout: 30_000,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(fs.existsSync(path.join(state, 'sessions', '424243'))).toBe(true);
      expect(fs.existsSync(lease), lease).toBe(true);
    } finally {
      fs.rmSync(lease, { force: true });
    }
  });

  test('gstack-skill-start reports a lease the held lock kept from being written, and still starts', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-home-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-state-'));
    dirs.push(home, state);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\n');
    const leaseDir = path.join(state, 'leases');
    fs.mkdirSync(leaseDir);
    plantLock(path.join(leaseDir, '.lock'), `${sleeper()} `);
    const r = spawnSync(START, ['--skill', 'testskill', '--parent-pid', '424244'], {
      encoding: 'utf8', cwd: home, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state, GSTACK_LEASE_DIR: leaseDir, GSTACK_LEASE_LOCK_TRIES: '2' }, timeout: 30_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain('this session holds no workflow lease');
    expect(fs.existsSync(path.join(leaseDir, '424244'))).toBe(false);
  });
});

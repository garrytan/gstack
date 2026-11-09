/**
 * capy/skill/gstack/: the vendored Capy skill. scripts/install.sh is the
 * frozen bootstrapper the Drive copy holds: it prints its wrapper revision
 * first, learns the supported minimum from origin's default branch
 * (`git show FETCH_HEAD:capy/support.env`), fast-forwards a clean, unpinned
 * checkout below that minimum in install mode only (--check never moves the
 * checkout), and execs the checkout's own full wrapper, bin/gstack-capy-session,
 * handing over the held install lock (GSTACK_CAPY_LOCK_HELD=1). Pinned on the
 * machine lines (`gstack-capy-skill: wrapper|upgraded|owner action`, the
 * `gstack:` trailer as the last line), exit codes and HEAD before/after.
 * Fixture: a bare remote whose main moves from A (1.0.0, no capy/ directory:
 * an old checkout) to B (1.0.1, capy/support.env minimum 1.0.1, the vendored
 * scripts and a stub bin/gstack-capy-install that logs argv and env), a
 * depth-1 file:// clone at A, on the simulated Capy host.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MODEL_FAMILIES } from '../lib/agent-model';
import { capyBootstrapCommand } from '../lib/doctor-components';
import { RESULT_CODES } from '../lib/result-codes';
import { capyHost, pathWithout, type CapyHost } from './helpers/capy-host';

const REPO = path.resolve(import.meta.dir, '..');
const SKILL = path.join(REPO, 'capy/skill/gstack');
const BOOT = path.join(SKILL, 'scripts/install.sh');
const hosts: CapyHost[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.cleanup(); });

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};
const envValue = (text: string, key: string) => text.match(new RegExp(`^${key}=([0-9.]+)`, 'm'))?.[1] ?? '';
const below = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};

const STUB_INSTALLER = [
  '#!/usr/bin/env bash',
  'echo "installer $* lock=${GSTACK_CAPY_LOCK_HELD:-} rev=${GSTACK_CAPY_WRAPPER_REV:-} min=${GSTACK_CAPY_REMOTE_MIN:-} from=${GSTACK_CAPY_UPGRADED_FROM:-}" >> "$WRAP_LOG"',
  'echo "channel=${GSTACK_UPDATE_CHANNEL:-}" >> "$WRAP_LOG.channel"',
  'cd "$(dirname "$0")/.."',
  'if [ "${1:-}" != --check ] && [ -f "$WRAP_FAIL_ONCE" ]; then rm -f "$WRAP_FAIL_ONCE"; echo "gstack: fail claude"; exit 1; fi',
  'echo "GSTACK_LAUNCH: GSTACK_SESSION_KIND=unattended GSTACK_CAPY=1"',
  'echo "gstack: ok $(cat VERSION) for=autoplan"',
].join('\n') + '\n';

/** What bin/gstack-capy-session's self-upgrade runs: bin/gstack-upgrade and its sourced helpers. */
const UPGRADE_DEPS = [
  'bin/gstack-upgrade', 'bin/gstack-bun-version.sh', 'bin/gstack-paths', 'bin/gstack-state-root.sh',
  'bin/gstack-egress-lib.sh', 'bin/gstack-egress-receipt', 'lib/egress-receipt.ts', 'lib/state-root.ts',
  'bin/gstack-lease', 'bin/gstack-harness-pid.sh',
  // Sourced by gstack-upgrade: without gstack-config in the fixture it resolves main unless GSTACK_UPDATE_CHANNEL says stable.
  'bin/gstack-update-channel.sh',
];

/**
 * cloneAt 'A' (default): the clone sits at A (1.0.0), below B's minimum 1.0.1.
 * cloneAt 'B': the clone sits at B, AT the minimum, and the remote moves on to
 * C (1.0.2, minimum unchanged): behind origin but not below the floor.
 * next: the remote moves on to C for a clone at A too. stable: origin's stable
 * branch (the release, docs/releases.md) at that commit. configStable: B and later
 * carry a bin/gstack-config stub whose update_channel is stable (a machine whose
 * own config, or team mode, would follow the release). nextAgeHours: C's commit
 * date that many hours ago (a checkout at B is that stale).
 */
function fixture(opts: { minWrapper?: number; cloneAt?: 'A' | 'B'; next?: boolean; stable?: 'A' | 'B' | 'C'; configStable?: boolean; nextAgeHours?: number } = {}) {
  const host = capyHost({ systemBun: '1.4.2' });
  hosts.push(host);
  const git = (args: string[], cwd: string, extra: Record<string, string> = {}) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...host.env, ...extra }, timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const log = path.join(host.base, 'wrap.log');
  const seed = path.join(host.base, 'seed');
  const bare = path.join(host.base, 'remote.git');
  fs.mkdirSync(seed, { recursive: true });
  git(['init', '-q', '-b', 'main'], seed);
  write(path.join(seed, 'VERSION'), '1.0.0\n');
  write(path.join(seed, 'README.md'), 'old gstack\n');
  write(path.join(seed, 'setup'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'A'], seed);
  const a = git(['rev-parse', 'HEAD'], seed);
  git(['init', '-q', '--bare', '-b', 'main', bare], host.base);
  git(['push', '-q', bare, 'main'], seed);
  const root = path.join(host.base, 'gstack');
  if ((opts.cloneAt ?? 'A') === 'A') git(['clone', '-q', '--single-branch', '--depth', '1', `file://${bare}`, root], host.base);
  write(path.join(seed, 'VERSION'), '1.0.1\n');
  write(path.join(seed, 'capy/support.env'), `GSTACK_MIN_REVISION=1.0.1\nGSTACK_CAPY_MIN_WRAPPER=${opts.minWrapper ?? 1}\n`);
  for (const rel of ['capy/skill/gstack/scripts/install.sh', 'capy/skill/gstack/SKILL.md', 'bin/gstack-capy-session', 'bin/gstack-install-verdict.sh', 'bin/gstack-doctor-components.sh', ...UPGRADE_DEPS]) {
    if (fs.existsSync(path.join(REPO, rel))) write(path.join(seed, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'), 0o755);
  }
  write(path.join(seed, 'bin/gstack-capy-install'), STUB_INSTALLER, 0o755);
  if (opts.configStable) write(path.join(seed, 'bin/gstack-config'), '#!/usr/bin/env bash\n[ "$1 $2" = "get update_channel" ] && echo stable\nexit 0\n', 0o755);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'B'], seed);
  const b = git(['rev-parse', 'HEAD'], seed);
  git(['push', '-q', bare, 'main'], seed);
  let c = '';
  if (opts.cloneAt === 'B' || opts.next) {
    if (opts.cloneAt === 'B') git(['clone', '-q', '--single-branch', '--depth', '1', `file://${bare}`, root], host.base);
    write(path.join(seed, 'VERSION'), '1.0.2\n');
    const at = opts.nextAgeHours ? `@${Math.floor(Date.now() / 1000) - opts.nextAgeHours * 3600 - 60} +0000` : '';
    git(['commit', '-qam', 'C'], seed, at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {});
    c = git(['rev-parse', 'HEAD'], seed);
    git(['push', '-q', bare, 'main'], seed);
  }
  if (opts.stable) git(['push', '-q', bare, `${{ A: a, B: b, C: c }[opts.stable]}:refs/heads/stable`], seed);
  const env = { ...host.env, GSTACK_CAPY_ROOT: root, GSTACK_CAPY_REPO: `file://${bare}`, WRAP_LOG: log, WRAP_FAIL_ONCE: path.join(host.base, 'fail-once') };
  const run = (args: string[] = [], extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [BOOT, ...args], { cwd: host.home, encoding: 'utf8', env: { ...env, ...extra }, timeout: 120_000 });
    const lines = r.stdout.trim().split('\n');
    return { ...r, lines, last: lines.at(-1) ?? '' };
  };
  return {
    host, root, bare, a, b, c, run, git: (args: string[]) => git(args, root),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
    channels: () => fs.existsSync(log + '.channel') ? fs.readFileSync(log + '.channel', 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

describe('capy skill bootstrapper (capy/skill/gstack/scripts/install.sh)', () => {
  test('the first line names the wrapper revision and path; bash -n passes for the bootstrapper and the full wrapper', () => {
    for (const file of [BOOT, path.join(REPO, 'bin/gstack-capy-session')]) {
      expect(fs.existsSync(file), file).toBe(true);
      const r = spawnSync('bash', ['-n', file], { encoding: 'utf8', timeout: 30_000 });
      expect(r.status, `${file}: ${r.stderr}`).toBe(0);
    }
    const f = fixture();
    const r = f.run(['--check', '--for', 'autoplan']);
    expect(r.lines[0]).toMatch(new RegExp(`^gstack-capy-skill: wrapper \\d+ \\(${BOOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`));
  });

  test('below the remote minimum: --check is read-only and names the fast-forwarding command; install fast-forwards, installs and ends ok; the next session start is ok without moving', () => {
    const f = fixture();
    expect(f.git(['rev-parse', '--is-shallow-repository'])).toBe('true');
    const check = f.run(['--check', '--for', 'autoplan']);
    expect(check.status, check.stdout + check.stderr).toBe(1);
    expect(check.last).toBe(`gstack: fail revision — installed 1.0.0 is below the supported minimum 1.0.1 (fast-forward available); fix: bash ${BOOT} --for autoplan (fast-forwards) (REVISION_BELOW_MINIMUM)`);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    expect(f.calls()).toEqual([]);

    const install = f.run(['--for', 'autoplan']);
    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect(install.stdout).toContain('gstack-capy-skill: upgraded 1.0.0 -> 1.0.1');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(f.git(['rev-parse', '--is-shallow-repository'])).toBe('true');
    expect(install.last).toBe('gstack: ok 1.0.1 for=autoplan');
    expect(f.calls()).toEqual([`installer --root ${f.root} --for autoplan lock=1 rev=5 min=1.0.1 from=1.0.0`]);

    const next = f.run(['--check', '--for', 'autoplan']);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).not.toContain('upgraded');
    expect(next.last).toBe('gstack: ok 1.0.1 for=autoplan');
    expect(f.calls().at(-1)).toBe(`installer --check --root ${f.root} --for autoplan lock= rev=5 min=1.0.1 from=`);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
  });

  test('dirty, pinned, diverged or auto-upgrade disabled: no change, fail revision names the cause and the exact commands', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'README.md'), 'local edit\n');
    const dirty = f.run(['--for', 'autoplan']);
    expect(dirty.status).toBe(1);
    expect(dirty.last).toMatch(/^gstack: fail revision — installed 1\.0\.0 is below the supported minimum 1\.0\.1 \(tracked files changed: README\.md\); fix: .*git -C \S+ status --short.*\(REVISION_BELOW_MINIMUM\)$/);
    expect(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8')).toBe('local edit\n');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    f.git(['checkout', '-q', '--', 'README.md']);

    const pinned = f.run(['--for', 'autoplan', '--revision', f.a]);
    expect(pinned.status).toBe(1);
    expect(pinned.last).toContain('(pinned by --revision');
    f.git(['checkout', '-q', '--detach', 'HEAD']);
    const detached = f.run(['--for', 'autoplan']);
    expect(detached.last).toContain('(pinned: HEAD is detached');
    f.git(['checkout', '-q', 'main']);

    const disabled = f.run(['--for', 'autoplan'], { GSTACK_CAPY_AUTO_UPGRADE: '0' });
    expect(disabled.status).toBe(1);
    expect(disabled.last).toContain('(auto-upgrade disabled)');
    expect(disabled.last).toContain('GSTACK_CAPY_AUTO_UPGRADE');

    fs.writeFileSync(path.join(f.root, 'README.md'), 'local commit\n');
    f.git(['commit', '-qam', 'local']);
    const head = f.git(['rev-parse', 'HEAD']);
    const diverged = f.run(['--for', 'autoplan']);
    expect(diverged.status).toBe(1);
    expect(diverged.last).toContain('(diverged: ');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(f.git(['stash', 'list'])).toBe('');
    expect(f.calls()).toEqual([]);
  });

  test('an interrupted install after the fast-forward leaves the trailer fail; the next install run completes it', () => {
    const f = fixture();
    write(path.join(f.host.base, 'fail-once'), '1');
    const first = f.run(['--for', 'autoplan']);
    expect(first.status).toBe(1);
    expect(first.last).toBe('gstack: fail claude');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    const second = f.run(['--for', 'autoplan']);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.last).toBe('gstack: ok 1.0.1 for=autoplan');
  });

  test('offline: the remote minimum is unknown and said so; an old checkout is never ok', () => {
    const f = fixture();
    fs.renameSync(f.bare, `${f.bare}.gone`);
    const old = f.run(['--check', '--for', 'autoplan']);
    expect(old.status).toBe(1);
    expect(old.stdout).toContain('remote minimum unknown (fetch failed)');
    expect(old.last).toMatch(/^gstack: fail /);
    fs.renameSync(`${f.bare}.gone`, f.bare);
    expect(f.run(['--for', 'autoplan']).status).toBe(0);
    fs.renameSync(f.bare, `${f.bare}.gone`);
    const current = f.run(['--check', '--for', 'autoplan']);
    expect(current.stdout).toContain('remote minimum unknown (fetch failed)');
    expect(f.calls().at(-1)).toContain('min=unknown');
  });

  test('a stale bootstrapper still runs the checkout wrapper and names the owner action', () => {
    const f = fixture({ minWrapper: 99 });
    const r = f.run(['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^gstack-capy-skill: owner action — Drive copy is wrapper \\d+, minimum 99; copy ${f.root}/capy/skill/gstack/ \\(CAPY_WRAPPER_STALE\\)$`, 'm'));
    expect(r.last).toBe('gstack: ok 1.0.1 for=autoplan');
  });

  test('no checkout: --check records the not-installed trailer; install clones and runs the checkout wrapper', () => {
    const f = fixture();
    fs.rmSync(f.root, { recursive: true, force: true });
    const check = f.run(['--check', '--for', 'autoplan']);
    expect(check.status).toBe(1);
    expect(check.last).toBe(`gstack: fail not-installed — no gstack checkout at ${f.root}; fix: bash ${BOOT} --for autoplan (installs; on a machine without this skill: ${capyBootstrapCommand('autoplan', f.root)})`);
    const install = f.run(['--for', 'autoplan']);
    expect(install.status, install.stdout + install.stderr).toBe(0);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(install.last).toBe('gstack: ok 1.0.1 for=autoplan');
  });

  test('--for none: a coordinator machine gets ok not-needed (exit 0) with or without a checkout, nothing is cloned, moved or certified, and the trailer admits no workflow', () => {
    const f = fixture();
    const withCheckout = f.run(['--check', '--for', 'none']);
    expect(withCheckout.status, withCheckout.stdout + withCheckout.stderr).toBe(0);
    expect(withCheckout.last).toBe(`gstack: ok not-needed for=none (checkout 1.0.0 at ${f.root}, not certified; latest: 1.0.1; before the first workflow run: bash ${BOOT} --for <skill>)`);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    expect(f.calls()).toEqual([]);
    // Install mode with --for none is check-only too: an old checkout below the minimum is reported, never fast-forwarded.
    const installMode = f.run(['--for', 'none']);
    expect(installMode.status).toBe(0);
    expect(installMode.last).toBe(withCheckout.last);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    fs.rmSync(f.root, { recursive: true, force: true });
    const none = f.run(['--check', '--for', 'none']);
    expect(none.status).toBe(0);
    expect(none.last).toBe(`gstack: ok not-needed for=none (no checkout at ${f.root}; before the first workflow run: bash ${BOOT} --for <skill>)`);
    expect(fs.existsSync(f.root)).toBe(false);
  });
});

describe('capy skill: always current when online (the minimum is the floor, not the trigger)', () => {
  test('install mode: a clean checkout at the minimum but behind origin is fast-forwarded by the checkout half and installed from the new revision; the next start is current', () => {
    const f = fixture({ cloneAt: 'B' });
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(f.git(['rev-parse', '--is-shallow-repository'])).toBe('true');
    const r = f.run(['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain('gstack-capy-skill: upgraded');
    expect(r.stdout).toContain('gstack-upgrade: upgraded 1.0.1 -> 1.0.2');
    expect(r.stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
    expect(r.last).toBe('gstack: ok 1.0.2 for=autoplan');
    expect(f.calls()).toEqual([`installer --root ${f.root} --for autoplan lock=1 rev=5 min=1.0.1 from=1.0.1`]);
    expect(fs.existsSync(path.join(f.root, '.git/gstack-upgrade.pending'))).toBe(false);

    const next = f.run(['--for', 'autoplan']);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).toMatch(/^SELF_UPGRADE: none \(current\)$/m);
    expect(next.stdout).not.toContain('SELF_UPGRADE: done');
    expect(next.last).toBe('gstack: ok 1.0.2 for=autoplan');
    expect(f.calls().at(-1)).toBe(`installer --root ${f.root} --for autoplan lock=1 rev=5 min=1.0.1 from=`);
  });

  test('--check mode never moves a behind checkout: it names the gap and the fast-forwarding command, then certifies the installed revision', () => {
    const f = fixture({ cloneAt: 'B' });
    const r = f.run(['--check', '--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^gstack-capy-session: behind origin/main: 1\\.0\\.1 -> 1\\.0\\.2 \\(1 commits\\); fix: bash ${BOOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --for autoplan \\(fast-forwards\\)$`, 'm'));
    expect(r.stdout).not.toContain('SELF_UPGRADE');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(r.last).toBe('gstack: ok 1.0.1 for=autoplan');
    expect(f.calls()).toEqual([`installer --check --root ${f.root} --for autoplan lock= rev=5 min=1.0.1 from=`]);
  });

  test('a dirty behind checkout is skipped with gstack-upgrade\'s reason and still ends ok: above the floor, the trailer is the doctor\'s', () => {
    const f = fixture({ cloneAt: 'B' });
    fs.writeFileSync(path.join(f.root, 'README.md'), 'local edit\n');
    const r = f.run(['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SELF_UPGRADE: skipped \(tracked files changed: README\.md.*\)$/m);
    expect(r.stdout).not.toContain('SELF_UPGRADE: done');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8')).toBe('local edit\n');
    expect(r.last).toBe('gstack: ok 1.0.1 for=autoplan');
    expect(f.calls()).toEqual([`installer --root ${f.root} --for autoplan lock=1 rev=5 min=1.0.1 from=`]);
  });

  test('GSTACK_CAPY_SELF_UPGRADE=off and GSTACK_CAPY_AUTO_UPGRADE=0 each disable the fast-forward by name and leave HEAD where it is', () => {
    const f = fixture({ cloneAt: 'B' });
    const off = f.run(['--for', 'autoplan'], { GSTACK_CAPY_SELF_UPGRADE: 'off' });
    expect(off.status, off.stdout + off.stderr).toBe(0);
    expect(off.stdout).toMatch(/^SELF_UPGRADE: disabled \(GSTACK_CAPY_SELF_UPGRADE\)$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    const auto = f.run(['--for', 'autoplan'], { GSTACK_CAPY_AUTO_UPGRADE: '0' });
    expect(auto.status, auto.stdout + auto.stderr).toBe(0);
    expect(auto.stdout).toMatch(/^SELF_UPGRADE: disabled \(GSTACK_CAPY_AUTO_UPGRADE\)$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(auto.last).toBe('gstack: ok 1.0.1 for=autoplan');
  });
});

// Plan A9: the `latest:` trailer note comes only from origin's VERSION the
// bootstrapper read in this run; a FETCH_HEAD left by an earlier run never
// reaches the installer.
describe('capy skill bootstrapper: the update channel (wrapper 4, docs/releases.md#channels)', () => {
  // Value: protects=an install that follows stable (GSTACK_UPDATE_CHANNEL=stable; from wrapper 5 the machine's own channel no longer counts) is cloned at
  // origin's stable branch, not main, and stays there through the checkout half's self-upgrade; GSTACK_UPDATE_CHANNEL=main and a remote with no stable
  // branch (before the first release) clone main; fails_when=a fresh team install lands on unreleased main, the override cannot pick main, or a missing
  // stable branch fails the install; why_new=the clone test covers the default branch only; seam=GSTACK_UPDATE_CHANNEL instead of gstack-config's
  // team_mode; no_claim=GitHub's real stable branch
  test('a fresh clone follows stable when origin has it; GSTACK_UPDATE_CHANNEL=main and a missing stable branch clone main', () => {
    const f = fixture({ cloneAt: 'B', stable: 'B' });
    fs.rmSync(f.root, { recursive: true, force: true });
    const stable = f.run(['--for', 'autoplan'], { GSTACK_UPDATE_CHANNEL: 'stable' });
    expect(stable.status, stable.stdout + stable.stderr).toBe(0);
    expect(stable.stdout).toContain('gstack-capy-skill: channel stable 1.0.1 (GSTACK_UPDATE_CHANNEL=main follows every merge)');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(stable.last).toBe('gstack: ok 1.0.1 for=autoplan');

    fs.rmSync(f.root, { recursive: true, force: true });
    const main = f.run(['--for', 'autoplan'], { GSTACK_UPDATE_CHANNEL: 'main' });
    expect(main.status, main.stdout + main.stderr).toBe(0);
    expect(main.stdout).not.toContain('channel stable');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);

    spawnSync('git', ['--git-dir', f.bare, 'update-ref', '-d', 'refs/heads/stable'], { env: f.host.env, timeout: 30_000 });
    fs.rmSync(f.root, { recursive: true, force: true });
    const bootstrap = f.run(['--for', 'autoplan'], { GSTACK_UPDATE_CHANNEL: 'stable' });
    expect(bootstrap.status, bootstrap.stdout + bootstrap.stderr).toBe(0);
    expect(bootstrap.stdout).toContain('channel stable, but origin has no stable branch yet (or the fetch failed); following main');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
  });

  // Value: protects=the bootstrapper's floor fast-forward of a checkout below the supported minimum goes to stable on the stable channel when stable
  // meets the minimum, and to main when stable is itself below it; fails_when=a stable install is pushed past the release to main, or left below the
  // floor because stable is too old; why_new=the floor tests cover main only; seam=GSTACK_UPDATE_CHANNEL; no_claim=GitHub's real stable branch
  test('below the floor: the fast-forward goes to stable when stable meets the minimum, else to main', () => {
    const atRelease = fixture({ next: true, stable: 'B' });
    const r = atRelease.run(['--for', 'autoplan'], { GSTACK_UPDATE_CHANNEL: 'stable' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('gstack-capy-skill: upgraded 1.0.0 -> 1.0.1');
    expect(atRelease.git(['rev-parse', 'HEAD'])).toBe(atRelease.b);

    const old = fixture({ next: true, stable: 'A' });
    const o = old.run(['--for', 'autoplan'], { GSTACK_UPDATE_CHANNEL: 'stable' });
    expect(o.status, o.stdout + o.stderr).toBe(0);
    expect(o.stdout).toContain('gstack-capy-skill: channel stable is at 1.0.0, below the supported minimum 1.0.1; following main');
    expect(old.git(['rev-parse', 'HEAD'])).toBe(old.c);
  });
});

describe('capy skill bootstrapper: Capy crews stay on main (wrapper 5, docs/releases.md#channels)', () => {
  // Value: protects=a fresh Capy machine clones main and runs the installer (./setup's first-install record) under GSTACK_UPDATE_CHANNEL=main even when
  // the checkout's config would pick stable; fails_when=a Capy clone lands on the release, or setup on a fresh machine records stable; why_new=GST-1642
  // makes stable the default for new installs, which Capy crews must not inherit; seam=a gstack-config stub saying stable; no_claim=GitHub's stable branch
  test('a fresh machine clones main and installs under the main pin, whatever the machine config says', () => {
    const f = fixture({ cloneAt: 'B', stable: 'B', configStable: true });
    fs.rmSync(f.root, { recursive: true, force: true });
    const r = f.run(['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.lines[0]).toStartWith('gstack-capy-skill: wrapper 5 ');
    expect(r.stdout).not.toContain('channel stable');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
    expect(f.channels()).toEqual(['channel=main']);
  });

  // Value: protects=an existing checkout behind origin self-upgrades to main's tip under the main pin although its config names stable, and
  // GSTACK_UPDATE_CHANNEL=stable still keeps it on the release; fails_when=an existing Capy checkout parks at the release or the override is ignored;
  // why_new=GST-1642; seam=a gstack-config stub saying stable; no_claim=a Drive copy older than wrapper 5 (the checkout half pins main for it too)
  test('an existing checkout self-upgrades to main, not the release its config names; GSTACK_UPDATE_CHANNEL=stable still follows stable', () => {
    const f = fixture({ cloneAt: 'B', stable: 'B', configStable: true });
    const r = f.run(['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('SELF_UPGRADE: done 1.0.1 -> 1.0.2');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
    expect(f.channels()).toEqual(['channel=main']);

    const pinned = fixture({ cloneAt: 'B', stable: 'B', configStable: true });
    const s = pinned.run(['--for', 'autoplan'], { GSTACK_UPDATE_CHANNEL: 'stable' });
    expect(s.status, s.stdout + s.stderr).toBe(0);
    expect(pinned.git(['rev-parse', 'HEAD'])).toBe(pinned.b);
    expect(pinned.channels()).toEqual(['channel=stable']);
  });
});

describe('capy skill bootstrapper: GSTACK_CAPY_REMOTE_VERSION', () => {
  test('a fresh fetch exports origin\'s VERSION; a failed fetch exports nothing even with a stale FETCH_HEAD', () => {
    const f = fixture({ cloneAt: 'B' });
    write(path.join(f.root, 'bin/gstack-capy-install'), '#!/usr/bin/env bash\necho "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan remote=${GSTACK_CAPY_REMOTE_VERSION:-none}"\n', 0o755);
    const fresh = f.run(['--check', '--for', 'autoplan'], { GSTACK_CAPY_REMOTE_VERSION: 'from-parent' });
    expect(fresh.last).toBe('gstack: ok 1.0.1 for=autoplan remote=1.0.2');
    expect(f.git(['show', 'FETCH_HEAD:VERSION'])).toBe('1.0.2');
    f.git(['remote', 'set-url', 'origin', `file://${f.host.base}/missing.git`]);
    const stale = f.run(['--check', '--for', 'autoplan'], { GSTACK_CAPY_REMOTE_VERSION: 'from-parent' });
    expect(stale.stdout).toContain('remote minimum unknown (fetch failed)');
    expect(stale.last).toBe('gstack: ok 1.0.1 for=autoplan remote=none');
  });
});

// Field list 2 item 13: lanes relay only the trailer, so a session that ends
// behind origin hands the installer the gap and the fix for its trailer note.
describe('capy skill: the session hands the installer GSTACK_CAPY_BEHIND', () => {
  const ENV_INSTALLER = '#!/usr/bin/env bash\necho "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan behind=${GSTACK_CAPY_BEHIND:-none} to=${GSTACK_CAPY_BEHIND_TO:-none} fix=${GSTACK_CAPY_BEHIND_FIX:-none}${GSTACK_CAPY_BEHIND_BLOCKED:+ blocked=$GSTACK_CAPY_BEHIND_BLOCKED}"\n';
  const rerun = `bash ${BOOT} --for autoplan`;

  test('--check behind origin: the commit count, origin\'s VERSION and the fast-forwarding command; a checkout the rerun would not move points at gstack-upgrade', () => {
    const f = fixture({ cloneAt: 'B' });
    write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    const r = f.run(['--check', '--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 to=1.0.2 fix=${rerun}`);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    fs.writeFileSync(path.join(f.root, 'README.md'), 'local edit\n');
    expect(f.run(['--check', '--for', 'autoplan']).last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 to=1.0.2 fix=${f.root}/bin/gstack-upgrade`);
    f.git(['checkout', '-q', '--', 'README.md']);
    f.git(['checkout', '-q', '--detach']);
    expect(f.run(['--check', '--for', 'autoplan']).last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 to=1.0.2 fix=${f.root}/bin/gstack-upgrade`);
    f.git(['checkout', '-q', '-b', 'topic']);
    expect(f.run(['--check', '--for', 'autoplan']).last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 to=1.0.2 fix=${f.root}/bin/gstack-upgrade`);
    f.git(['checkout', '-q', 'main']);
    expect(f.run(['--check', '--for', 'autoplan']).stdout).toMatch(/^gstack-capy-session: behind origin\/main: 1\.0\.1 -> 1\.0\.2 \(1 commits\); fix: bash .+ --for autoplan \(fast-forwards\)$/m);
    expect(f.run(['--check', '--for', 'autoplan'], { GSTACK_CAPY_AUTO_UPGRADE: '0' }).last).toContain('fix=unset GSTACK_CAPY_AUTO_UPGRADE, then ');
  });

  test('install mode: a skipped self-upgrade points at gstack-upgrade (which names its refusal); a disabled one names the variable to unset; no fix carries the "; " note separator', () => {
    const f = fixture({ cloneAt: 'B' });
    write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
    const skipped = f.run(['--for', 'autoplan']);
    expect(skipped.stdout).toMatch(/^SELF_UPGRADE: skipped \(tracked files changed: bin\/gstack-capy-install; fix: .+\)$/m);
    expect(skipped.last).toMatch(new RegExp(`^gstack: ok 1\\.0\\.1 for=autoplan behind=1 to=1\\.0\\.2 fix=${f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/gstack-upgrade blocked=tracked files changed: bin/gstack-capy-install; fix: .+ \\(UPGRADE_REFUSED\\)$`));
    const disabled = f.run(['--for', 'autoplan'], { GSTACK_CAPY_SELF_UPGRADE: 'off' });
    expect(disabled.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 to=1.0.2 fix=unset GSTACK_CAPY_SELF_UPGRADE, then ${rerun}`);
    for (const r of [skipped, disabled]) expect(r.last.split(' fix=')[1].split(' blocked=')[0]).not.toContain('; ');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
  });

  // GBRA-105 / GBRA-106: a lease naming a pid that a machine wake handed to
  // another process wedged every upgrade, and the skipped upgrade still ended ok.
  test('install mode: a lease whose pid was reused is reclaimed and the checkout upgrades; a live holder blocks it and the session hands the installer the busy reason with the holder', () => {
    const f = fixture({ cloneAt: 'B' });
    write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    const leaseDir = path.join(f.host.base, 'leases');
    const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      const lease = (args: string[]) => spawnSync('bash', [path.join(f.root, 'bin/gstack-lease'), ...args, '--root', f.root], { encoding: 'utf8', env: { ...f.host.env, GSTACK_LEASE_DIR: leaseDir }, timeout: 30_000 });
      expect(lease(['touch', '--pid', String(holder.pid)]).status).toBe(0);
      const busy = f.run(['--for', 'autoplan'], { GSTACK_LEASE_DIR: leaseDir });
      expect(busy.stdout).toMatch(new RegExp(`^SELF_UPGRADE: skipped \\(live gstack sessions hold this installation: pid ${holder.pid} \\(\\d+m sleep\\); fix: .+ \\(UPGRADE_BUSY\\)\\)$`, 'm'));
      expect(busy.last).toMatch(new RegExp(`behind=1 to=1\\.0\\.2 fix=.+ blocked=live gstack sessions hold this installation: pid ${holder.pid} \\(\\d+m sleep\\); fix: .+GSTACK_UPGRADE_FORCE=1.+ \\(UPGRADE_BUSY\\)$`));
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
      const file = path.join(leaseDir, String(holder.pid));
      const recorded = fs.readFileSync(file, 'utf8').trim();
      fs.writeFileSync(file, (recorded.startsWith('linux ') ? recorded.replace(/\d+$/, (n) => String(Number(n) + 1)) : 'ps Thu Jan  1 00:00:00 1970') + '\n');
      const reclaimed = f.run(['--for', 'autoplan'], { GSTACK_LEASE_DIR: leaseDir });
      expect(reclaimed.stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  // #3571: /ship's docs step ran install.sh --for document-release from inside the run that
  // holds the lease, the upgrader excluded its own ancestry, and the checkout moved mid-/ship.
  // On Capy the leased pid is the long-lived capy-server, so the deferral ends by the lease's age.
  test('install mode inside a run that holds a fresh workflow lease: the self-upgrade is deferred, HEAD stays and the trailer stays ok; once that lease is 120 minutes old the same install upgrades', () => {
    const f = fixture({ cloneAt: 'B' });
    write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    const leaseDir = path.join(f.host.base, 'leases');
    const script = [
      'bash "$1" touch --pid $$ --root "$2" || exit 9',
      'bash "$3" --for document-release; echo "exit=$?"',
      'git -C "$2" rev-parse HEAD',
      '"$5" -e "const t = Date.now() / 1000 - 121 * 60; require(\'fs\').utimesSync(process.argv[1], t, t)" "$4/$$"',
      'bash "$3" --for document-release; echo "exit=$?"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script, 'run', path.join(f.root, 'bin/gstack-lease'), f.root, BOOT, leaseDir, process.execPath], { cwd: f.host.home, encoding: 'utf8', env: { ...f.host.env, GSTACK_CAPY_ROOT: f.root, GSTACK_CAPY_REPO: `file://${f.bare}`, WRAP_LOG: path.join(f.host.base, 'wrap.log'), GSTACK_LEASE_DIR: leaseDir }, timeout: 120_000 });
    const [inRun, aged] = r.stdout.split(/^exit=0$/m);
    expect(r.stdout.match(/^exit=0$/gm), r.stdout + r.stderr).toHaveLength(2);
    expect(inRun).toMatch(/^SELF_UPGRADE: skipped \(a gstack run in this session holds a workflow lease on this installation: pid \d+ \(0m bash\), so the upgrade waits until the lease is 120 minutes old; fix: .+bin\/gstack-upgrade once the lease is 120 minutes old, or GSTACK_UPGRADE_FORCE=1 .+bin\/gstack-upgrade when no other session uses this checkout \(UPGRADE_BUSY\)\)$/m);
    expect(inRun).not.toContain('SELF_UPGRADE: done');
    expect(inRun).toMatch(/blocked=a gstack run in this session holds a workflow lease .+ \(UPGRADE_BUSY\)$/m);
    expect(aged).toContain(f.b);
    expect(aged).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
  });

  // GST-290: a dispatched reviewer's install ran with no lease of its own, fast-forwarded the
  // shared checkout and rewrote the verdict to for=review-voice, so the lane's next autoplan
  // admission refused (INSTALL_UNVERIFIED). A review-voice install never moves the checkout.
  describe('--for review-voice never self-upgrades a shared checkout', () => {
    const blocked = (root: string) => `review-voice never self-upgrades a shared checkout; fix: GSTACK_UPGRADE_FORCE=1 ${root}/bin/gstack-upgrade when no other session uses this checkout (UPGRADE_SKIPPED)`;
    const behindFixture = () => {
      const f = fixture({ cloneAt: 'B' });
      write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
      f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
      return f;
    };

    test('install mode behind origin with no lease: skipped with the reason, HEAD stays, and the installer gets behind, gstack-upgrade as the fix and the blocked reason', () => {
      const f = behindFixture();
      const r = f.run(['--for', 'review-voice']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(`SELF_UPGRADE: skipped (${blocked(f.root)})\n`);
      expect(r.stdout).not.toContain('SELF_UPGRADE: done');
      expect(r.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 to=1.0.2 fix=${f.root}/bin/gstack-upgrade blocked=${blocked(f.root)}`);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
      expect(f.run(['--for', 'review-voice'], { GSTACK_UPGRADE_FORCE: '1' }).stdout).toContain(`SELF_UPGRADE: skipped (${blocked(f.root)})\n`);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    });

    test('install mode behind origin with bin/gstack-doctor-components.sh missing: still skipped (the profile check fails closed for review-voice)', () => {
      const f = behindFixture();
      f.git(['update-index', '--assume-unchanged', 'bin/gstack-doctor-components.sh']);
      fs.rmSync(path.join(f.root, 'bin/gstack-doctor-components.sh'));
      const r = f.run(['--for', 'review-voice']);
      expect(r.stdout).toContain(`SELF_UPGRADE: skipped (${blocked(f.root)})\n`);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    });

    test('install mode on a current checkout: none (current), and no blocked reason', () => {
      const f = fixture({ cloneAt: 'B' });
      f.git(['fetch', '-q', 'origin', 'main']);
      f.git(['merge', '--ff-only', '-q', 'FETCH_HEAD']);
      write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
      f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
      const r = f.run(['--for', 'review-voice']);
      expect(r.stdout).toMatch(/^SELF_UPGRADE: none \(current\)$/m);
      expect(r.last).toBe('gstack: ok 1.0.2 for=autoplan behind=none to=none fix=none');
    });

    // GST-395: below the supported minimum every session's trailer on this checkout fails, so the
    // bootstrapper's fast-forward applies to a reviewer too; only above the floor does review-voice hold still.
    test('install mode below the floor: the bootstrapper fast-forwards to the minimum even for review-voice, and the session then has nothing to do', () => {
      const f = fixture();
      const r = f.run(['--for', 'review-voice']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('gstack-capy-skill: upgraded 1.0.0 -> 1.0.1');
      expect(r.stdout).toMatch(/^SELF_UPGRADE: none \(current\)$/m);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    });

    test('--check behind origin: the fix is gstack-upgrade, not the install rerun (which would not move a review-voice checkout)', () => {
      const f = behindFixture();
      const r = f.run(['--check', '--for', 'review-voice']);
      expect(r.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 to=1.0.2 fix=${f.root}/bin/gstack-upgrade`);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    });
  });

  // GST-396: gstack-upgrade now counts a fresh capy-server lease, but the session's own #3571 arm still decides first on Capy.
  test('install mode under a capy-server harness holding a fresh lease: the #3571 deferral message still wins (live keeps its meaning for the session)', () => {
    const f = fixture({ cloneAt: 'B' });
    write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    const leaseDir = path.join(f.host.base, 'leases');
    const harness = path.join(f.host.base, 'harness', 'capy-server');
    fs.mkdirSync(path.dirname(harness), { recursive: true });
    fs.copyFileSync(fs.realpathSync(spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8', timeout: 30_000 }).stdout.trim()), harness);
    fs.chmodSync(harness, 0o755);
    const script = ['bash "$1" touch --pid $$ --root "$2" || exit 9', 'bash "$3" --for document-release; echo "exit=$?"'].join('\n');
    const r = spawnSync(harness, ['-c', script, 'run', path.join(f.root, 'bin/gstack-lease'), f.root, BOOT], { cwd: f.host.home, encoding: 'utf8', env: { ...f.host.env, GSTACK_CAPY_ROOT: f.root, GSTACK_CAPY_REPO: `file://${f.bare}`, WRAP_LOG: path.join(f.host.base, 'wrap.log'), GSTACK_LEASE_DIR: leaseDir }, timeout: 120_000 });
    expect(r.stdout, r.stdout + r.stderr).toContain('exit=0');
    expect(r.stdout).toMatch(/^SELF_UPGRADE: skipped \(a gstack run in this session holds a workflow lease on this installation: pid \d+ \(0m capy-server\), so the upgrade waits until the lease is 120 minutes old; fix: .+ \(UPGRADE_BUSY\)\)$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
  });

  test('an older bootstrapper handing --for none to the session in install mode: the session certifies nothing and moves nothing (no self-upgrade, HEAD unchanged), and reports behind like --check', () => {
    const f = fixture({ cloneAt: 'B' });
    write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    f.git(['fetch', '-q', 'origin', 'main']);
    const r = spawnSync('bash', [path.join(f.root, 'bin/gstack-capy-session'), '--root', f.root, '--for', 'none'], { cwd: f.host.home, encoding: 'utf8', env: { ...f.host.env, GSTACK_CAPY_REMOTE_MIN: '1.0.1', GSTACK_CAPY_WRAPPER_REV: '2', GSTACK_CAPY_WRAPPER_PATH: BOOT }, timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/^SELF_UPGRADE:/m);
    expect(r.stdout.trim().split('\n').at(-1)).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 to=1.0.2 fix=bash ${BOOT} --for none`);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
  });

  test('current, or the fetch failed: nothing is exported, and values inherited from a parent session are dropped', () => {
    const f = fixture({ cloneAt: 'B' });
    f.git(['fetch', '-q', 'origin', 'main']);
    f.git(['merge', '--ff-only', '-q', 'FETCH_HEAD']);
    write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
    const inherited = { GSTACK_CAPY_BEHIND: '9', GSTACK_CAPY_BEHIND_TO: '9.9.9', GSTACK_CAPY_BEHIND_FIX: 'stale' };
    expect(f.run(['--check', '--for', 'autoplan'], inherited).last).toBe('gstack: ok 1.0.2 for=autoplan behind=none to=none fix=none');
    f.git(['reset', '-q', '--hard', f.b]);
    write(path.join(f.root, 'bin/gstack-capy-install'), ENV_INSTALLER, 0o755);
    f.git(['remote', 'set-url', 'origin', `file://${f.host.base}/missing.git`]);
    const offline = f.run(['--check', '--for', 'autoplan'], inherited);
    expect(offline.stdout).toContain('remote minimum unknown (fetch failed)');
    expect(offline.last).toBe('gstack: ok 1.0.1 for=autoplan behind=none to=none fix=none');
  });
});

describe('capy skill: vendored text and support file', () => {
  const support = fs.existsSync(path.join(REPO, 'capy/support.env')) ? fs.readFileSync(path.join(REPO, 'capy/support.env'), 'utf8') : '';
  test('the wrapper revision meets the checkout minimum; GSTACK_MIN_REVISION <= VERSION', () => {
    const wrapper = Number(fs.readFileSync(BOOT, 'utf8').match(/^GSTACK_CAPY_WRAPPER=(\d+)$/m)?.[1] ?? 0);
    expect(wrapper).toBeGreaterThanOrEqual(Number(envValue(support, 'GSTACK_CAPY_MIN_WRAPPER') || 999));
    const min = envValue(support, 'GSTACK_MIN_REVISION');
    expect(min).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(below(fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim(), min)).toBe(false);
  });

  test('SKILL.md: frontmatter, line cap, the session protocol tokens, and every command it names exists', () => {
    const text = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    expect(text).toMatch(/^---\nname: gstack\ndescription: .+\n---\n/);
    expect(text.split('\n').length).toBeLessThanOrEqual(90);
    for (const token of ['--check', 'GSTACK_LAUNCH', '^gstack: ok', 'gstack: fail not-installed', 'gstack-pregate sealed', 'autoplan/DRIVER.md', 'first report']) {
      expect(text, token).toContain(token);
    }
    const named = [...text.matchAll(/\b(?:bin\/)?(gstack-[a-z0-9-]+)\b/g)].map(m => m[1]).filter(n => n !== 'gstack-capy-skill');
    const missing = [...new Set(named)].filter(n => !fs.existsSync(path.join(REPO, 'bin', n)) && n !== 'gstack-pregate');
    expect(missing).toEqual([]);
    expect(fs.existsSync(path.join(REPO, 'bin/gstack-pregate'))).toBe(true);
  });

  test('every (CODE) the install-side bash bins print resolves to a troubleshooting anchor', () => {
    const bins = ['bin/gstack-capy-install', 'bin/gstack-upgrade', 'bin/gstack-capy-session', 'bin/gstack-install-verdict.sh', 'capy/skill/gstack/scripts/install.sh'];
    const codes = new Set<string>();
    for (const rel of bins) for (const m of fs.readFileSync(path.join(REPO, rel), 'utf8').matchAll(/\(([A-Z][A-Z0-9]+_[A-Z0-9_]+)[;)]/g)) codes.add(m[1]);
    for (const m of fs.readFileSync(path.join(REPO, 'bin/gstack-install-verdict.sh'), 'utf8').matchAll(/code=([A-Z][A-Z0-9_]+)/g)) codes.add(m[1]);
    expect([...codes].sort()).toEqual(expect.arrayContaining(['CAPY_WRAPPER_STALE', 'INSTALL_UNVERIFIED', 'REVISION_BELOW_MINIMUM', 'RUNTIME_BELOW_MINIMUM', 'UPGRADE_FETCH_FAILED', 'UPGRADE_REFUSED']));
    expect([...codes].filter(c => !(c in RESULT_CODES))).toEqual([]);
  });
});

describe('capy skill: factory.md, the auto-loaded "how we work" page', () => {
  const FACTORY = path.join(SKILL, 'factory.md');
  /** Problems with a factory page's citations: [path: Heading, Heading; path2], [/skill], and plain repo paths in prose. Bare SKILL.md is the sibling file. */
  function citationProblems(text: string): string[] {
    const problems: string[] = [];
    const headingsOf = (file: string) => new Set(fs.readFileSync(file, 'utf8').split('\n').filter(l => /^#{1,6} /.test(l)).map(l => l.replace(/^#+ /, '').trim()));
    const resolve = (p: string) => p === 'SKILL.md' ? path.join(SKILL, 'SKILL.md') : path.join(REPO, p);
    for (const m of text.matchAll(/\[([^\]]+)\]/g)) {
      for (const part of m[1].split(';').map(s => s.trim())) {
        if (part.startsWith('/')) {
          if (!fs.existsSync(path.join(REPO, part.slice(1), 'SKILL.md'))) problems.push(`unknown skill ${part}`);
          continue;
        }
        const [file, headings] = part.split(/:\s*/, 2);
        if (!fs.existsSync(resolve(file))) { problems.push(`missing file ${file}`); continue; }
        const known = headingsOf(resolve(file));
        const list = !headings ? [] : known.has(headings.trim()) ? [headings.trim()] : headings.split(',').map(s => s.trim()).filter(Boolean);
        for (const h of list) if (!known.has(h)) problems.push(`missing heading ${file}: ${h}`);
      }
    }
    for (const m of text.matchAll(/\b((?:capy|docs|lib|bin)\/[A-Za-z0-9_./-]+\.md)\b/g)) {
      if (!fs.existsSync(path.join(REPO, m[1]))) problems.push(`missing file ${m[1]}`);
    }
    return [...new Set(problems)];
  }

  test('it fits the 3,650-byte budget, and every citation, heading and skill it names resolves', () => {
    const text = fs.readFileSync(FACTORY, 'utf8');
    // 3,300 since #3634; raised to 3,450 (the page's new size, rounded up to the next 25 bytes) for point 12's
    // R68 clause (Garry, 2026-11-03: crew threads ask their Captain for new threads). Raise it only by what a rule needs.
    // 3,475 for the crew/ prefix on its four Captain-manual citations (GST-1833 moved docs/captain.md to crew/docs/; no rule text changed).
    // 3,650 for point 2's one-open-PR-per-lane rule and point 12's no-orphan and close-reason rule (GST-2077, Garry's "do it" 2026-11-09: lessons from gbrain's merge queue).
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3650);
    expect(text).toMatch(/^# How we work/);
    expect(citationProblems(text)).toEqual([]);
  });

  test('item 8 cites ETHOS.md principle 9, Earn Its Place, which states the fair test, the Why-null cycle and the safety exception', () => {
    const item8 = fs.readFileSync(FACTORY, 'utf8').split('\n').find(l => l.startsWith('8. '))!;
    expect(item8).toContain('[ETHOS.md: 9. Earn Its Place]');
    const ethos = fs.readFileSync(path.join(REPO, 'ETHOS.md'), 'utf8');
    const p9 = ethos.slice(ethos.indexOf('## 9. Earn Its Place'), ethos.indexOf('## How They Work Together'));
    expect(p9.length).toBeGreaterThan(200);
    for (const words of ['only include it if it is beneficial and good', 'claude_code', 'Opus 5.5', 'GPT-6.1 Sol', 'masked', 'Why null?', 'Safety and security guards', 'biggest', 'docs/inventory.md']) expect(p9).toContain(words);
  });

  test('negative controls: a missing file, a missing heading and an unknown skill are each caught', () => {
    expect(citationProblems('[docs/no-such-page.md: Anything]')).toEqual(['missing file docs/no-such-page.md']);
    expect(citationProblems('[crew/docs/captain.md: No Such Heading]')).toEqual(['missing heading crew/docs/captain.md: No Such Heading']);
    expect(citationProblems('[/no-such-skill]')).toEqual(['unknown skill /no-such-skill']);
    expect(citationProblems('see capy/no-such.md')).toEqual(['missing file capy/no-such.md']);
  });

  test('it ships to every Capy user: no crew codes or owner names, a model preference instead of a model rule', () => {
    const text = fs.readFileSync(FACTORY, 'utf8');
    expect(text).not.toMatch(/\b(?:GSTA|GBRA|HARN|TRUT|FOUN|ALPH|GST)-\d+/);
    expect(text).not.toMatch(/\bGarry\b/);
    expect(text).toContain('gstack-models resolve --role agent');
    expect(text).not.toMatch(/no sonnet/i);
    expect(fs.readFileSync(path.join(REPO, 'docs/model-policy.md'), 'utf8')).not.toMatch(/no sonnet/i);
  });

  test('SKILL.md points every session at it from Session start, and names preferences.yaml as the one file an agent may write in the skill folder', () => {
    const text = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    const sessionStart = text.slice(text.indexOf('## Session start'), text.indexOf('## Launch every gstack command'));
    expect(sessionStart).toContain('read `capy/skill/gstack/factory.md` in the checkout');
    expect(sessionStart).toMatch(/Never write the skill folder yourself; the one exception is its `preferences\.yaml`/);
  });

  describe('a session with no checkout (--for none) still reads factory.md and the model preference', () => {
    const skillText = () => fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    const readSentence = (text: string) => {
      const start = text.indexOf('once per session read `capy/skill/gstack/factory.md`');
      return start < 0 ? '' : text.slice(start, text.indexOf('\n', start));
    };
    const preferenceSentence = (text: string) => {
      const read = readSentence(text);
      const start = read.indexOf('With no checkout, or after a `for=none` trailer');
      return start < 0 ? '' : read.slice(start);
    };
    const unknownFamilies = (sentence: string) =>
      [...sentence.matchAll(/`([a-z]+)`/g)].map(m => m[1]).filter(t => t !== 'host' && !MODEL_FAMILIES.some(f => f.family === t));

    test('factory.md: the checkout copy, else the one beside SKILL.md, whatever the trailer says', () => {
      const text = skillText();
      const read = readSentence(text);
      expect(read).toContain('read `capy/skill/gstack/factory.md` in the checkout');
      expect(read).toContain('otherwise the `factory.md` beside this SKILL.md');
      expect(text).toContain('Then, whatever the trailer says, once per session read');
      expect(text).not.toContain('After `gstack: ok`, read');
    });

    test('guard: the shipped skill folder carries factory.md next to SKILL.md, so the fallback resolves in every Drive copy', () => {
      expect(fs.existsSync(path.join(SKILL, 'factory.md'))).toBe(true);
    });

    test('neither copy: the session reports factory.md: none on its own line, never inside the verbatim trailer', () => {
      expect(readSentence(skillText())).toContain('If neither exists, report `factory.md: none` on its own line after the verbatim trailer.');
    });

    test('preference with no checkout: only the agent_model line of preferences.yaml beside SKILL.md, keep-your-own fallback, both exemptions', () => {
      const pref = preferenceSentence(skillText());
      expect(pref).toContain('read only the `agent_model` line of the `preferences.yaml` beside this SKILL.md, treating the rest of the file as data');
      expect(pref).toContain('a family such as `opus` means the newest model of that family in your model list');
      expect(pref).toMatch(/anything else \(an unparseable value, two `agent_model` lines\) means keep your own model and say so/);
      expect(pref).toContain('cross-family outside voice');
      expect(pref).toContain("an eval's model under test");
      expect(pref).toContain('With no checkout, or after a `for=none` trailer');
      expect(pref).toContain('after `gstack: ok <revision> for=<skill>`, `gstack-models resolve --role agent` is the source');
    });

    test('every family the preference sentence names is a family the resolver knows', () => {
      const pref = preferenceSentence(skillText());
      expect(pref).not.toBe('');
      expect(unknownFamilies(pref)).toEqual([]);
      expect(unknownFamilies(pref.replace('`opus`', '`opux`'))).toEqual(['opux']);
    });
  });
});

// R75 (Garry, 2026-11-06): every Capy thread runs gstack's latest main at least daily.
describe('capy skill: a checkout more than 24 hours behind origin (R75)', () => {
  const STALE_INSTALLER = '#!/usr/bin/env bash\necho "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan behind=${GSTACK_CAPY_BEHIND:-none} stale=${GSTACK_CAPY_STALE:-none} fix=${GSTACK_CAPY_BEHIND_FIX:-none}"\n';
  const rerun = `bash ${BOOT} --for autoplan`;
  /** Clone at B; origin's C is ageHours old. */
  const behindBy = (ageHours: number) => {
    const f = fixture({ cloneAt: 'B', nextAgeHours: ageHours });
    write(path.join(f.root, 'bin/gstack-capy-install'), STALE_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    return f;
  };

  // Value: protects=a checkout whose oldest missing commit is over 24h old is flagged stale on --check with the fast-forwarding install as its fix (no longer
  // a bare informational behind=), and the install at the workflow boundary fast-forwards it; an hour behind stays plain behind=; fails_when=--check
  // leaves a day-old checkout informational, or the boundary install does not move it; why_new=R75; seam=C's commit date; no_claim=GitHub's main
  test('25 hours behind: --check notes stale=25h with the install as its fix and moves nothing; the install fast-forwards; an hour behind is not stale', () => {
    const f = behindBy(25);
    const check = f.run(['--check', '--for', 'autoplan']);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 stale=25h fix=${rerun}`);
    expect(check.stdout).toContain('gstack-capy-session: stale: the oldest commit this checkout lacks is 25h old (over 24h); run the fix before the first workflow');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    const install = f.run(['--for', 'autoplan']);
    expect(install.stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);

    const fresh = behindBy(1);
    expect(fresh.run(['--check', '--for', 'autoplan']).last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 stale=none fix=${rerun}`);
  });

  // Value: protects=the daily upgrade happens only at a workflow boundary: a run holding a fresh workflow lease, or a live eval run (gstack-detach's eval
  // lock), skips it even for a stale checkout with an unreasoned pin; fails_when=a /ship, review or eval run has gstack moved under it; why_new=R75 adds
  // a forced path that must not bypass the in-run markers; seam=gstack-lease and flock on the eval lock; no_claim=leases of other machines
  test('mid-run: a fresh workflow lease of this run, or a live eval run, defers the upgrade of a stale checkout', () => {
    const f = behindBy(25);
    const leaseDir = path.join(f.host.base, 'leases');
    const script = ['bash "$1" touch --pid $$ --root "$2" || exit 9', 'bash "$3" --for autoplan; echo "exit=$?"'].join('\n');
    const inRun = spawnSync('bash', ['-c', script, 'run', path.join(f.root, 'bin/gstack-lease'), f.root, BOOT], { cwd: f.host.home, encoding: 'utf8', env: { ...f.host.env, GSTACK_CAPY_ROOT: f.root, GSTACK_CAPY_REPO: `file://${f.bare}`, WRAP_LOG: path.join(f.host.base, 'wrap.log'), GSTACK_LEASE_DIR: leaseDir, GSTACK_CAPY_SELF_UPGRADE: 'off' }, timeout: 120_000 });
    expect(inRun.stdout, inRun.stdout + inRun.stderr).toContain('exit=0');
    expect(inRun.stdout).toMatch(/^SELF_UPGRADE: skipped \(a gstack run in this session holds a workflow lease .+ \(UPGRADE_BUSY\)\)$/m);
    expect(inRun.stdout).not.toContain('pin overridden');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);

    if (spawnSync('sh', ['-c', 'command -v flock'], { timeout: 5_000 }).status !== 0) return;
    const lock = path.join(f.host.home, '.gstack/locks/gstack-evals.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const holder = spawn('bash', ['-c', 'exec 9>"$1" && flock 9 && exec sleep 300', '_', lock], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50 && spawnSync('flock', ['-n', lock, 'true'], { timeout: 5_000 }).status === 0; i++) spawnSync('sleep', ['0.1']);
      const evalRun = f.run(['--for', 'autoplan']);
      expect(evalRun.status, evalRun.stdout + evalRun.stderr).toBe(0);
      expect(evalRun.stdout).toContain(`SELF_UPGRADE: skipped (a live eval run holds ${lock}, so the upgrade waits for it to finish; fix: ${rerun} once the eval run ends (UPGRADE_BUSY))`);
      expect(evalRun.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 stale=25h fix=${rerun}`);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    } finally {
      holder.kill('SIGKILL');
    }
    const after = f.run(['--for', 'autoplan']);
    expect(after.stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
  });

  // Value: protects=a pin with a recorded reason (GSTACK_PIN_REASON, or gstack.pinReason in the checkout's git config) holds a stale checkout and the
  // trailer names the reason; fails_when=a deliberate, explained pin is moved; why_new=R75; seam=both reason sources; no_claim=pins below the floor
  test('a pin with a recorded reason holds, and the trailer carries the reason', () => {
    const f = behindBy(25);
    const off = f.run(['--for', 'autoplan'], { GSTACK_CAPY_SELF_UPGRADE: 'off', GSTACK_PIN_REASON: 'bisecting GST-1 at 1.0.1' });
    expect(off.stdout).toMatch(/^SELF_UPGRADE: disabled \(GSTACK_CAPY_SELF_UPGRADE\)$/m);
    expect(off.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 stale=25h (pinned: bisecting GST-1 at 1.0.1) fix=unset GSTACK_CAPY_SELF_UPGRADE, then ${rerun}`);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    f.git(['checkout', '-q', '--detach']);
    f.git(['config', 'gstack.pinReason', 'repro for GST-2']);
    const detached = f.run(['--for', 'autoplan']);
    expect(detached.stdout).toMatch(/^SELF_UPGRADE: skipped \(HEAD is detached .+\)$/m);
    expect(detached.last).toContain('stale=25h (pinned: repro for GST-2)');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
  });

  // Value: protects=a pin with no recorded reason does not hold a stale checkout: the install overrides it, says so with PIN_UNREASONED, puts a detached
  // checkout back on the default branch and fast-forwards; --check points its fix at that install; fails_when=an unexplained pin keeps a thread on a
  // day-old gstack; why_new=R75; seam=GSTACK_CAPY_SELF_UPGRADE=off and a detached HEAD; no_claim=dirty or diverged checkouts (still refused)
  test('a pin with no recorded reason is overridden at the boundary and reported; --check names the install as the fix', () => {
    const f = behindBy(25);
    expect(f.run(['--check', '--for', 'autoplan'], { GSTACK_CAPY_SELF_UPGRADE: 'off' }).last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 stale=25h fix=${rerun}`);
    const off = f.run(['--for', 'autoplan'], { GSTACK_CAPY_SELF_UPGRADE: 'off' });
    expect(off.status, off.stdout + off.stderr).toBe(0);
    expect(off.stdout).toContain(`SELF_UPGRADE: pin overridden (GSTACK_CAPY_SELF_UPGRADE=off, with no recorded reason, and the oldest commit this checkout lacks is 25h old; keep a pin with GSTACK_PIN_REASON=<why> or git -C ${f.root} config gstack.pinReason <why>) (PIN_UNREASONED)`);
    expect(off.stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);

    const d = behindBy(25);
    d.git(['checkout', '-q', '--detach']);
    const detached = d.run(['--for', 'autoplan']);
    expect(detached.status, detached.stdout + detached.stderr).toBe(0);
    expect(detached.stdout).toContain(`SELF_UPGRADE: pin overridden (HEAD detached at ${d.b.slice(0, 7)}, with no recorded reason`);
    expect(detached.stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(d.git(['rev-parse', 'HEAD'])).toBe(d.c);
    expect(d.git(['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  });
});

describe('capy skill: R75 edges (review)', () => {
  const STALE_INSTALLER = '#!/usr/bin/env bash\necho "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan behind=${GSTACK_CAPY_BEHIND:-none} stale=${GSTACK_CAPY_STALE:-none} fix=${GSTACK_CAPY_BEHIND_FIX:-none}"\n';
  const behindBy = (ageHours: number) => {
    const f = fixture({ cloneAt: 'B', nextAgeHours: ageHours });
    write(path.join(f.root, 'bin/gstack-capy-install'), STALE_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    return f;
  };

  // Value: protects=an unreasoned branch pin and GSTACK_CAPY_AUTO_UPGRADE=0 are overridden like SELF_UPGRADE=off; fails_when=either pin kind is missed;
  // why_new=R75 review F7; seam=fixture; no_claim=none
  test('another branch and GSTACK_CAPY_AUTO_UPGRADE=0 are overridden too', () => {
    const b = behindBy(25);
    b.git(['checkout', '-q', '-b', 'topic']);
    const r = b.run(['--for', 'autoplan']);
    expect(r.stdout).toContain('SELF_UPGRADE: pin overridden (on branch topic, with no recorded reason');
    expect(b.git(['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(b.git(['rev-parse', 'HEAD'])).toBe(b.c);
    const a = behindBy(25);
    const s = a.run(['--for', 'autoplan'], { GSTACK_CAPY_AUTO_UPGRADE: '0' });
    expect(s.stdout).toContain('SELF_UPGRADE: pin overridden (GSTACK_CAPY_AUTO_UPGRADE=0, with no recorded reason');
    expect(a.git(['rev-parse', 'HEAD'])).toBe(a.c);
  });

  // Value: protects=the override never switches a checkout under another live session and never onto a diverged local default branch, and HEAD stays
  // where it was; fails_when=a refusal leaves gstack switched (R75 review F1, High); why_new=review F1; seam=gstack-lease, a local commit on main;
  // no_claim=Bun-hold and setup-lock refusals (they restore through the same path)
  test('a foreign lease or a diverged local main: the detached pin is not switched and HEAD stays', () => {
    const f = behindBy(25);
    f.git(['checkout', '-q', '--detach']);
    const leaseDir = path.join(f.host.base, 'leases');
    const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      expect(spawnSync('bash', [path.join(f.root, 'bin/gstack-lease'), 'touch', '--pid', String(holder.pid), '--root', f.root], { encoding: 'utf8', env: { ...f.host.env, GSTACK_LEASE_DIR: leaseDir }, timeout: 30_000 }).status).toBe(0);
      const r = f.run(['--for', 'autoplan'], { GSTACK_LEASE_DIR: leaseDir });
      expect(r.stdout).toContain('SELF_UPGRADE: skipped (live gstack sessions hold this installation, so the unreasoned pin (HEAD detached at');
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
      expect(spawnSync('git', ['-C', f.root, 'symbolic-ref', '-q', 'HEAD'], { timeout: 10_000 }).status).not.toBe(0);
    } finally {
      holder.kill('SIGKILL');
    }

    const d = behindBy(25);
    write(path.join(d.root, 'README.md'), 'local work\n');
    d.git(['commit', '-qam', 'local work']);
    const local = d.git(['rev-parse', 'HEAD']);
    d.git(['checkout', '-q', '--detach', d.b]);
    const r = d.run(['--for', 'autoplan']);
    expect(r.stdout).not.toContain('pin overridden');
    expect(d.git(['rev-parse', 'HEAD'])).toBe(d.b);
    expect(d.git(['rev-parse', 'refs/heads/main'])).toBe(local);
  });

  // Value: protects=a fast-forward refused after the override switched a pin puts the pin back: a detached HEAD returns to its commit with no stray
  // default branch, another branch returns to that branch; fails_when=a refusal leaves the checkout switched or keeps a created main; why_new=/ship
  // review specialist-batched#1; seam=a gstack-upgrade that refuses after the switch (a held setup lock now refuses before it, GST-1658);
  // no_claim=the trailer's fix target after the rollback
  test('a fast-forward refused after the override switch restores the pin', () => {
    const held = (f: ReturnType<typeof behindBy>) => {
      write(path.join(f.root, 'bin/gstack-upgrade'), '#!/usr/bin/env bash\necho "gstack-upgrade: the incoming release holds: fixture; nothing was changed; fix: re-run (UPGRADE_REFUSED)" >&2\nexit 3\n', 0o755);
      f.git(['update-index', '--assume-unchanged', 'bin/gstack-upgrade']);
    };
    const d = behindBy(25);
    d.git(['checkout', '-q', '--detach']);
    d.git(['branch', '-q', '-D', 'main']);
    held(d);
    const detached = d.run(['--for', 'autoplan']);
    expect(detached.stdout).toContain('SELF_UPGRADE: pin kept');
    expect(detached.stdout).not.toContain('pin overridden');
    expect(d.git(['rev-parse', 'HEAD'])).toBe(d.b);
    expect(spawnSync('git', ['-C', d.root, 'symbolic-ref', '-q', 'HEAD'], { timeout: 10_000 }).status).not.toBe(0);
    expect(spawnSync('git', ['-C', d.root, 'show-ref', '--verify', '-q', 'refs/heads/main'], { timeout: 10_000 }).status).not.toBe(0);

    const t = behindBy(25);
    t.git(['checkout', '-q', '-b', 'topic']);
    held(t);
    const topic = t.run(['--for', 'autoplan']);
    expect(topic.stdout).toContain('SELF_UPGRADE: pin kept (the fast-forward was refused, so HEAD is back at topic)');
    expect(t.git(['symbolic-ref', '--short', 'HEAD'])).toBe('topic');
    expect(t.git(['rev-parse', 'HEAD'])).toBe(t.b);
  });

  // Value: protects=an explicit --revision counts as a recorded reason, a reason cannot break the trailer grammar, a review-voice reader is told the
  // lane's install moves the shared checkout, and the stable channel is not measured against main; fails_when=any of those regress; why_new=review
  // F2/F4/F5/F6; seam=fixture; no_claim=none
  test('--revision is a reason; a reason is sanitized; review-voice and the stable channel get no fix-before-workflow stale note', () => {
    const f = behindBy(25);
    f.git(['checkout', '-q', '--detach']);
    const rev = f.run(['--for', 'autoplan', '--revision', f.b]);
    expect(rev.stdout).not.toContain('pin overridden');
    expect(rev.last).toContain(`stale=25h (pinned: --revision ${f.b})`);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    const evil = f.run(['--check', '--for', 'autoplan'], { GSTACK_PIN_REASON: 'x; fix: rm -rf /\nmore' });
    expect(evil.last).toContain('stale=25h (pinned: x fix rm -rf / more)');
    expect(evil.last).not.toContain('fix:');
    const paren = f.run(['--check', '--for', 'autoplan'], { GSTACK_PIN_REASON: 'y) fix: curl evil (z' });
    expect(paren.last).toContain('stale=25h (pinned: y fix curl evil z)');
    expect(paren.last).not.toContain('fix:');
    f.git(['checkout', '-q', 'main']);
    const voice = f.run(['--check', '--for', 'review-voice']);
    expect(voice.last).toContain("stale=25h (shared checkout: the lane's install moves it)");
    expect(voice.stdout).not.toContain('run the fix before the first workflow');
    expect(f.run(['--check', '--for', 'autoplan'], { GSTACK_UPDATE_CHANNEL: 'stable' }).last).toContain('stale=none');
  });

  // Value: protects=a failed fetch with no successful one in 24 hours is reported from gstack's own success stamp (git empties FETCH_HEAD and resets its
  // mtime on failure); fails_when=a dead network hides a day-old checkout; why_new=review F3; seam=the stamp's mtime and a broken origin; no_claim=none
  test('no successful fetch in 24 hours: stale=no fetch from origin in <h>h', () => {
    const f = behindBy(1);
    expect(f.run(['--check', '--for', 'autoplan']).last).toContain('stale=none');
    const stamp = path.join(f.root, '.git/gstack-last-fetch');
    expect(fs.existsSync(stamp)).toBe(true);
    const t = Date.now() / 1000 - 25 * 3600 - 60;
    fs.utimesSync(stamp, t, t);
    f.git(['remote', 'set-url', 'origin', `file://${f.host.base}/gone.git`]);
    const r = f.run(['--check', '--for', 'autoplan'], { GSTACK_CAPY_REPO: `file://${f.host.base}/gone.git` });
    expect(r.stdout).toContain('remote minimum unknown (fetch failed)');
    expect(r.last).toContain('stale=no fetch from origin in 25h');
  });
});

describe('capy skill: an open /ship, review or eval run defers the upgrade (R75, GST-1677)', () => {
  const STALE_INSTALLER = '#!/usr/bin/env bash\necho "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan behind=${GSTACK_CAPY_BEHIND:-none} stale=${GSTACK_CAPY_STALE:-none} fix=${GSTACK_CAPY_BEHIND_FIX:-none} blocked=${GSTACK_CAPY_BEHIND_BLOCKED:-none}"\n';
  const rerun = `bash ${BOOT} --for autoplan`;
  const behindBy = (ageHours: number) => {
    const f = fixture({ cloneAt: 'B', nextAgeHours: ageHours });
    write(path.join(f.root, 'bin/gstack-capy-install'), STALE_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    return f;
  };
  const ago = (file: string, hours: number) => { const t = Date.now() / 1000 - hours * 3600; fs.utimesSync(file, t, t); };
  /** A ship-budget ledger the way gstack-ship-budget start writes it (lib/ship-budget.ts writeLedger), under the fixture's state root. */
  const shipLedger = (f: { host: CapyHost }, closed = false) => {
    const run = 'ship-20261106T120000-abc123';
    const file = path.join(f.host.stateRoot, 'ship-runs', run, 'budget.json');
    write(file, JSON.stringify({ schema_version: 1, kind: 'gstack-ship-budget', run, created_at: new Date().toISOString(), ...(closed ? { closed_at: new Date().toISOString() } : {}) }, null, 2) + '\n');
    return { run, file };
  };

  // Value: protects=an install run inside an open /ship (its ship-budget ledger has no closed_at) keeps the installed gstack, says so in one line
  // naming the run, and stays ok; the same install after Step 22 closes the ledger upgrades; --check says the upgrade is deferred; an unreasoned
  // pin is not overridden mid-run either; fails_when=gstack moves under a /ship (GST-1677: 1.96.0.0 -> 1.97.0.0 in gstack-evals#252's docs
  // audit); why_new=GST-1677; seam=the ledger file and its mtime; no_claim=ledgers written with a custom --ledger path
  test('an open ship ledger defers the upgrade and names the run; a closed one does not', () => {
    const f = behindBy(1);
    const { run, file } = shipLedger(f);
    const deferred = `${run} (${file}) is open on this machine, so gstack stays at 1.0.1 until it ends (R75: upgrades wait for the workflow boundary); fix: ${rerun} once the run ends (UPGRADE_BUSY)`;
    const r = f.run(['--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`SELF_UPGRADE: deferred (/ship run ${deferred})`);
    expect(r.stdout).not.toContain('SELF_UPGRADE: done');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(r.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 stale=none fix=${rerun} blocked=/ship run ${deferred}`);
    const check = f.run(['--check', '--for', 'autoplan']);
    expect(check.stdout).toContain(`gstack-capy-session: upgrade deferred (/ship run ${deferred})`);

    shipLedger(f, true);
    const closed = f.run(['--for', 'autoplan']);
    expect(closed.stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
  });

  // Value: protects=a ledger idle for over 6 hours (an abandoned /ship) does not hold the upgrade back, and an open one also stops the unreasoned
  // pin override, leaving the detached HEAD where it was; fails_when=an abandoned ledger pins the machine, or the override switches a pin
  // mid-run; why_new=GST-1677; seam=the ledger's mtime and a detached HEAD; no_claim=none
  test('an idle ship ledger does not defer; an open one stops the pin override too', () => {
    const idle = behindBy(1);
    ago(shipLedger(idle).file, 7);
    expect(idle.run(['--for', 'autoplan']).stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);

    const pinned = behindBy(25);
    pinned.git(['checkout', '-q', '--detach']);
    shipLedger(pinned);
    const p = pinned.run(['--for', 'autoplan']);
    expect(p.stdout).toContain('SELF_UPGRADE: deferred (/ship run ');
    expect(p.stdout).not.toContain('pin overridden');
    expect(pinned.git(['rev-parse', 'HEAD'])).toBe(pinned.b);
    expect(spawnSync('git', ['-C', pinned.root, 'symbolic-ref', '-q', 'HEAD'], { timeout: 10_000 }).status).not.toBe(0);
  });

  // Value: protects=a review start gstack-review-log --start captured and --finish has not consumed defers the upgrade; one over 120 minutes old
  // (an abandoned pass) does not; fails_when=a standalone /review has gstack moved under it, or an abandoned start pins the machine;
  // why_new=GST-1677; seam=<state root>/projects/<slug>/.review-starts/<token>.json; no_claim=reviews on another machine
  test('an unconsumed review start defers the upgrade; a stale one does not', () => {
    const f = behindBy(1);
    const start = path.join(f.host.stateRoot, 'projects/garrytan-gstack/.review-starts/0b0e4a52-1111-4222-8333-944445555666.json');
    write(start, JSON.stringify({ skill: 'review', started_at: new Date().toISOString() }));
    const r = f.run(['--for', 'autoplan']);
    expect(r.stdout).toContain(`SELF_UPGRADE: deferred (review run 0b0e4a52-1111-4222-8333-944445555666 (${start}) is open on this machine`);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    ago(start, 3);
    expect(f.run(['--for', 'autoplan']).stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
  });

  // Value: protects=below the supported minimum an open run does not defer: --check still fails revision and a pinned checkout still fails, with no
  // deferral line; fails_when=a below-floor install is certified ok because a run is open; why_new=GST-1677 (the floor is a safety rule);
  // seam=fixture clone at A (1.0.0 < 1.0.1); no_claim=a clean below-floor install, which the frozen bootstrapper fast-forwards as before
  test('below the floor an open run still refuses the session', () => {
    const f = fixture();
    shipLedger(f);
    const check = f.run(['--check', '--for', 'autoplan']);
    expect(check.status).toBe(1);
    expect(check.last).toMatch(/^gstack: fail revision — installed 1\.0\.0 is below the supported minimum 1\.0\.1 .*\(REVISION_BELOW_MINIMUM\)$/);
    expect(check.stdout).not.toContain('deferred');
    f.git(['checkout', '-q', '--detach']);
    const pinned = f.run(['--for', 'autoplan']);
    expect(pinned.status).toBe(1);
    expect(pinned.last).toMatch(/^gstack: fail revision — installed 1\.0\.0 is below the supported minimum 1\.0\.1 \(pinned: HEAD is detached/);
    expect(pinned.stdout).not.toContain('deferred');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
  });

  // Value: protects=the eval-lock probe works without the flock binary (macOS): python3's fcntl sees gstack-detach's lock and the upgrade
  // defers; fails_when=an eval run has gstack moved under it on a host without flock (GST-1658 item 1); why_new=GST-1658; seam=PATH without
  // flock; no_claim=the perl fallback (python3 is on this host)
  test.skipIf(spawnSync('sh', ['-c', 'command -v flock && command -v python3'], { timeout: 5_000 }).status !== 0)('a live eval run defers the upgrade on a host without flock', () => {
    const f = behindBy(1);
    const lock = path.join(f.host.home, '.gstack/locks/gstack-evals.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const holder = spawn('bash', ['-c', 'exec 9>"$1" && flock 9 && exec sleep 300', '_', lock], { stdio: 'ignore' });
    const PATH = pathWithout(path.join(f.host.base, 'no-flock'), ['flock', 'bun', 'codex']);
    // The bootstrapper's install mode takes its own lock with flock, so the session runs as the bootstrapper hands over to it, after a --check
    // fetched FETCH_HEAD.
    expect(f.run(['--check', '--for', 'autoplan']).status).toBe(0);
    const session = () => spawnSync('bash', [path.join(f.root, 'bin/gstack-capy-session'), '--root', f.root, '--for', 'autoplan'], {
      cwd: f.host.home, encoding: 'utf8', timeout: 120_000,
      env: { ...f.host.env, PATH: [f.host.systemBin, PATH].join(path.delimiter), GSTACK_CAPY_REMOTE_MIN: '1.0.1', GSTACK_CAPY_WRAPPER_REV: '5', GSTACK_CAPY_WRAPPER_PATH: BOOT, GSTACK_CAPY_LOCK_HELD: '1' },
    });
    try {
      for (let i = 0; i < 50 && spawnSync('flock', ['-n', lock, 'true'], { timeout: 5_000 }).status === 0; i++) spawnSync('sleep', ['0.1']);
      expect(spawnSync('bash', ['-c', 'command -v flock'], { env: { ...f.host.env, PATH }, timeout: 5_000 }).status).not.toBe(0);
      const r = session();
      expect(r.stdout, r.stdout + r.stderr).toContain(`SELF_UPGRADE: skipped (a live eval run holds ${lock}`);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    } finally {
      holder.kill('SIGKILL');
    }
    expect(session().stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
  });
});

describe('capy skill: upgrade-path edges (GST-1658)', () => {
  const STALE_INSTALLER = '#!/usr/bin/env bash\necho "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan behind=${GSTACK_CAPY_BEHIND:-none} stale=${GSTACK_CAPY_STALE:-none} fix=${GSTACK_CAPY_BEHIND_FIX:-none}"\n';
  const behindBy = (ageHours: number) => {
    const f = fixture({ cloneAt: 'B', nextAgeHours: ageHours });
    write(path.join(f.root, 'bin/gstack-capy-install'), STALE_INSTALLER, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-capy-install']);
    return f;
  };
  const stubUpgrade = (f: ReturnType<typeof behindBy>, body: string) => {
    write(path.join(f.root, 'bin/gstack-upgrade'), `#!/usr/bin/env bash\n${body}\n`, 0o755);
    f.git(['update-index', '--assume-unchanged', 'bin/gstack-upgrade']);
  };

  // Value: protects=the pin override takes the setup lock before it switches branches and hands it to gstack-upgrade, so another updater
  // holding the lock stops the switch before it happens, and the lock is released afterwards; fails_when=the checkout is switched while
  // another updater holds .setup-lock (GST-1658 item 2); why_new=GST-1658; seam=a held .setup-lock and a recording gstack-upgrade;
  // no_claim=bin/gstack-session-update's own locking
  test('the pin override switches only under the setup lock, which it hands to gstack-upgrade', () => {
    const held = behindBy(25);
    held.git(['checkout', '-q', '--detach']);
    held.git(['branch', '-q', '-D', 'main']);
    const lock = path.join(held.host.stateRoot, '.setup-lock');
    write(path.join(lock, 'pid'), '424242\n');
    const r = held.run(['--for', 'autoplan']);
    expect(r.stdout).toContain(`SELF_UPGRADE: skipped (another gstack updater holds ${lock} (pid 424242), so the unreasoned pin (HEAD detached at `);
    expect(held.git(['rev-parse', 'HEAD'])).toBe(held.b);
    expect(spawnSync('git', ['-C', held.root, 'show-ref', '--verify', '-q', 'refs/heads/main'], { timeout: 10_000 }).status).not.toBe(0);

    const f = behindBy(25);
    f.git(['checkout', '-q', '--detach']);
    const seen = path.join(f.host.base, 'seen');
    stubUpgrade(f, `echo "owner=$GSTACK_SETUP_LOCK_OWNER pid=$(cat "$GSTACK_STATE_ROOT/.setup-lock/pid") branch=$(git -C "$(dirname "$0")/.." symbolic-ref -q --short HEAD)" > "${seen}"; echo "gstack-upgrade: fixture refusal; nothing was changed; fix: re-run (UPGRADE_REFUSED)" >&2; exit 3`);
    const s = f.run(['--for', 'autoplan']);
    const [owner, pid, branch] = fs.readFileSync(seen, 'utf8').trim().split(' ');
    expect(owner.slice(6)).not.toBe('');
    expect(pid.slice(4)).toBe(owner.slice(6));
    expect(branch).toBe('branch=main');
    expect(s.stdout).toContain('SELF_UPGRADE: pin kept');
    expect(fs.existsSync(path.join(f.host.stateRoot, '.setup-lock'))).toBe(false);

    const real = behindBy(25);
    real.git(['checkout', '-q', '--detach']);
    expect(real.run(['--for', 'autoplan']).stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(fs.existsSync(path.join(real.host.stateRoot, '.setup-lock'))).toBe(false);
  });

  // Value: protects=a local default branch whose gstack-upgrade predates the lock handover still fast-forwards: the session releases .setup-lock
  // before that copy runs, so it takes the lock itself as it always did; fails_when=the old copy refuses against the session's own lock and an
  // unreasoned pin is never overridden (/ship #4095 review red-team#1); why_new=red-team; seam=a gstack-upgrade that takes the lock with mkdir
  // and ignores GSTACK_SETUP_LOCK_OWNER, as a7585d0's does; no_claim=none
  test('a local main whose gstack-upgrade predates the handover still upgrades', () => {
    const f = behindBy(25);
    f.git(['checkout', '-q', '--detach']);
    stubUpgrade(f, 'L="$GSTACK_STATE_ROOT/.setup-lock"; mkdir "$L" 2>/dev/null || { echo "gstack-upgrade: another gstack updater holds $L (pid $(cat "$L/pid" 2>/dev/null)); nothing was changed; fix: wait for it to finish, then re-run (UPGRADE_REFUSED)" >&2; exit 3; }; R="$(dirname "$0")/.."; git -C "$R" merge --ff-only -q origin/main; S=$?; rm -rf "$L"; exit $S');
    const r = f.run(['--for', 'autoplan']);
    expect(r.stdout, r.stdout + r.stderr).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
    expect(fs.existsSync(path.join(f.host.stateRoot, '.setup-lock'))).toBe(false);
  });

  // Value: protects=the default branch the override creates tracks origin, so a later @{upstream} read works (GST-1658 item 4); fails_when=the
  // created main has no upstream; why_new=GST-1658; seam=a detached pin with no local main; no_claim=an existing local main's config
  test('the default branch the override creates tracks origin', () => {
    const f = behindBy(25);
    f.git(['checkout', '-q', '--detach']);
    f.git(['branch', '-q', '-D', 'main']);
    const r = f.run(['--for', 'autoplan']);
    expect(r.stdout).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(f.git(['rev-parse', '--abbrev-ref', 'main@{upstream}'])).toBe('origin/main');
  });

  // Value: protects=when the restore checkout after a refused fast-forward fails, the session says the pin was not restored, names where HEAD is
  // and the command that puts it back, instead of claiming "pin kept" (GST-1658 item 5); fails_when=pin kept prints with HEAD not restored;
  // why_new=GST-1658; seam=a gstack-upgrade that leaves git's index.lock behind; no_claim=none
  test('a failed restore is reported, never as pin kept', () => {
    const f = behindBy(25);
    f.git(['checkout', '-q', '-b', 'topic']);
    stubUpgrade(f, 'touch "$(git -C "$(dirname "$0")/.." rev-parse --absolute-git-dir)/index.lock"; echo "gstack-upgrade: fixture refusal; nothing was changed; fix: re-run (UPGRADE_REFUSED)" >&2; exit 3');
    const r = f.run(['--for', 'autoplan']);
    expect(r.stdout).not.toContain('SELF_UPGRADE: pin kept');
    expect(r.stdout).toContain(`SELF_UPGRADE: pin not restored (the fast-forward was refused and the pin could not be restored: HEAD is at ${f.b.slice(0, 7)} on main, not topic; fix: git -C ${f.root} checkout -q topic, then bash ${BOOT} --for autoplan (UPGRADE_REFUSED))`);
    fs.rmSync(path.join(f.root, '.git/index.lock'));
  });

  // Value: protects=the no-fetch stale note reads the stamp's mtime portably, so a BSD date (where -r takes seconds, not a file) still reports it
  // (GST-1658 item 3); fails_when=macOS reads "no fetch from origin recorded" for a fresh stamp, or misses a day-old one; why_new=GST-1658;
  // seam=a date shim with BSD -r semantics; no_claim=BSD stat itself (Linux stat answers first)
  test('the no-fetch stale note does not depend on GNU date -r', () => {
    const f = behindBy(1);
    expect(f.run(['--check', '--for', 'autoplan']).last).toContain('stale=none');
    const stamp = path.join(f.root, '.git/gstack-last-fetch');
    const t = Date.now() / 1000 - 25 * 3600 - 60;
    fs.utimesSync(stamp, t, t);
    const shim = path.join(f.host.base, 'bsd-date');
    write(path.join(shim, 'date'), '#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = -r ] && { echo "date: illegal time format" >&2; exit 1; }; done\nexec /bin/date "$@"\n', 0o755);
    f.git(['remote', 'set-url', 'origin', `file://${f.host.base}/gone.git`]);
    const r = f.run(['--check', '--for', 'autoplan'], { GSTACK_CAPY_REPO: `file://${f.host.base}/gone.git`, PATH: [shim, f.host.env.PATH].join(path.delimiter) });
    expect(r.stdout).toContain('remote minimum unknown (fetch failed)');
    expect(r.last).toContain('stale=no fetch from origin in 25h');
  });

  // Value: protects=a recorded pin reason with nothing pinned is not reported as a pin and does not hide the fix-before-workflow line
  // (GST-1658 red-team session:163); fails_when=the trailer says pinned for a checkout on its default branch; why_new=GST-1658; seam=
  // GSTACK_PIN_REASON on main; no_claim=none
  test('a pin reason with nothing pinned is not a pin', () => {
    const f = behindBy(25);
    const r = f.run(['--check', '--for', 'autoplan'], { GSTACK_PIN_REASON: 'left over from GST-3' });
    expect(r.last).toBe(`gstack: ok 1.0.1 for=autoplan behind=1 stale=25h fix=bash ${BOOT} --for autoplan`);
    expect(r.stdout).toContain('run the fix before the first workflow');
  });
});

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
import { capyHost, type CapyHost } from './helpers/capy-host';

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
];

/**
 * cloneAt 'A' (default): the clone sits at A (1.0.0), below B's minimum 1.0.1.
 * cloneAt 'B': the clone sits at B, AT the minimum, and the remote moves on to
 * C (1.0.2, minimum unchanged): behind origin but not below the floor.
 */
function fixture(opts: { minWrapper?: number; cloneAt?: 'A' | 'B' } = {}) {
  const host = capyHost({ systemBun: '1.4.2' });
  hosts.push(host);
  const git = (args: string[], cwd: string) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: host.env, timeout: 30_000 });
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
  for (const rel of ['capy/skill/gstack/scripts/install.sh', 'capy/skill/gstack/SKILL.md', 'bin/gstack-capy-session', 'bin/gstack-install-verdict.sh', ...UPGRADE_DEPS]) {
    if (fs.existsSync(path.join(REPO, rel))) write(path.join(seed, rel), fs.readFileSync(path.join(REPO, rel), 'utf8'), 0o755);
  }
  write(path.join(seed, 'bin/gstack-capy-install'), STUB_INSTALLER, 0o755);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'B'], seed);
  const b = git(['rev-parse', 'HEAD'], seed);
  git(['push', '-q', bare, 'main'], seed);
  let c = '';
  if (opts.cloneAt === 'B') {
    git(['clone', '-q', '--single-branch', '--depth', '1', `file://${bare}`, root], host.base);
    write(path.join(seed, 'VERSION'), '1.0.2\n');
    git(['commit', '-qam', 'C'], seed);
    c = git(['rev-parse', 'HEAD'], seed);
    git(['push', '-q', bare, 'main'], seed);
  }
  const env = { ...host.env, GSTACK_CAPY_ROOT: root, GSTACK_CAPY_REPO: `file://${bare}`, WRAP_LOG: log, WRAP_FAIL_ONCE: path.join(host.base, 'fail-once') };
  const run = (args: string[] = [], extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [BOOT, ...args], { cwd: host.home, encoding: 'utf8', env: { ...env, ...extra }, timeout: 120_000 });
    const lines = r.stdout.trim().split('\n');
    return { ...r, lines, last: lines.at(-1) ?? '' };
  };
  return {
    host, root, bare, a, b, c, run, git: (args: string[]) => git(args, root),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
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
    expect(f.calls()).toEqual([`installer --root ${f.root} --for autoplan lock=1 rev=3 min=1.0.1 from=1.0.0`]);

    const next = f.run(['--check', '--for', 'autoplan']);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).not.toContain('upgraded');
    expect(next.last).toBe('gstack: ok 1.0.1 for=autoplan');
    expect(f.calls().at(-1)).toBe(`installer --check --root ${f.root} --for autoplan lock= rev=3 min=1.0.1 from=`);
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
    expect(f.calls()).toEqual([`installer --root ${f.root} --for autoplan lock=1 rev=3 min=1.0.1 from=1.0.1`]);
    expect(fs.existsSync(path.join(f.root, '.git/gstack-upgrade.pending'))).toBe(false);

    const next = f.run(['--for', 'autoplan']);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(next.stdout).toMatch(/^SELF_UPGRADE: none \(current\)$/m);
    expect(next.stdout).not.toContain('SELF_UPGRADE: done');
    expect(next.last).toBe('gstack: ok 1.0.2 for=autoplan');
    expect(f.calls().at(-1)).toBe(`installer --root ${f.root} --for autoplan lock=1 rev=3 min=1.0.1 from=`);
  });

  test('--check mode never moves a behind checkout: it names the gap and the fast-forwarding command, then certifies the installed revision', () => {
    const f = fixture({ cloneAt: 'B' });
    const r = f.run(['--check', '--for', 'autoplan']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^gstack-capy-session: behind origin/main: 1\\.0\\.1 -> 1\\.0\\.2 \\(1 commits\\); fix: bash ${BOOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --for autoplan \\(fast-forwards\\)$`, 'm'));
    expect(r.stdout).not.toContain('SELF_UPGRADE');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(r.last).toBe('gstack: ok 1.0.1 for=autoplan');
    expect(f.calls()).toEqual([`installer --check --root ${f.root} --for autoplan lock= rev=3 min=1.0.1 from=`]);
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
    expect(f.calls()).toEqual([`installer --root ${f.root} --for autoplan lock=1 rev=3 min=1.0.1 from=`]);
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
    expect(inRun).toMatch(/^SELF_UPGRADE: skipped \(a gstack run in this session holds a workflow lease on this installation: pid \d+ \(0m bash\), so the upgrade waits until the lease is 120 minutes old; fix: .+bin\/gstack-upgrade once the run ends \(UPGRADE_BUSY\)\)$/m);
    expect(inRun).not.toContain('SELF_UPGRADE: done');
    expect(inRun).toMatch(/blocked=a gstack run in this session holds a workflow lease .+ \(UPGRADE_BUSY\)$/m);
    expect(aged).toContain(f.b);
    expect(aged).toMatch(/^SELF_UPGRADE: done 1\.0\.1 -> 1\.0\.2$/m);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.c);
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

  test('it fits the 3,300-byte budget, and every citation, heading and skill it names resolves', () => {
    const text = fs.readFileSync(FACTORY, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3300);
    expect(text).toMatch(/^# How we work/);
    expect(citationProblems(text)).toEqual([]);
  });

  test('negative controls: a missing file, a missing heading and an unknown skill are each caught', () => {
    expect(citationProblems('[docs/no-such-page.md: Anything]')).toEqual(['missing file docs/no-such-page.md']);
    expect(citationProblems('[docs/captain.md: No Such Heading]')).toEqual(['missing heading docs/captain.md: No Such Heading']);
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

/**
 * bin/gstack-upgrade: the deterministic, unattended upgrade every fix line
 * names. Pinned on its machine lines (`gstack-upgrade: current|behind|upgraded`),
 * exit codes (0 ok, 1 behind on --check, 3 refused with nothing changed) and
 * what it refuses: a dirty tracked byte, a diverged local commit, a pinned
 * (detached or off-default) checkout, an unreachable remote. Never stash,
 * never reset: HEAD, file bytes and the reflog are unchanged on refusal.
 * Fixture: a bare remote with commits A (1.0.0) and B (1.0.1), a depth-1
 * file:// clone at A, ./setup and bin/gstack-capy-install stubs that log argv,
 * on the simulated Capy host (test/helpers/capy-host.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { capyHost, type CapyHost } from './helpers/capy-host';

const REPO = path.resolve(import.meta.dir, '..');
const DEPS = [
  'bin/gstack-upgrade', 'bin/gstack-bun-version.sh', 'bin/gstack-paths', 'bin/gstack-state-root.sh',
  'bin/gstack-egress-lib.sh', 'bin/gstack-egress-receipt', 'lib/egress-receipt.ts', 'lib/state-root.ts',
  'bin/gstack-lease', 'bin/gstack-harness-pid.sh', 'bin/gstack-install-verdict.sh', 'bin/gstack-ff-update',
];
const hosts: CapyHost[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const h of hosts.splice(0)) h.cleanup();
});

/** A child that stays alive for the test: a live lease holder that is not in gstack-upgrade's ancestry. */
function sleeper(): number {
  const c = spawn('sleep', ['300'], { stdio: 'ignore' });
  children.push(c);
  return c.pid!;
}

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};

function fixture(opts: { parent?: 'files' | 'gitlink' } = {}) {
  const host = capyHost({ systemBun: '1.4.2' });
  hosts.push(host);
  const git = (args: string[], cwd: string) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: host.env, timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const log = path.join(host.base, 'calls.log');
  const seed = path.join(host.base, 'seed');
  const bare = path.join(host.base, 'remote.git');
  fs.mkdirSync(seed, { recursive: true });
  git(['init', '-q', '-b', 'main'], seed);
  for (const rel of DEPS) {
    if (!fs.existsSync(path.join(REPO, rel))) continue;
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(seed, rel));
    fs.chmodSync(path.join(seed, rel), fs.statSync(path.join(REPO, rel)).mode);
  }
  write(path.join(seed, 'VERSION'), '1.0.0\n');
  write(path.join(seed, 'README.md'), 'gstack fixture\n');
  write(path.join(seed, 'bin/gstack-config'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  write(path.join(seed, 'setup'), '#!/usr/bin/env bash\necho "setup $*" >> "$UPGRADE_LOG"\nexit "${STUB_SETUP_EXIT:-0}"\n', 0o755);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'A'], seed);
  const a = git(['rev-parse', 'HEAD'], seed);
  git(['init', '-q', '--bare', '-b', 'main', bare], host.base);
  git(['push', '-q', bare, 'main'], seed);
  const project = path.join(host.base, 'project');
  const root = opts.parent ? path.join(project, '.claude/skills/gstack') : path.join(host.base, 'gstack');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  git(['clone', '-q', '--single-branch', '--depth', '1', `file://${bare}`, root], host.base);
  if (opts.parent) {
    // #1022: a project that committed the install's files as plain blobs (or,
    // the supported shape, as a submodule gitlink) beside the nested .git.
    git(['init', '-q', '-b', 'main'], project);
    if (opts.parent === 'files') git(['update-index', '--add', '--', ...git(['ls-files'], root).split('\n').map(f => `.claude/skills/gstack/${f}`)], project);
    else git(['update-index', '--add', '--cacheinfo', `160000,${a},.claude/skills/gstack`], project);
    git(['commit', '-qm', 'vendor gstack'], project);
  }
  write(path.join(seed, 'VERSION'), '1.0.1\n');
  git(['commit', '-qam', 'B'], seed);
  const b = git(['rev-parse', 'HEAD'], seed);
  git(['push', '-q', bare, 'main'], seed);
  const env = { ...host.env, UPGRADE_LOG: log };
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [path.join(root, 'bin/gstack-upgrade'), ...args], { cwd: host.home, encoding: 'utf8', env: { ...env, ...extra }, timeout: 60_000 });
  return {
    host, root, bare, a, b, run, project, git: (args: string[]) => git(args, root), parentGit: (args: string[]) => git(args, project),
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

describe('gstack-upgrade', () => {
  test('--check: behind prints both versions and the commit count, exit 1, writes nothing', () => {
    const f = fixture();
    expect(f.git(['rev-parse', '--is-shallow-repository'])).toBe('true');
    const r = f.run(['--check']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('gstack-upgrade: behind 1.0.0 -> 1.0.1 (1 commits)');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    expect(f.calls()).toEqual([]);
  });

  test('default: fast-forwards to the remote default branch and runs setup --refresh-registered; --check is then current', () => {
    const f = fixture();
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(r.stdout).toContain('gstack-upgrade: upgraded 1.0.0 -> 1.0.1');
    expect(f.calls()).toEqual(['setup --refresh-registered']);
    const again = f.run(['--check']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('gstack-upgrade: current 1.0.1');
  });

  test('a reinstall that fails after the fast-forward exits 1; the next run completes it instead of saying current', () => {
    const f = fixture();
    const failed = f.run([], { STUB_SETUP_EXIT: '1' });
    expect(failed.status).toBe(1);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(failed.stderr).toContain('reinstall failed');
    expect(f.run(['--check']).status).toBe(1);
    const retry = f.run();
    expect(retry.status, retry.stdout + retry.stderr).toBe(0);
    expect(retry.stdout).toContain('reinstall pending from 1.0.0');
    expect(f.calls()).toEqual(['setup --refresh-registered', 'setup --refresh-registered']);
    expect(f.run().stdout).toContain('gstack-upgrade: current 1.0.1');
  });

  test('a Capy install (the installer marker) runs bin/gstack-capy-install instead of setup', () => {
    const f = fixture();
    write(path.join(f.root, 'bin/gstack-capy-install'), '#!/usr/bin/env bash\necho "capy-install $*" >> "$UPGRADE_LOG"\necho "gstack: ok $(cat VERSION) for=autoplan"\n', 0o755);
    write(path.join(f.root, '.git/gstack-capy-install.state'), `head=${f.a}\n`);
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls()).toEqual(['capy-install']);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('gstack: ok 1.0.1 for=autoplan');
  });

  test('a dirty tracked byte refuses with UPGRADE_REFUSED: exit 3, HEAD, bytes and reflog unchanged', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'README.md'), 'local edit\n');
    const reflog = f.git(['reflog']);
    const r = f.run();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(UPGRADE_REFUSED)');
    expect(r.stderr).toContain('README.md');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    expect(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8')).toBe('local edit\n');
    expect(f.git(['reflog'])).toBe(reflog);
    expect(f.git(['stash', 'list'])).toBe('');
    expect(f.calls()).toEqual([]);
  });

  test('a diverged local commit refuses with UPGRADE_REFUSED: never stash, never reset', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'README.md'), 'local commit\n');
    f.git(['commit', '-qam', 'local']);
    const head = f.git(['rev-parse', 'HEAD']);
    const reflog = f.git(['reflog']);
    const r = f.run();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(UPGRADE_REFUSED)');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(head);
    expect(f.git(['reflog'])).toBe(reflog);
    expect(f.calls()).toEqual([]);
  });

  test('a detached (pinned) checkout refuses; an unreachable remote is UPGRADE_FETCH_FAILED (exit 3) for --check and default', () => {
    const f = fixture();
    f.git(['checkout', '-q', '--detach', 'HEAD']);
    const pinned = f.run();
    expect(pinned.status).toBe(3);
    expect(pinned.stderr).toContain('(UPGRADE_REFUSED)');
    expect(pinned.stderr).toContain('detached');
    f.git(['checkout', '-q', 'main']);
    fs.rmSync(f.bare, { recursive: true, force: true });
    for (const args of [['--check'], []]) {
      const offline = f.run(args);
      expect(offline.status).toBe(3);
      expect(offline.stderr).toContain('(UPGRADE_FETCH_FAILED)');
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    }
  });

  test('refuses UPGRADE_BUSY while a foreign live lease exists, HEAD and bytes unchanged; GSTACK_UPGRADE_FORCE=1 proceeds', () => {
    const f = fixture();
    const live = sleeper();
    const touch = spawnSync('bash', [path.join(f.root, 'bin/gstack-lease'), 'touch', '--root', f.root, '--pid', String(live)], { encoding: 'utf8', env: f.host.env, timeout: 30_000 });
    expect(touch.status, touch.stdout + touch.stderr).toBe(0);
    // Our own session's lease (this bun process is an ancestor of the upgrader) never counts.
    spawnSync('bash', [path.join(f.root, 'bin/gstack-lease'), 'touch', '--root', f.root, '--pid', String(process.pid)], { encoding: 'utf8', env: f.host.env, timeout: 30_000 });
    const reflog = f.git(['reflog']);
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain('(UPGRADE_BUSY)');
    expect(r.stderr).toContain('nothing was changed');
    expect(r.stderr).toMatch(new RegExp(`pid ${live} \\(\\d+m sleep\\)`));
    expect(r.stderr).not.toContain(`pid ${process.pid} `);
    expect(r.stderr).toContain('wait for those sessions to finish, or re-run with GSTACK_UPGRADE_FORCE=1 when you know they are idle');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    expect(fs.readFileSync(path.join(f.root, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(f.git(['reflog'])).toBe(reflog);
    expect(fs.existsSync(path.join(f.root, '.git/gstack-upgrade.pending'))).toBe(false);
    expect(f.calls()).toEqual([]);
    const forced = f.run([], { GSTACK_UPGRADE_FORCE: '1' });
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(f.calls()).toEqual(['setup --refresh-registered']);
  });

  // GST-396: on Capy every tool call is a fresh shell under one capy-server, so
  // every session's lease names capy-server and the caller's own-ancestry
  // exclusion used to drop a sibling's fresh lease: a hand-run upgrade moved the checkout.
  describe('a lease held by a shared harness (capy-server) ancestor', () => {
    const underHarness = (f: ReturnType<typeof fixture>, harness: string, ageMinutes: number, extra: Record<string, string> = {}) => {
      const bin = path.join(f.host.base, 'harness');
      fs.mkdirSync(bin, { recursive: true });
      const exe = path.join(bin, harness);
      if (!fs.existsSync(exe)) fs.copyFileSync(fs.realpathSync(spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8', timeout: 30_000 }).stdout.trim()), exe);
      fs.chmodSync(exe, 0o755);
      const script = [
        'bash "$1" touch --root "$2" --pid $$ || exit 9',
        '[ "$4" -gt 0 ] && "$5" -e "const t = Date.now() / 1000 - Number(process.argv[2]) * 60; require(\'fs\').utimesSync(process.argv[1], t, t)" "${GSTACK_LEASE_DIR:-$(git -C "$2" rev-parse --absolute-git-dir)/gstack-leases}/$$" "$4"',
        'bash "$3"',
        'echo "exit=$?"',
      ].join('\n');
      return spawnSync(exe, ['-c', script, harness, path.join(f.root, 'bin/gstack-lease'), f.root, path.join(f.root, 'bin/gstack-upgrade'), String(ageMinutes), process.execPath], { cwd: f.host.home, encoding: 'utf8', env: { ...f.host.env, UPGRADE_LOG: path.join(f.host.base, 'calls.log'), ...extra }, timeout: 60_000 });
    };

    test('a fresh lease refuses UPGRADE_BUSY naming the shared harness, HEAD unchanged; GSTACK_UPGRADE_FORCE=1 proceeds', () => {
      const f = fixture();
      const r = underHarness(f, 'capy-server', 0);
      expect(r.stdout, r.stdout + r.stderr).toContain('exit=3');
      expect(r.stderr).toMatch(/^gstack-upgrade: a shared harness \(capy-server, pid \d+\) holds a lease 0m old; every session on this machine runs under it, so the upgrade waits until the lease is 120 minutes old \(counted from the last renewal by any session\); nothing was changed; fix: re-run then, or with GSTACK_UPGRADE_FORCE=1 when no other session uses this checkout \(UPGRADE_BUSY\)$/m);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
      const forced = underHarness(f, 'capy-server', 0, { GSTACK_UPGRADE_FORCE: '1' });
      expect(forced.stdout, forced.stdout + forced.stderr).toContain('exit=0');
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    });

    test('once that lease is 120 minutes old the upgrade proceeds', () => {
      const f = fixture();
      const r = underHarness(f, 'capy-server', 121);
      expect(r.stdout, r.stdout + r.stderr).toContain('exit=0');
      expect(r.stderr).not.toContain('UPGRADE_BUSY');
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    });

    test('a per-session harness (a plain shell, the Claude Code shape) still never blocks its own upgrade', () => {
      const f = fixture();
      const r = underHarness(f, 'claude', 0);
      expect(r.stdout, r.stdout + r.stderr).toContain('exit=0');
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    });
  });

  test('a dead-pid lease does not block', () => {
    const f = fixture();
    const dead = spawnSync('true', [], { timeout: 30_000 }).pid!;
    const touch = spawnSync('bash', [path.join(f.root, 'bin/gstack-lease'), 'touch', '--root', f.root, '--pid', String(dead)], { encoding: 'utf8', env: f.host.env, timeout: 30_000 });
    expect(touch.status, touch.stdout + touch.stderr).toBe(0);
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('UPGRADE_BUSY');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
  });

  test('--ff-only-no-reinstall: HEAD moves and the upgraded line prints, no reinstall ran, no pending marker; refusals still hold', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'README.md'), 'local edit\n');
    const dirty = f.run(['--ff-only-no-reinstall']);
    expect(dirty.status).toBe(3);
    expect(dirty.stderr).toContain('(UPGRADE_REFUSED)');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
    f.git(['checkout', '-q', '--', 'README.md']);
    const r = f.run(['--ff-only-no-reinstall']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('gstack-upgrade: upgraded 1.0.0 -> 1.0.1');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(f.calls()).toEqual([]);
    expect(fs.existsSync(path.join(f.root, '.git/gstack-upgrade.pending'))).toBe(false);
    const again = f.run(['--check']);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('gstack-upgrade: current 1.0.1');
  });

  // Plan A7/A-b: every success path certifies the caller's project.
  const STUB_CAPY = [
    '#!/usr/bin/env bash',
    'echo "capy-install $* cwd=$(pwd -P)" >> "$UPGRADE_LOG"',
    'case " $* " in *" --project "*)',
    '  [ -n "${STUB_PIN_CONFLICT:-}" ] && { echo "gstack-capy-install: Bun conflict: gstack needs >=1.4.2 (verified archives: 1.4.2 1.4.3), $2/package.json pins exactly 1.3.14; fix: raise the project\'s pin (RUNTIME_PIN_CONFLICT; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-install-runtime-conflict)" >&2; exit 3; }',
    '  [ -n "${STUB_PINS_FAIL:-}" ] && { echo "FAIL pins — bun 1.4.2 outside CI 1.4.3; fix: x (PROJECT_PIN_MISMATCH; d)"; echo "gstack: fail pins"; exit 1; }',
    '  [ -n "${STUB_PROJECT_STOP:-}" ] && { echo "gstack-capy-install: preflight: jq not found; fix: install jq (INSTALL_PREFLIGHT_FAILED; d)" >&2; exit 3; } ;;',
    'esac',
    'echo "wrapper-env rev=${GSTACK_CAPY_WRAPPER_REV:-} path=${GSTACK_CAPY_WRAPPER_PATH:-}" >> "$UPGRADE_LOG.env"',
    '[ -n "${STUB_STOP:-}" ] && { echo "gstack-capy-install: preflight: curl not found; fix: install curl (INSTALL_PREFLIGHT_FAILED; d)" >&2; exit 3; }',
    '[ -n "${STUB_WRAPPER_FAIL:-}" ] && { echo "FAIL wrapper — every Capy skill copy is stale; fix: x (CAPY_WRAPPER_STALE; d)"; echo "gstack: fail wrapper"; exit 1; }',
    '[ -f "${STUB_FAIL_ONCE:-/nonexistent}" ] && { rm -f "$STUB_FAIL_ONCE"; echo "gstack: fail setup — ./setup failed"; exit 1; }',
    'echo "gstack: ok $(cat "$(dirname "$0")/../VERSION") for=autoplan"',
  ].join('\n') + '\n';
  const capyFixture = () => {
    const f = fixture();
    write(path.join(f.root, 'bin/gstack-capy-install'), STUB_CAPY, 0o755);
    write(path.join(f.root, '.git/gstack-capy-install.state'), `head=${f.a}\n`);
    const project = path.join(f.host.base, 'project');
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init', '-q', project], { timeout: 30_000 });
    const from = (cwd: string, args: string[] = [], extra: Record<string, string> = {}) =>
      spawnSync('bash', [path.join(f.root, 'bin/gstack-upgrade'), ...args], { cwd, encoding: 'utf8', env: { ...f.host.env, UPGRADE_LOG: path.join(f.host.base, 'calls.log'), ...extra }, timeout: 60_000 });
    return { ...f, project: fs.realpathSync(project), from, pending: path.join(f.root, '.git/gstack-upgrade.pending') };
  };

  test('A-b: from a RUNTIME_PIN_CONFLICT project the move is kept, `upgraded` then `gstack: fail pins`, exit 1, no pending marker; the no-op path says the same', () => {
    const f = capyFixture();
    const r = f.from(f.project, [], { STUB_PIN_CONFLICT: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('gstack-upgrade: upgraded 1.0.0 -> 1.0.1');
    expect(lines.at(-1)).toBe(`gstack: fail pins — Bun conflict: gstack needs >=1.4.2 (verified archives: 1.4.2 1.4.3), ${f.project}/package.json pins exactly 1.3.14; fix: raise the project's pin (RUNTIME_PIN_CONFLICT; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#capy-install-runtime-conflict)`);
    expect(r.stdout).not.toContain('gstack: ok');
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
    expect(fs.existsSync(f.pending)).toBe(false);
    expect(f.calls()).toEqual([`capy-install  cwd=${f.root}`, `capy-install --project ${f.project} cwd=${f.project}`]);
    const again = f.from(f.project, [], { STUB_PIN_CONFLICT: '1' });
    expect(again.status).toBe(1);
    expect(again.stdout.trim().split('\n')[0]).toBe('gstack-upgrade: current 1.0.1');
    expect(again.stdout.trim().split('\n').at(-1)).toMatch(/^gstack: fail pins — Bun conflict: /);
    expect(f.from(f.project, ['--check'], { STUB_PIN_CONFLICT: '1' }).status).toBe(0);
  });

  test('a verified-pin project ends on the installer\'s ok for that project; a pins failure ends on its `gstack: fail pins`; from /tmp nothing is certified', () => {
    const f = capyFixture();
    const ok = f.from(f.project);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout.trim().split('\n').at(-1)).toBe('gstack: ok 1.0.1 for=autoplan');
    expect(ok.stdout.match(/^gstack: /gm)).toHaveLength(1);
    const fail = f.from(f.project, [], { STUB_PINS_FAIL: '1' });
    expect(fail.status).toBe(1);
    expect(fail.stdout.trim().split('\n').at(-1)).toBe('gstack: fail pins');
    expect(fs.existsSync(f.pending)).toBe(false);
    const g = capyFixture();
    const outside = g.from(fs.realpathSync(g.host.base), [], { STUB_PINS_FAIL: '1' });
    expect(outside.status, outside.stdout + outside.stderr).toBe(0);
    expect(g.calls()).toEqual([`capy-install  cwd=${g.root}`]);
    expect(outside.stdout.trim().split('\n').at(-1)).toBe('gstack: ok 1.0.1 for=autoplan');
  });

  test('a pending repair resumed from another project certifies that project', () => {
    const f = capyFixture();
    const once = path.join(f.host.base, 'fail-once');
    write(once, '');
    const failed = f.from(fs.realpathSync(f.host.base), [], { STUB_FAIL_ONCE: once });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('gstack: fail setup');
    expect(fs.existsSync(f.pending)).toBe(true);
    const resumed = f.from(f.project);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('gstack-upgrade: current 1.0.1; reinstall pending from 1.0.0');
    expect(fs.existsSync(f.pending)).toBe(false);
    expect(f.calls().at(-1)).toBe(`capy-install --project ${f.project} cwd=${f.project}`);
  });

  // Integration items 2 and 9: the wrapper row is never a reinstall failure,
  // and every installer stop line becomes a trailer.
  test('a reinstall whose only failing row is wrapper leaves no pending marker; the installer runs with the checkout copy as the active wrapper', () => {
    const f = capyFixture();
    write(path.join(f.root, 'capy/skill/gstack/scripts/install.sh'), 'GSTACK_CAPY_WRAPPER=7\n');
    const r = f.from(fs.realpathSync(f.host.base), [], { STUB_WRAPPER_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('gstack: fail wrapper');
    expect(r.stdout).toContain('only the wrapper row failed (an owner action on the Drive copy, CAPY_WRAPPER_STALE), so no reinstall is pending');
    expect(r.stderr).not.toContain('completes the pending reinstall');
    expect(fs.existsSync(f.pending)).toBe(false);
    const again = f.from(fs.realpathSync(f.host.base));
    expect(again.stdout).not.toContain('reinstall pending');
    expect(fs.readFileSync(path.join(f.host.base, 'calls.log.env'), 'utf8')).toContain(`rev=7 path=${f.root}/capy/skill/gstack/scripts/install.sh`);
  });

  test('an installer stop line maps to `gstack: fail runtime — <msg>`: in the caller-project check (no pending) and in the reinstall (pending kept)', () => {
    const f = capyFixture();
    const cert = f.from(f.project, [], { STUB_PROJECT_STOP: '1' });
    expect(cert.status).toBe(1);
    expect(cert.stdout.trim().split('\n').at(-1)).toBe('gstack: fail runtime — preflight: jq not found; fix: install jq (INSTALL_PREFLIGHT_FAILED; d)');
    expect(fs.existsSync(f.pending)).toBe(false);
    const g = capyFixture();
    const re = g.from(g.project, [], { STUB_STOP: '1' });
    expect(re.status).toBe(1);
    expect(re.stdout.trim().split('\n').at(-1)).toBe('gstack: fail runtime — preflight: curl not found; fix: install curl (INSTALL_PREFLIGHT_FAILED; d)');
    expect(fs.existsSync(g.pending)).toBe(true);
  });

  test('off Capy the caller\'s project is certified by the doctor\'s runtime and pins rows', () => {
    const f = fixture();
    write(path.join(f.root, 'bin/gstack-doctor'), '#!/usr/bin/env bash\necho "doctor $*" >> "$UPGRADE_LOG"\n[ -n "${STUB_PINS_FAIL:-}" ] && { echo "FAIL pins — x"; echo "gstack: fail pins"; exit 1; }\necho "gstack: ok 1.0.1 for=require=runtime,pins"\n', 0o755);
    const project = path.join(f.host.base, 'project');
    fs.mkdirSync(project);
    spawnSync('git', ['init', '-q', project], { timeout: 30_000 });
    const r = spawnSync('bash', [path.join(f.root, 'bin/gstack-upgrade')], { cwd: project, encoding: 'utf8', env: { ...f.host.env, UPGRADE_LOG: path.join(f.host.base, 'calls.log'), STUB_PINS_FAIL: '1' }, timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('gstack: fail pins');
    expect(f.calls()).toEqual(['setup --refresh-registered', `doctor --check --require runtime,pins --project ${fs.realpathSync(project)}`]);
  });

  // Value: protects=an install whose enclosing project tracks its files is refused before it moves, so a project checkout cannot revert VERSION behind an upgraded HEAD (#1022);
  //   fails_when=the enclosing-project check is dropped or matches a submodule gitlink; why_new=no case had an enclosing repository; seam=none
  test('a project that tracks the install\'s files refuses --check and default with UPGRADE_REFUSED naming the untrack fix (#1022)', () => {
    const f = fixture({ parent: 'files' });
    const reflog = f.git(['reflog']);
    for (const args of [['--check'], []]) {
      const r = f.run(args);
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stderr).toContain('(UPGRADE_REFUSED)');
      expect(r.stderr).toContain(`${f.project} tracks`);
      expect(r.stderr).toContain(`git -C '${f.project}' --literal-pathspecs rm -r -q --cached -- '.claude/skills/gstack'`);
      expect(r.stderr.trim().split('\n').filter(l => l.startsWith('gstack-upgrade: '))).toHaveLength(1);
      expect(f.git(['rev-parse', 'HEAD'])).toBe(f.a);
      expect(f.git(['reflog'])).toBe(reflog);
    }
    expect(f.calls()).toEqual([]);
    f.parentGit(['rm', '-r', '-q', '--cached', '--', '.claude/skills/gstack']);
    f.git(['stash', 'push', '-m', 'files reverted by the project']);
    const fixed = f.run();
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(fixed.stdout).toContain('gstack-upgrade: upgraded 1.0.0 -> 1.0.1');
  });

  // Value: protects=the supported vendoring shape (a submodule gitlink) still upgrades; fails_when=the #1022 check counts a gitlink as tracked files;
  //   why_new=negative control for the case above; seam=none
  test('a project that holds the install as a submodule gitlink upgrades normally', () => {
    const f = fixture({ parent: 'gitlink' });
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.git(['rev-parse', 'HEAD'])).toBe(f.b);
  });

  // Value: protects=a working-tree VERSION that disagrees with HEAD is never reported current (the frozen VERSION of #1022);
  //   fails_when=the current path trusts the VERSION file without comparing it to HEAD; why_new=every current case had a clean tree; seam=none
  test('a VERSION reverted behind HEAD is not current: --check and default refuse naming both versions (#1022)', () => {
    const f = fixture();
    expect(f.run(['--ff-only-no-reinstall']).status).toBe(0);
    fs.writeFileSync(path.join(f.root, 'VERSION'), '1.0.0\n');
    for (const args of [['--check'], []]) {
      const r = f.run(args);
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).not.toContain('gstack-upgrade: current');
      expect(r.stderr).toContain('VERSION says 1.0.0 but the checkout is at 1.0.1');
      expect(r.stderr).toContain('(UPGRADE_REFUSED)');
    }
    expect(f.calls()).toEqual([]);
    f.git(['stash', 'push', '-q', '-m', 'files reverted by the project']);
    const fixed = f.run(['--check']);
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    expect(fixed.stdout).toContain('gstack-upgrade: current 1.0.1');
  });

  // Value: protects=a Windows checkout with core.autocrlf (VERSION written CRLF) is not mistaken for a reverted VERSION;
  //   fails_when=the VERSION check compares raw bytes instead of git's eol-normalized diff; why_new=the check is new; seam=none
  test('a CRLF VERSION under core.autocrlf=true is current, not reverted', () => {
    const f = fixture();
    expect(f.run(['--ff-only-no-reinstall']).status).toBe(0);
    f.git(['config', 'core.autocrlf', 'true']);
    fs.writeFileSync(path.join(f.root, 'VERSION'), '1.0.1\r\n');
    const r = f.run(['--check']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('gstack-upgrade: current 1.0.1');
  });

  test('every bin a trailer or fix line names exists in the repo', () => {
    const sources = ['bin/gstack-capy-install', 'bin/gstack-doctor-check.sh', 'bin/gstack-skill-end', 'bin/gstack-upgrade', 'docs/capy-install.md',
      'capy/skill/gstack/SKILL.md', 'capy/skill/gstack/scripts/install.sh'];
    const named = new Set<string>();
    for (const rel of sources) {
      expect(fs.existsSync(path.join(REPO, rel)), rel).toBe(true);
      const lines = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').filter(l => /fix:|\brun |gstack: (ok|fail)/.test(l));
      for (const m of lines.join('\n').matchAll(/(?:bin\/|\brun |\bfix: )(gstack-[a-z0-9-]+(?:\.sh|\.ts)?)\b/g)) named.add(m[1]);
    }
    expect(named.has('gstack-upgrade')).toBe(true);
    const missing = [...named].filter(n => !fs.existsSync(path.join(REPO, 'bin', n)));
    expect(missing).toEqual([]);
  });
});

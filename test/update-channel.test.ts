/**
 * Update channels (free; docs/releases.md). A team install follows
 * refs/heads/stable, the weekly release, instead of every merge to main:
 * bin/gstack-update-channel.sh resolves update_channel (auto | stable | main;
 * auto is stable when team_mode is true), bin/gstack-session-update fetches
 * and fast-forwards to the channel ref, falls back to main before the first
 * release exists and never moves an install backwards, bin/gstack-upgrade
 * follows the same ref, and bin/gstack-update-check compares with the channel
 * so a stable install is not told that main moved.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runBin } from './helpers/run-bin';
import { isolatedEnv } from './helpers/state-root-isolation';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin', 'gstack-update-channel.sh');
const CONFIG_BIN = path.join(ROOT, 'bin', 'gstack-config');
const SESSION_UPDATE = path.join(ROOT, 'bin', 'gstack-session-update');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });
/** Every spawn here starts from ENV: no state-root variable from the parent shell and HOME in a temp dir, so nothing reaches the user's real config (GST-1659; test/state-root-isolation.test.ts). */
const SAFE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-home-'));
afterAll(() => fs.rmSync(SAFE_HOME, { recursive: true, force: true }));
const ENV = isolatedEnv(SAFE_HOME);

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...ENV, ...GIT_ENV } }).trim();
}
const write = (file: string, text: string, mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode }); };

/** A gstack-config stub: team_mode and update_channel come from files the test writes. */
const CONFIG_STUB = '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; team_mode) cat "$TEAM_MODE_FILE" 2>/dev/null;; update_channel) cat "$CHANNEL_FILE" 2>/dev/null;; *) echo "";; esac; fi\nexit 0\n';

describe.skipIf(process.platform === 'win32')('gstack-update-channel.sh: resolution', () => {
  function install() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-'));
    bases.push(base);
    write(path.join(base, 'bin', 'gstack-config'), CONFIG_STUB, 0o755);
    const resolve = (team: string, channel: string, extra: Record<string, string> = {}) => {
      fs.writeFileSync(path.join(base, 'team'), team);
      fs.writeFileSync(path.join(base, 'channel'), channel);
      const r = spawnSync('bash', ['-c', '. "$1" && gstack_update_channel "$2"', '_', HELPER, base], { encoding: 'utf8', env: { ...ENV, TEAM_MODE_FILE: path.join(base, 'team'), CHANNEL_FILE: path.join(base, 'channel'), GSTACK_UPDATE_CHANNEL: '', ...extra }, timeout: 10_000 });
      return r.stdout.trim() + (r.status === 0 ? '' : ' exit=' + r.status);
    };
    return { base, resolve };
  }

  test('auto is stable for a team install and main otherwise; explicit values win; junk is auto; the env override wins over all', () => {
    const f = install();
    expect(f.resolve('true', '')).toBe('stable');
    expect(f.resolve('true', 'auto')).toBe('stable');
    expect(f.resolve('false', '')).toBe('main');
    expect(f.resolve('', '')).toBe('main');
    expect(f.resolve('true', 'main')).toBe('main');
    expect(f.resolve('false', 'stable')).toBe('stable');
    expect(f.resolve('true', 'weekly')).toBe('stable');
    expect(f.resolve('false', 'weekly')).toBe('main');
    expect(f.resolve('true', 'stable', { GSTACK_UPDATE_CHANNEL: 'main' })).toBe('main');
  });

  test('the refspec names stable only; a missing gstack-config means main', () => {
    const r = spawnSync('bash', ['-c', '. "$1" && gstack_update_channel_refspec stable && gstack_update_channel_refspec main | wc -c && gstack_update_channel /nonexistent', '_', HELPER], { encoding: 'utf8', timeout: 10_000, env: { ...ENV, GSTACK_UPDATE_CHANNEL: '' } });
    expect(r.stdout.split('\n').map(l => l.trim())).toEqual(['+refs/heads/stable:refs/remotes/origin/stable', '1', 'main', '']);
    expect(spawnSync('bash', ['-c', '. "$1" && gstack_update_channel_missing "fatal: couldn\'t find remote ref refs/heads/stable" && ! gstack_update_channel_missing "fatal: unable to access"', '_', HELPER], { encoding: 'utf8', timeout: 10_000, env: ENV }).status).toBe(0);
  });
});

describe('gstack-config update_channel', () => {
  // Value: protects=update_channel defaults to auto in get, list and defaults, accepts exactly auto|stable|main, and rejects anything else with exit 1 and the
  // stored value unchanged; fails_when=the default arm, the closed-domain guard or the list/defaults rows are dropped, or a typo is stored and silently read as auto;
  // why_new=the resolution tests stub gstack-config, so the real key's contract (the one docs/releases.md documents) has no test; seam=none;
  // no_claim=none beyond protects
  test('defaults to auto, accepts auto|stable|main, and refuses anything else without changing the stored value', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-config-'));
    bases.push(home);
    const run = (args: string[]) => runBin(CONFIG_BIN, args, { gstackHome: home, home: SAFE_HOME, cwd: ROOT, trim: true });
    expect(run(['get', 'update_channel']).stdout).toBe('auto');
    expect(run(['defaults']).stdout).toMatch(/update_channel:\s+auto$/m);
    expect(run(['list']).stdout).toMatch(/update_channel:\s+auto \(default\)$/m);
    for (const v of ['stable', 'main', 'auto']) {
      expect(run(['set', 'update_channel', v]).status).toBe(0);
      expect(run(['get', 'update_channel']).stdout).toBe(v);
    }
    expect(run(['set', 'update_channel', 'stable']).status).toBe(0);
    const junk = run(['set', 'update_channel', 'weekly']);
    expect(junk.status).toBe(1);
    expect(junk.stderr).toContain("update_channel 'weekly' not recognized. Valid values: auto, stable, main. Existing value left unchanged.");
    expect(run(['get', 'update_channel']).stdout).toBe('stable');
    expect(run(['list']).stdout).toMatch(/update_channel:\s+stable \(set\)$/m);
    expect(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')).toContain('# update_channel: auto      # auto   = stable when team_mode is true, else main');
  });
});

/** Origin with main A < B < C, stable at B, a single-branch depth-1 install at A (as README's clone command makes). */
function world(opts: { installAt?: 'A' | 'C'; stable?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-world-'));
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  fs.mkdirSync(state); fs.mkdirSync(home);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000, env: ENV });
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  write(path.join(seed, 'bin', 'gstack-config'), CONFIG_STUB, 0o755);
  write(path.join(seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  for (const rel of ['bin/gstack-sanitize-echo.sh', 'bin/gstack-update-channel.sh', 'bin/gstack-bun-version.sh', 'bin/gstack-paths', 'bin/gstack-state-root.sh', 'bin/gstack-egress-lib.sh', 'bin/gstack-egress-receipt', 'lib/egress-receipt.ts', 'lib/state-root.ts', 'bin/gstack-lease', 'bin/gstack-harness-pid.sh', 'bin/gstack-install-verdict.sh', 'bin/gstack-upgrade']) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(seed, rel));
    fs.chmodSync(path.join(seed, rel), fs.statSync(path.join(ROOT, rel)).mode);
  }
  write(path.join(seed, 'setup'), '#!/usr/bin/env bash\necho "setup $*" >> "$SETUP_CALLS"\nexit 0\n', 0o755);
  const shas: Record<string, string> = {};
  const release = (name: string, version: string) => {
    write(path.join(seed, 'VERSION'), version + '\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', name);
    git(seed, 'push', '-q', 'origin', 'main');
    shas[name] = git(seed, 'rev-parse', 'HEAD');
  };
  release('A', '1.0.0');
  if (opts.installAt !== 'C') execFileSync('git', ['clone', '-q', '--single-branch', '--depth', '1', 'file://' + origin, install], { timeout: 30_000, env: ENV });
  release('B', '1.0.1');
  release('C', '1.0.2');
  if (opts.installAt === 'C') execFileSync('git', ['clone', '-q', '--single-branch', '--depth', '1', 'file://' + origin, install], { timeout: 30_000, env: ENV });
  if (opts.stable !== false) git(seed, 'push', '-q', 'origin', shas.B + ':refs/heads/stable');
  const team = path.join(base, 'team'), channel = path.join(base, 'channel'), calls = path.join(base, 'setup-calls');
  fs.writeFileSync(team, 'true'); fs.writeFileSync(channel, '');
  const env = { ...ENV, ...GIT_ENV, HOME: home, GSTACK_DIR: install, GSTACK_STATE_ROOT: state, TEAM_MODE_FILE: team, CHANNEL_FILE: channel, SETUP_CALLS: calls, TMPDIR: base, GSTACK_UPDATE_CHANNEL: '' };
  return { base, origin, seed, install, state, shas, team, channel, env, head: () => git(install, 'rev-parse', 'HEAD') };
}
type World = ReturnType<typeof world>;

async function updaterLog(w: World, pattern: RegExp, ms = 20_000): Promise<string> {
  const logFile = path.join(w.state, 'analytics', 'session-update.log');
  const deadline = Date.now() + ms;
  let content = '';
  while (Date.now() < deadline) {
    content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (pattern.test(content) && !fs.existsSync(path.join(w.state, '.setup-lock'))) return content;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for ' + pattern + '; log:\n' + content);
}
function runHook(w: World) {
  return spawnSync('bash', [SESSION_UPDATE], { encoding: 'utf8', env: { ...w.env, PATH: path.dirname(process.execPath) + ':' + process.env.PATH }, timeout: 20_000 });
}

describe.skipIf(process.platform === 'win32')('gstack-session-update on the stable channel', () => {
  test('a team install moves to origin/stable (B), not main (C), and logs the channel', async () => {
    const w = world();
    expect(w.head()).toBe(w.shas.A);
    expect(runHook(w).stdout).toBe('');
    const log = await updaterLog(w, /UPDATED|PULL_FAILED|UP_TO_DATE/);
    expect(log).toContain('CHANNEL stable target=' + w.shas.B);
    expect(log).toContain('UPDATING old=' + w.shas.A + ' new=' + w.shas.B);
    expect(log).toContain('UPDATED from=1.0.0 to=1.0.1');
    expect(w.head()).toBe(w.shas.B);
    expect(fs.readFileSync(path.join(w.install, 'VERSION'), 'utf8').trim()).toBe('1.0.1');
  });

  test('update_channel=main on a team install follows every merge (C), as before channels existed', async () => {
    const w = world();
    fs.writeFileSync(w.channel, 'main');
    runHook(w);
    const log = await updaterLog(w, /UPDATED|PULL_FAILED|UP_TO_DATE/);
    expect(log).not.toContain('CHANNEL ');
    expect(log).toContain('UPDATING old=' + w.shas.A + ' new=' + w.shas.C);
    expect(w.head()).toBe(w.shas.C);
  });

  test('before the first release exists (no stable on origin) the install follows main and says so', async () => {
    const w = world({ stable: false });
    runHook(w);
    const log = await updaterLog(w, /UPDATED|PULL_FAILED|UP_TO_DATE/);
    expect(log).toContain('CHANNEL_FALLBACK stable->main reason=no-stable-on-origin');
    expect(log).toContain('UPDATING old=' + w.shas.A + ' new=' + w.shas.C);
    expect(w.head()).toBe(w.shas.C);
  });

  test('an install already past the release (at C, stable at B) stays where it is: up to date, no pull failure, nothing pending', async () => {
    const w = world({ installAt: 'C' });
    runHook(w);
    const log = await updaterLog(w, /UPDATED|PULL_FAILED|UP_TO_DATE/);
    expect(log).toContain('CHANNEL stable ahead_of_release head=' + w.shas.C + ' stable=' + w.shas.B);
    expect(log).toContain('UP_TO_DATE head=' + w.shas.C);
    expect(log).not.toContain('PULL_FAILED');
    expect(w.head()).toBe(w.shas.C);
    expect(fs.existsSync(path.join(w.state, 'session-update-pending'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-update-channel.sh as the /gstack-upgrade skill runs it', () => {
  const cli = (w: World, ...args: string[]) => spawnSync('bash', [path.join(w.install, 'bin', 'gstack-update-channel.sh'), ...args, w.install], { cwd: w.base, encoding: 'utf8', env: w.env, timeout: 30_000 });

  // Value: protects=the CLI the upgrade skill substitutes into UPSTREAM_REF: it prints the channel, --fetch-ref fetches and names origin/stable for a team install,
  // and names origin/main (with the note) when origin has no stable or the channel is main; fails_when=argument parsing or the fallback breaks so the skill
  // resets a team install to origin/main, or --fetch-ref prints a ref it never fetched; why_new=the function-level tests source the helper and never run its
  // __main__ block; seam=none; no_claim=the skill's own fence (the template is pinned by upgrade-template-pins.test.ts; this runs the helper alone)
  test('prints the channel; --fetch-ref names origin/stable after fetching it, and origin/main when there is no release yet or the channel is main', () => {
    const w = world();
    expect(cli(w).stdout.trim()).toBe('stable');
    const stable = cli(w, '--fetch-ref');
    expect(stable.status, stable.stdout + stable.stderr).toBe(0);
    expect(stable.stdout.trim()).toBe('origin/stable');
    expect(stable.stderr).toBe('');
    expect(git(w.install, 'rev-parse', 'refs/remotes/origin/stable')).toBe(w.shas.B);
    expect(w.head()).toBe(w.shas.A);

    fs.writeFileSync(w.channel, 'main');
    expect(cli(w).stdout.trim()).toBe('main');
    const onMain = cli(w, '--fetch-ref');
    expect(onMain.status).toBe(0);
    expect(onMain.stdout.trim()).toBe('origin/main');
    expect(onMain.stderr).toBe('');
    expect(git(w.install, 'rev-parse', 'refs/remotes/origin/main')).toBe(w.shas.C);

    const early = world({ stable: false });
    const fallback = cli(early, '--fetch-ref');
    expect(fallback.status).toBe(0);
    expect(fallback.stdout.trim()).toBe('origin/main');
    expect(fallback.stderr).toContain('origin has no stable release yet; following origin/main until the first stable release is cut');
    expect(git(early.install, 'rev-parse', 'refs/remotes/origin/main')).toBe(early.shas.C);
    expect(early.head()).toBe(early.shas.A);

    // A fetch that fails for any other reason (origin unreachable) keeps the
    // team install on origin/stable; the fast-forward then stops or finds
    // nothing new, and nobody is moved to main by a network blink.
    const offline = world();
    git(offline.install, 'remote', 'set-url', 'origin', path.join(offline.base, 'gone.git'));
    const kept = cli(offline, '--fetch-ref');
    expect(kept.status).toBe(0);
    expect(kept.stdout.trim()).toBe('origin/stable');
    expect(kept.stderr).toContain('fetching origin/stable failed');
    expect(kept.stderr).toContain('staying on origin/stable as last fetched');
  });
});

describe.skipIf(process.platform === 'win32')('the /gstack-upgrade Step 4 fence on the stable channel', () => {
  const fence = (() => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md.tmpl'), 'utf8');
    const hits = [...tmpl.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]!).filter(f => f.includes('bash bin/gstack-ff-update . "$UPSTREAM_REF"'));
    if (hits.length !== 1) throw new Error('expected one Step 4 fence, found ' + hits.length);
    return hits[0]!.replace(/\{\{SETUP_COMMAND\}\}/g, './setup');
  })();
  const run = (w: World) => spawnSync('bash', ['-c', fence], { cwd: w.base, encoding: 'utf8', timeout: 60_000, env: { ...w.env, INSTALL_DIR: w.install } });

  // Value: protects=a team install past the release stops with AHEAD_OF_STABLE and moves nothing, including the README's depth-1 clone where stable's history
  // never connects to HEAD (ancestry says nothing; the VERSION order decides), and an install behind the release does not take that exit; fails_when=the shortcut
  // tests ancestry alone (depth-1 installs made since the last cut get FF_REFUSED and an offer to reset backwards) or fires for an install stable is ahead of;
  // why_new=the template is covered by string pins only; seam=none; no_claim=the FF_OK arm (bin/gstack-ff-update and setup are not part of this world)
  test('a depth-1 team install past the release prints AHEAD_OF_STABLE and exits 0 untouched; one behind the release goes on to the fast-forward', () => {
    const ahead = world({ installAt: 'C' });
    const r = run(ahead);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('UPSTREAM_REF=origin/stable');
    expect(r.stdout.trim().split('\n').at(-1)).toBe('AHEAD_OF_STABLE');
    expect(ahead.head()).toBe(ahead.shas.C);
    expect(git(ahead.install, 'rev-parse', 'refs/remotes/origin/stable')).toBe(ahead.shas.B);
    // The depth-1 histories never connect, so ancestry said nothing and the VERSION order decided.
    expect(spawnSync('git', ['-C', ahead.install, 'merge-base', '--is-ancestor', 'origin/stable', 'HEAD'], { encoding: 'utf8', timeout: 10_000, env: ENV }).status).toBe(1);
    expect(fs.existsSync(path.join(ahead.base, 'setup-calls'))).toBe(false);

    const behind = world({ installAt: 'A' });
    const b = run(behind);
    expect(b.stdout).toContain('UPSTREAM_REF=origin/stable');
    expect(b.stdout).not.toContain('AHEAD_OF_STABLE');
    expect(b.status).not.toBe(0);
    expect(behind.head()).toBe(behind.shas.A);
  });
});

describe.skipIf(process.platform === 'win32')('gstack-upgrade on the stable channel', () => {
  const run = (w: World, args: string[] = []) => spawnSync('bash', [path.join(w.install, 'bin', 'gstack-upgrade'), ...args], { cwd: w.base, encoding: 'utf8', env: w.env, timeout: 60_000 });

  test('--check and the upgrade follow stable (B) and name the channel; update_channel=main then goes on to C', () => {
    const w = world();
    const check = run(w, ['--check']);
    expect(check.status, check.stdout + check.stderr).toBe(1);
    expect(check.stdout).toContain('gstack-upgrade: behind 1.0.0 -> 1.0.1 (1 commits)');
    expect(check.stderr).toContain('gstack-upgrade: channel stable');
    const up = run(w);
    expect(up.status, up.stdout + up.stderr).toBe(0);
    expect(up.stdout).toContain('gstack-upgrade: upgraded 1.0.0 -> 1.0.1');
    expect(w.head()).toBe(w.shas.B);
    expect(run(w, ['--check']).stdout).toContain('gstack-upgrade: current 1.0.1');
    fs.writeFileSync(w.channel, 'main');
    const main = run(w, ['--check']);
    expect(main.stdout).toContain('gstack-upgrade: behind 1.0.1 -> 1.0.2 (1 commits)');
    expect(main.stderr).not.toContain('channel stable');
    expect(run(w).status).toBe(0);
    expect(w.head()).toBe(w.shas.C);
  });

  test('a depth-1 install already past the release (at C, stable at B) is current, not diverged', () => {
    const w = world({ installAt: 'C' });
    const check = run(w, ['--check']);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    expect(check.stdout).toContain('gstack-upgrade: current 1.0.2');
    expect(w.head()).toBe(w.shas.C);
  });

  test('with no stable on origin yet, a team install follows main and the note says so', () => {
    const w = world({ stable: false });
    const check = run(w, ['--check']);
    expect(check.status).toBe(1);
    expect(check.stdout).toContain('gstack-upgrade: behind 1.0.0 -> 1.0.2 (2 commits)');
    expect(check.stderr).toContain('channel stable has no release on origin yet; following main');
  });
});

describe.skipIf(process.platform === 'win32')('gstack-update-check on the stable channel', () => {
  test('a checkout at stable stays silent while main is ahead; the cache identity carries the channel; ls-remote asks for refs/heads/stable', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-check-'));
    bases.push(base);
    const gstack = path.join(base, 'gstack'), origin = path.join(base, 'origin.git'), state = path.join(base, 'state'), raw = path.join(base, 'raw'), shim = path.join(base, 'shim');
    for (const d of [path.join(gstack, 'bin'), state, raw, shim]) fs.mkdirSync(d, { recursive: true });
    const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000, env: ENV }).trim();
    const gitLog = path.join(base, 'git.log');
    fs.writeFileSync(path.join(shim, 'git'), '#!/usr/bin/env bash\ncase "$1" in ls-remote) echo "git $*" >> "' + gitLog + '" ;; esac\nexec "' + realGit + '" "$@"\n', { mode: 0o755 });
    for (const name of ['gstack-config', 'gstack-egress-lib.sh', 'gstack-state-root.sh', 'gstack-egress-receipt', 'gstack-update-channel.sh']) fs.symlinkSync(path.join(ROOT, 'bin', name), path.join(gstack, 'bin', name));
    fs.writeFileSync(path.join(gstack, 'VERSION'), '1.0.0\n');
    fs.writeFileSync(path.join(gstack, '.gitignore'), 'bin/\n');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000, env: ENV });
    git(gstack, 'init', '-q', '-b', 'main'); git(gstack, 'add', '-A'); git(gstack, 'commit', '-q', '-m', 'base');
    git(gstack, 'remote', 'add', 'origin', origin); git(gstack, 'push', '-q', 'origin', 'main'); git(gstack, 'push', '-q', 'origin', 'main:stable');
    const local = git(gstack, 'rev-parse', 'HEAD');
    const clone = path.join(base, 'upstream');
    execFileSync('git', ['clone', '-q', origin, clone], { timeout: 30_000, env: ENV });
    fs.writeFileSync(path.join(clone, 'VERSION'), '1.0.1\n');
    git(clone, 'commit', '-qam', 'main moved'); git(clone, 'push', '-q', 'origin', 'HEAD:main');
    const main = git(clone, 'rev-parse', 'HEAD');
    for (const [sha, v] of [[local, '1.0.0'], [main, '1.0.1']]) { fs.mkdirSync(path.join(raw, sha!)); fs.writeFileSync(path.join(raw, sha!, 'VERSION'), v + '\n'); }
    const env = { ...ENV, ...GIT_ENV, HOME: base, GSTACK_DIR: gstack, GSTACK_STATE_ROOT: state, GSTACK_REMOTE_REPO: origin, GSTACK_REMOTE_RAW_BASE: 'file://' + raw, GSTACK_COMPARE_API: 'file://' + path.join(base, 'compare'), PATH: shim + ':' + process.env.PATH };
    delete (env as Record<string, string | undefined>).GSTACK_REMOTE_URL;
    const run = (extra: Record<string, string>) => spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-update-check')], { encoding: 'utf8', timeout: 30_000, env: { ...env, ...extra } });
    const stable = run({ GSTACK_UPDATE_CHANNEL: 'stable' });
    expect(stable.stdout.trim()).toBe('');
    expect(fs.readFileSync(path.join(state, 'last-update-check'), 'utf8')).toBe('UP_TO_DATE 1.0.0\nIDENTITY head=' + local + ' remote=' + local + ' upstream=' + origin + '#stable\n');
    expect(fs.readFileSync(gitLog, 'utf8')).toContain('refs/heads/stable');
    expect(fs.readFileSync(gitLog, 'utf8')).not.toContain('refs/heads/main');
    const onMain = run({ GSTACK_UPDATE_CHANNEL: 'main' });
    expect(onMain.stdout.trim()).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.1');
    expect(fs.readFileSync(gitLog, 'utf8')).toContain('refs/heads/main');

    // Before the first release origin has no stable: the check follows main for
    // that run (as session-update and gstack-upgrade do) instead of caching
    // CHECK_FAILED from a 404 on stable/VERSION until Monday.
    git(clone, 'push', '-q', 'origin', ':stable');
    fs.rmSync(path.join(state, 'last-update-check'), { force: true });
    fs.writeFileSync(gitLog, '');
    const noRelease = run({ GSTACK_UPDATE_CHANNEL: 'stable' });
    expect(noRelease.stdout.trim()).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.1');
    expect(fs.readFileSync(gitLog, 'utf8')).toContain('refs/heads/stable');
    expect(fs.readFileSync(gitLog, 'utf8')).toContain('refs/heads/main');
    expect(fs.readFileSync(path.join(state, 'last-update-check'), 'utf8')).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.1\nIDENTITY head=' + local + ' remote=' + main + ' upstream=' + origin + '#stable\n');
    // The outcome replays from the cache within its TTL: no second pair of ls-remote calls per skill start.
    fs.writeFileSync(gitLog, '');
    expect(run({ GSTACK_UPDATE_CHANNEL: 'stable' }).stdout.trim()).toBe('UPGRADE_AVAILABLE 1.0.0 1.0.1');
    expect(fs.readFileSync(gitLog, 'utf8')).toBe('');
    // A failed ls-remote (origin unreachable) is not "no stable yet": the check does not flip to main.
    fs.writeFileSync(gitLog, '');
    fs.rmSync(path.join(state, 'last-update-check'), { force: true });
    const unreachable = run({ GSTACK_UPDATE_CHANNEL: 'stable', GSTACK_REMOTE_REPO: path.join(base, 'gone.git') });
    expect(unreachable.stdout.trim()).toBe('');
    expect(fs.readFileSync(gitLog, 'utf8')).not.toContain('refs/heads/main');
    expect(fs.readFileSync(path.join(state, 'last-update-check'), 'utf8')).toMatch(/^CHECK_FAILED 1\.0\.0 /);
  });
});

describe.skipIf(process.platform === 'win32')('gstack_update_channel_initial: the channel ./setup records at first install', () => {
  // Value: protects=a fresh state root on a user's checkout (default branch, upstream, no local commits, no contributor marker) gets stable, an explicit
  // GSTACK_UPDATE_CHANNEL is recorded as given, every contributor signal and every existing install (setup marker, config.yaml, legacy marker) records
  // nothing so auto keeps following main; fails_when=a contributor checkout or an existing install is switched to stable, or a plain clone is not;
  // why_new=the first-install record is new (GST-1642); seam=the helper's CLI, which ./setup calls; no_claim=setup's own call (update-channel-setup.test.ts)
  function checkout() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-channel-initial-'));
    bases.push(base);
    const origin = path.join(base, 'origin.git'), seed = path.join(base, 'seed'), home = path.join(base, 'home'), state = path.join(base, 'state');
    fs.mkdirSync(home);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000, env: ENV });
    fs.mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    write(path.join(seed, 'VERSION'), '1.0.0\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'A');
    git(seed, 'push', '-q', origin, 'main');
    const clone = (name: string, ...flags: string[]) => {
      const dir = path.join(base, name);
      execFileSync('git', ['clone', '-q', ...flags, 'file://' + origin, dir], { timeout: 30_000, env: { ...ENV, ...GIT_ENV, HOME: home } });
      return dir;
    };
    const initial = (dir: string, extra: Record<string, string> = {}) => spawnSync('bash', [HELPER, '--initial', state, dir], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...ENV, ...GIT_ENV, HOME: home, GSTACK_UPDATE_CHANNEL: '', GSTACK_CONTRIBUTOR: '', CI: '', CAPY_MACHINE_CONFIG: '', ...extra },
    }).stdout.trim();
    return { base, home, state, clone, initial };
  }

  test('a plain clone (full or the README depth-1 one) on a fresh state root records stable; an explicit GSTACK_UPDATE_CHANNEL is recorded as given', () => {
    const c = checkout();
    expect(c.initial(c.clone('full'))).toBe('stable new install');
    const shallow = c.clone('shallow', '--single-branch', '--depth', '1');
    expect(c.initial(shallow)).toBe('stable new install');
    expect(c.initial(shallow, { GSTACK_UPDATE_CHANNEL: 'main' })).toBe('main set by GSTACK_UPDATE_CHANNEL at install');
    expect(c.initial(shallow, { GSTACK_UPDATE_CHANNEL: 'stable', CI: 'true' })).toBe('stable set by GSTACK_UPDATE_CHANNEL at install');
    expect(c.initial(shallow, { GSTACK_UPDATE_CHANNEL: 'weekly' })).toBe('stable new install');
    expect(c.initial(shallow, { CAPY_MACHINE_CONFIG: '/etc/capy.json' })).toBe('main Capy machine: crews follow every merge');
    fs.mkdirSync(path.join(c.home, '.capy', 'system'), { recursive: true });
    expect(c.initial(shallow)).toBe('main Capy machine: crews follow every merge');
    fs.rmSync(path.join(c.home, '.capy'), { recursive: true });
    const usage = spawnSync('bash', [HELPER, '--initial'], { encoding: 'utf8', timeout: 10_000, env: ENV });
    expect([usage.status, usage.stderr.trim()]).toEqual([2, 'usage: gstack-update-channel.sh --initial <state root> [<install dir>]']);
  });

  test('an existing install records nothing: a setup marker or config.yaml in the state root, or the legacy ~/.gstack marker', () => {
    const c = checkout();
    const dir = c.clone('full');
    for (const marker of [path.join(c.state, '.last-setup-version'), path.join(c.state, 'config.yaml'), path.join(c.home, '.gstack', '.last-setup-version'), path.join(c.home, '.gstack', 'config.yaml')]) {
      write(marker, '1.0.0\n');
      expect(c.initial(dir), marker).toBe('');
      expect(c.initial(dir, { GSTACK_UPDATE_CHANNEL: 'main' }), marker).toBe('');
      fs.rmSync(marker);
    }
    expect(c.initial(dir)).toBe('stable new install');
  });

  test('a contributor checkout records nothing (auto): the marker, CI, another branch, local commits, a detached HEAD, no upstream, a nested directory', () => {
    const c = checkout();
    const dir = c.clone('full');
    expect(c.initial(dir, { GSTACK_CONTRIBUTOR: '1' })).toBe('auto contributor checkout: gstack.contributor is set');
    expect(c.initial(dir, { CI: 'true' })).toBe('auto contributor checkout: CI');
    git(dir, 'config', 'gstack.contributor', 'true');
    expect(c.initial(dir)).toBe('auto contributor checkout: gstack.contributor is set');
    git(dir, 'config', '--unset', 'gstack.contributor');
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(c.initial(path.join(dir, 'sub'))).toBe('auto not a git checkout of its own');
    git(dir, 'checkout', '-q', '-b', 'work');
    expect(c.initial(dir)).toBe('auto contributor checkout: on branch work');
    git(dir, 'checkout', '-q', 'main');
    write(path.join(dir, 'VERSION'), '1.0.0-mine\n');
    git(dir, 'commit', '-q', '-am', 'mine');
    expect(c.initial(dir)).toBe('auto contributor checkout: local commits');
    git(dir, 'checkout', '-q', '--detach', 'HEAD~1');
    expect(c.initial(dir)).toBe('auto contributor checkout: HEAD is detached');
    const lone = path.join(c.base, 'lone');
    fs.mkdirSync(lone);
    git(lone, 'init', '-q', '-b', 'main');
    git(lone, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect(c.initial(lone)).toBe('auto contributor checkout: no upstream branch');
  });
});

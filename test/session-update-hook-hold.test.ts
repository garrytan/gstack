import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The auto-updater fast-forwards the live checkout before setup runs, and
// Claude Code runs hooks straight from that checkout, so setup's parse gate
// alone cannot protect an auto-update. The updater parse-checks every hook of
// the incoming revision (git archive into a temp dir, bin/gstack-hook-check)
// before the fast-forward; a failure holds the update like a too-old Bun:
// the checkout does not move and the installed hooks keep running.

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'bin', 'gstack-session-update');
const HOOK = 'hosts/claude/hooks/question-log-hook';
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-supd-hooks-'));
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
  fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(seed, path.dirname(HOOK)), { recursive: true });
  fs.writeFileSync(path.join(seed, 'VERSION'), '1.0.0\n');
  fs.writeFileSync(path.join(seed, 'bin', 'gstack-config'),
    '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; *) echo "";; esac; fi\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(seed, 'bin', 'gstack-patch-names'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  // Stub setup: records each run, and registers the hook the way real setup
  // does, which is where the check reads the hook list from.
  fs.writeFileSync(path.join(seed, 'setup'), [
    '#!/usr/bin/env bash',
    'echo "$*" >> "$SETUP_CALLS"',
    `LOG_HOOK="$(_hook_command_path ${HOOK} || true)"`,
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  fs.copyFileSync(path.join(ROOT, HOOK), path.join(seed, HOOK));
  fs.chmodSync(path.join(seed, HOOK), 0o755);
  fs.writeFileSync(path.join(seed, `${HOOK}.ts`), "import { note } from './note';\nconsole.log(note);\n");
  fs.writeFileSync(path.join(seed, path.dirname(HOOK), 'note.ts'), "export const note = 'old hook ran';\n");
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
  // An existing registration pointing into the live checkout.
  const settings = path.join(home, '.claude', 'settings.json');
  const hookCmd = path.join(install, HOOK);
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: hookCmd }] }] } }, null, 2));
  return { base, seed, install, state, home, settings, hookCmd, calls: path.join(base, 'calls') };
}
type Fx = ReturnType<typeof makeFixture>;

function release(fx: Fx, version: string, edit: () => void) {
  edit();
  fs.writeFileSync(path.join(fx.seed, 'VERSION'), `${version}\n`);
  git(fx.seed, 'add', '-A');
  git(fx.seed, 'commit', '-qm', `release ${version}`);
  git(fx.seed, 'push', '-q', 'origin', 'main');
}

function runHook(fx: Fx, script = SCRIPT) {
  return spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: fx.home, GSTACK_DIR: fx.install, GSTACK_STATE_ROOT: fx.state, SETUP_CALLS: fx.calls, TMPDIR: fx.base },
    timeout: 20_000,
  });
}

async function waitFor(fx: Fx, pattern: RegExp, ms = 15_000): Promise<string> {
  const logFile = path.join(fx.state, 'analytics', 'session-update.log');
  const deadline = Date.now() + ms;
  let content = '';
  while (Date.now() < deadline) {
    content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (pattern.test(content) && !fs.existsSync(path.join(fx.state, '.setup-lock'))) return content;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${pattern}; log:\n${content}`);
}

/** Run the hook the existing registration names, as Claude Code would. */
function runRegisteredHook(fx: Fx) {
  const settings = JSON.parse(fs.readFileSync(fx.settings, 'utf8'));
  const cmd = settings.hooks.PostToolUse[0].hooks[0].command as string;
  return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', input: '{}', env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, timeout: 20_000 });
}

describe.skipIf(process.platform === 'win32')('gstack-session-update: incoming hooks are parse-checked before the fast-forward', () => {
  test('an unparseable shim at the incoming revision holds the update; the checkout and the old hook stay', async () => {
    const fx = makeFixture();
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    const shimLines = fs.readFileSync(path.join(fx.seed, HOOK), 'utf8').split('\n').length;
    release(fx, '1.1.0', () => fs.appendFileSync(path.join(fx.seed, HOOK), 'if then\n'));

    expect(runHook(fx).stdout).toBe('');
    const log = await waitFor(fx, /Z HELD hook-does-not-parse/);
    expect(log).toContain(`HELD hook-does-not-parse: ${HOOK}:${shimLines}: syntax error`);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(fs.readFileSync(path.join(fx.install, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(fs.existsSync(fx.calls)).toBe(false);
    expect(fs.readFileSync(path.join(fx.state, 'session-update-pending'), 'utf8')).toContain(`pull=hook-does-not-parse: ${HOOK}:${shimLines}:`);
    expect(fs.existsSync(path.join(fx.state, 'just-upgraded-from'))).toBe(false);
    const ran = runRegisteredHook(fx);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('old hook ran');
    // No leftover archive extraction.
    expect(fs.readdirSync(fx.base).filter(f => f.startsWith('gstack-session-hooks-'))).toEqual([]);

    // The next session start says what was held, where, and that the old hooks run.
    const next = runHook(fx).stdout;
    expect(next).toContain(`gstack auto-update: update held (hook-does-not-parse: ${HOOK}:${shimLines}:`);
    expect(next).toContain('your current hooks keep running');
    expect(next).toContain(`This is a gstack bug; report ${HOOK}:${shimLines}: `);
    expect(next).toContain('https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#auto-update-hook-does-not-parse');
  });

  test('a broken module the incoming TypeScript entry imports holds the update', async () => {
    const fx = makeFixture();
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    release(fx, '1.1.0', () => fs.writeFileSync(path.join(fx.seed, path.dirname(HOOK), 'note.ts'), 'export const note = ;\n'));
    runHook(fx);
    const log = await waitFor(fx, /Z HELD /);
    expect(log).toContain(`HELD hook-does-not-parse: ${path.dirname(HOOK)}/note.ts:1:`);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(runRegisteredHook(fx).stdout).toContain('old hook ran');
  });

  test('a parseable incoming revision fast-forwards and runs setup (control)', async () => {
    const fx = makeFixture();
    release(fx, '1.1.0', () => fs.writeFileSync(path.join(fx.seed, path.dirname(HOOK), 'note.ts'), "export const note = 'new hook ran';\n"));
    runHook(fx);
    await waitFor(fx, /Z UPDATED from=1\.0\.0 to=1\.1\.0/);
    expect(fs.readFileSync(path.join(fx.install, 'VERSION'), 'utf8')).toBe('1.1.0\n');
    expect(runRegisteredHook(fx).stdout).toContain('new hook ran');
  });

  test('the hook check runs after the Bun floor check and before the fast-forward', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const bun = src.indexOf('HELD=$(gstack_bun_incoming_hold');
    const hooks = src.indexOf('HELD=$(hook_incoming_hold');
    const ff = src.indexOf('bash "$FF_UPDATE"');
    expect(bun).toBeGreaterThan(-1);
    expect(hooks).toBeGreaterThan(bun);
    expect(ff).toBeGreaterThan(hooks);
  });
});

// The incoming revision's own checker decides (#3088, #3100: an installed
// checker with a false positive held every later release). The installed one
// decides only when the incoming checker gives no verified, complete report.
describe.skipIf(process.platform === 'win32')('gstack-session-update: the incoming revision\'s checker decides', () => {
  const FALSE_POSITIVE = `if [ "$1" = --list ]; then echo ${HOOK}; exit 0; fi\necho "fail ${HOOK} $1/${HOOK}.ts:1: bun could not bundle the TypeScript entry"; exit 1`;
  const PASSES = `if [ "$1" = --list ]; then echo ${HOOK}; exit 0; fi\necho "ok ${HOOK}"; exit 0`;
  const CRASHES = `if [ "$1" = --list ]; then echo ${HOOK}; exit 0; fi\necho "ok ${HOOK}"; kill -SEGV $$`;

  /** The updater installed beside a stub bin/gstack-hook-check. */
  function installedUpdater(fx: Fx, checker: string): string {
    const bin = path.join(fx.base, 'installed-bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const f of ['gstack-session-update', 'gstack-state-root.sh', 'gstack-egress-lib.sh', 'gstack-egress-receipt', 'gstack-bun-version.sh', 'gstack-path-spelling.sh', 'gstack-ff-update', 'gstack-lock.sh']) {
      fs.copyFileSync(path.join(ROOT, 'bin', f), path.join(bin, f));
    }
    fs.writeFileSync(path.join(bin, 'gstack-hook-check'), `#!/usr/bin/env bash\n${checker}\n`, { mode: 0o755 });
    return path.join(bin, 'gstack-session-update');
  }

  /** Ship the real checker (or a stub) in the incoming revision. */
  function incomingChecker(fx: Fx, stub?: string) {
    if (stub === undefined) fs.copyFileSync(path.join(ROOT, 'bin', 'gstack-hook-check'), path.join(fx.seed, 'bin', 'gstack-hook-check'));
    else fs.writeFileSync(path.join(fx.seed, 'bin', 'gstack-hook-check'), `#!/usr/bin/env bash\n${stub}\n`, { mode: 0o755 });
  }

  async function expectHeld(fx: Fx, script: string, reason: RegExp) {
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    runHook(fx, script);
    const log = await waitFor(fx, /Z HELD /);
    expect(log).toMatch(reason);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(oldHead);
    expect(fs.readFileSync(path.join(fx.install, 'VERSION'), 'utf8')).toBe('1.0.0\n');
    expect(fs.existsSync(fx.calls)).toBe(false);
    expect(fs.readdirSync(fx.base).filter(f => f.startsWith('gstack-session-hooks-'))).toEqual([]);
    return log;
  }

  test('an installed checker that always fails no longer holds a release whose own checker passes', async () => {
    const fx = makeFixture();
    const script = installedUpdater(fx, FALSE_POSITIVE);
    release(fx, '1.1.0', () => {
      incomingChecker(fx);
      fs.writeFileSync(path.join(fx.seed, path.dirname(HOOK), 'note.ts'), "export const note = 'new hook ran';\n");
    });
    runHook(fx, script);
    const log = await waitFor(fx, /Z UPDATED from=1\.0\.0 to=1\.1\.0/);
    expect(log).not.toContain('HELD');
    expect(log).toContain(`HOOK_CHECK_DISAGREE incoming=pass installed=${HOOK}.ts:1: bun could not bundle the TypeScript entry`);
    expect(fs.readFileSync(path.join(fx.install, 'VERSION'), 'utf8')).toBe('1.1.0\n');
    expect(runRegisteredHook(fx).stdout).toContain('new hook ran');
  });

  test('an invalid incoming hook holds even when the installed checker would pass it', async () => {
    const fx = makeFixture();
    const script = installedUpdater(fx, PASSES);
    release(fx, '1.1.0', () => {
      incomingChecker(fx);
      fs.writeFileSync(path.join(fx.seed, path.dirname(HOOK), 'note.ts'), 'export const note = ;\n');
    });
    await expectHeld(fx, script, new RegExp(`HELD hook-does-not-parse: ${path.dirname(HOOK)}/note.ts:1: `));
    expect(runRegisteredHook(fx).stdout).toContain('old hook ran');
  });

  test('a crashing incoming checker falls back to the installed one, which holds', async () => {
    const fx = makeFixture();
    const script = installedUpdater(fx, FALSE_POSITIVE);
    release(fx, '1.1.0', () => incomingChecker(fx, CRASHES));
    const log = await expectHeld(fx, script, new RegExp(`HELD hook-does-not-parse: ${HOOK}.ts:1: bun could not bundle`));
    expect(log).toMatch(/HOOK_CHECK_FALLBACK incoming checker gave no verified report \(exited 139/);
  });

  test('an incoming checker with empty output falls back to the installed one, which holds', async () => {
    const fx = makeFixture();
    const script = installedUpdater(fx, FALSE_POSITIVE);
    release(fx, '1.1.0', () => incomingChecker(fx, 'exit 0'));
    const log = await expectHeld(fx, script, /HELD hook-does-not-parse: /);
    expect(log).toContain('HOOK_CHECK_FALLBACK incoming checker gave no verified report (empty hook list)');
  });

  // Git Bash: the checker may report the archive directory as /c/…/x or
  // C:/…/x while mktemp named it /tmp/x. A uname and cygpath shim stands in
  // for MSYS; the held reason never carries the archive path.
  test('the held reason drops the archive prefix in its native spelling', async () => {
    const fx = makeFixture();
    const shim = path.join(fx.base, 'msys-shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'uname'), '#!/usr/bin/env bash\necho MINGW64_NT-10.0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(shim, 'cygpath'), '#!/usr/bin/env bash\n[ "$1" = -am ] && { printf \'C:/msys64%s\\n\' "$2"; exit 0; }\nexit 1\n', { mode: 0o755 });
    const script = installedUpdater(fx, PASSES);
    release(fx, '1.1.0', () => incomingChecker(fx, `if [ "$1" = --list ]; then echo ${HOOK}; exit 0; fi\necho "fail ${HOOK} $(cygpath -am "$1")/${HOOK}.ts:3: Unexpected ;"; exit 1`));
    const oldHead = git(fx.install, 'rev-parse', 'HEAD');
    spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { PATH: `${shim}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: fx.home, GSTACK_DIR: fx.install, GSTACK_STATE_ROOT: fx.state, SETUP_CALLS: fx.calls, TMPDIR: fx.base },
      timeout: 20_000,
    });
    const log = await waitFor(fx, /Z HELD /);
    expect(log).toContain(`HELD hook-does-not-parse: ${HOOK}.ts:3: Unexpected ;`);
    expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(oldHead);
  });

  test('no verified report from either checker holds as hook-check-unavailable, with the recovery', async () => {
    const fx = makeFixture();
    const script = installedUpdater(fx, CRASHES);
    release(fx, '1.1.0', () => incomingChecker(fx, `if [ "$1" = --list ]; then echo ${HOOK}; exit 0; fi\necho "all good"; exit 0`));
    await expectHeld(fx, script, /HELD hook-check-unavailable: the installed bin\/gstack-hook-check gave no verified report either \(exited 139/);
    const next = runHook(fx, script).stdout;
    expect(next).toContain('gstack auto-update: update held (hook-check-unavailable: ');
    expect(next).toContain(`Fix now (in a terminal; Git Bash on Windows): cd '${fx.install}' && git fetch origin && bash bin/gstack-ff-update . '@{upstream}' && ./setup`);
    expect(next).toContain('https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#auto-update-hook-check-unavailable');
  });
});

// #3184: MSYS tar cannot create a symlink whose target it has not extracted
// yet (connect-chrome sorts before open-gstack-browser), so `git archive | tar`
// held every Windows release as hook-check-unavailable. The incoming revision
// is extracted through a private index with checkout-index instead, symlinks
// as plain files; tar is never run.
describe.skipIf(process.platform === 'win32')('gstack-session-update: extraction without tar or symlinks (#3184)', () => {
  /** A PATH whose tar fails like MSYS tar on any symlink member. */
  function msysTar(fx: Fx): string {
    const dir = path.join(fx.base, 'msys-tar');
    fs.mkdirSync(dir, { recursive: true });
    const real = execFileSync('bash', ['-c', 'command -v tar'], { encoding: 'utf8', timeout: 30_000 }).trim();
    fs.writeFileSync(path.join(dir, 'tar'), [
      '#!/usr/bin/env bash',
      `buf=$(mktemp "${fx.base}/tarbuf-XXXXXX"); cat > "$buf"`,
      `if "${real}" -tvf "$buf" 2>/dev/null | grep -q '^l'; then`,
      `  link=$("${real}" -tvf "$buf" | awk '/^l/ { print $6; exit }')`,
      '  echo "tar: $link: Cannot create symlink: No such file or directory" >&2; echo "tar: Exiting with failure status due to previous errors" >&2; rm -f "$buf"; exit 2',
      'fi',
      `"${real}" "$@" < "$buf"; rc=$?; rm -f "$buf"; exit $rc`,
    ].join('\n') + '\n', { mode: 0o755 });
    return dir;
  }
  function runWith(fx: Fx, extraPath: string, script = SCRIPT) {
    return spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { PATH: `${extraPath}:${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: fx.home, GSTACK_DIR: fx.install, GSTACK_STATE_ROOT: fx.state, SETUP_CALLS: fx.calls, TMPDIR: fx.base },
      timeout: 20_000,
    });
  }
  /** A release whose tree has a symlink sorted before its target, like connect-chrome. */
  const withLink = (fx: Fx, extra: () => void = () => {}) => release(fx, '1.1.0', () => {
    fs.mkdirSync(path.join(fx.seed, 'zz-target'), { recursive: true });
    fs.writeFileSync(path.join(fx.seed, 'zz-target', 'SKILL.md'), 'name: zz\n');
    fs.symlinkSync('zz-target', path.join(fx.seed, 'aa-link'));
    extra();
  });

  test('a release with a symlink before its target fast-forwards under MSYS tar; the real index is untouched by the check', async () => {
    const fx = makeFixture();
    withLink(fx, () => fs.writeFileSync(path.join(fx.seed, path.dirname(HOOK), 'note.ts'), "export const note = 'new hook ran';\n"));
    runWith(fx, msysTar(fx));
    const log = await waitFor(fx, /Z (UPDATED|HELD)/);
    expect(log).not.toContain('HELD');
    expect(log).toContain('UPDATED from=1.0.0 to=1.1.0');
    expect(fs.readlinkSync(path.join(fx.install, 'aa-link'))).toBe('zz-target');
    expect(runRegisteredHook(fx).stdout).toContain('new hook ran');
  });

  test('the incoming bytes are what is checked: a valid installed hook against an invalid incoming one holds, and the index stays byte-identical', async () => {
    const fx = makeFixture();
    withLink(fx, () => fs.writeFileSync(path.join(fx.seed, path.dirname(HOOK), 'note.ts'), 'export const note = ;\n'));
    const indexBefore = fs.readFileSync(path.join(fx.install, '.git', 'index'));
    runWith(fx, msysTar(fx));
    const log = await waitFor(fx, /Z HELD /);
    expect(log).toContain(`HELD hook-does-not-parse: ${path.dirname(HOOK)}/note.ts:1:`);
    expect(fs.readFileSync(path.join(fx.install, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(runRegisteredHook(fx).stdout).toContain('old hook ran');
    expect(fs.readdirSync(fx.base).filter((f) => f.startsWith('gstack-session-hooks-'))).toEqual([]);
  });

  test('an extraction failure holds with its own stderr, flattened and stripped of control characters', async () => {
    const fx = makeFixture();
    release(fx, '1.1.0', () => fs.writeFileSync(path.join(fx.seed, 'extra.txt'), 'x\n'));
    const dir = path.join(fx.base, 'bad-read-tree');
    fs.mkdirSync(dir);
    const real = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8', timeout: 30_000 }).trim(), 'git');
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/bash\ncase " $* " in *" read-tree "*) [ -n "$GIT_INDEX_FILE" ] && { printf 'fatal: broken\\nstages=x \\033[31mred\\033[0m\\n' >&2; exit 128; } ;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
    runWith(fx, dir);
    const log = await waitFor(fx, /Z HELD /);
    expect(log).toContain('HELD hook-check-unavailable: cannot extract the incoming revision: fatal: broken stages=x red incoming=');
    const pending = fs.readFileSync(path.join(fx.state, 'session-update-pending'), 'utf8');
    expect(pending).not.toMatch(/^stages=x/m);
    expect(pending).not.toContain('\x1b');
    expect(pending).toMatch(/^stages=$/m);
  });

  test('tripwire: no hooked path or module a hook imports or sources is a symlink', () => {
    const links = new Set(execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
      .split('\n').filter((l) => l.startsWith('120000 ')).map((l) => l.split('\t')[1]));
    const hooks = execFileSync('bash', [path.join(ROOT, 'bin', 'gstack-hook-check'), '--list', ROOT], { encoding: 'utf8', timeout: 30_000 }).split('\n').filter(Boolean);
    expect(hooks.length).toBeGreaterThan(3);
    const seen = new Set<string>();
    const queue = [...hooks, ...hooks.map((h) => `${h}.ts`)].filter((f) => fs.existsSync(path.join(ROOT, f)));
    while (queue.length) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const deps = [
        ...[...src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]!),
        ...[...src.matchAll(/^\s*\. "\$\(cd "\$\(dirname "\$0"\)" && pwd\)\/([^"]+)"/gm)].map((m) => `./${m[1]}`),
      ];
      for (const d of deps) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), d));
        const hit = [base, `${base}.ts`, `${base}/index.ts`].find((c) => fs.existsSync(path.join(ROOT, c)) && fs.statSync(path.join(ROOT, c)).isFile());
        if (hit) queue.push(hit);
      }
    }
    expect(seen.size).toBeGreaterThan(hooks.length);
    expect([...seen].filter((f) => links.has(f))).toEqual([]);
    expect(links.has('connect-chrome')).toBe(true);
  });
});

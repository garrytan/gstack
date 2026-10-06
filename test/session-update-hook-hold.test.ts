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

function runHook(fx: Fx) {
  return spawnSync('bash', [SCRIPT], {
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
    const ff = src.indexOf('merge --ff-only');
    expect(bun).toBeGreaterThan(-1);
    expect(hooks).toBeGreaterThan(bun);
    expect(ff).toBeGreaterThan(hooks);
  });
});

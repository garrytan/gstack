import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseGuiReadiness, runGuiReadiness, validateGuiReadinessAuthority } from '../../.github/scripts/qualify-dia-macos';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'dia-gui-readiness-test-')));
const source = path.resolve(import.meta.dir, '../../.github/scripts/dia-gui-readiness.c');
const executable = path.join(root, 'metadata-probe');
const names = ['chrome', 'chromium', 'arc', 'dia', 'comet', 'brave', 'edge', 'safari', 'cookies'];
const observation = () => ({ protocol: 1, supported: true, identity: { effectiveUidMatches: true, homeMatchesRegistered: true },
  security: { status: 0, graphicAccess: true, rootSession: false, tty: false, remote: false },
  quartz: { present: true, sameUid: true, loginDone: true, onConsole: true }, browserRoots: null as any });

beforeAll(() => {
  const wrapper = path.join(root, 'metadata-probe.c');
  writeFileSync(wrapper, `#define main native_readiness_main\n#include ${JSON.stringify(source)}\n#undef main
    int main(int argc, char **argv) {
      if (argc != 2) return 2;
      int home = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
      if (home < 0) return 2;
      print_browser_roots(home, getuid()); close(home); printf("\\n"); return 0;
    }`);
  const compiler = Bun.which('clang');
  if (!compiler) throw new Error('clang is required for the POSIX metadata regression');
  const compiled = spawnSync(compiler, ['-std=c11', '-O2', '-Wall', '-Wextra', wrapper,
    ...(process.platform === 'darwin' ? ['-framework', 'Security', '-framework', 'ApplicationServices'] : []), '-o', executable],
  { encoding: 'utf8', timeout: 30_000 });
  if (compiled.status !== 0) throw new Error('metadata_fixture_compile_failed');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const inspect = (home: string) => {
  const result = spawnSync(executable, [home], { encoding: 'utf8', timeout: 5000 });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
};

describe('read-only GUI readiness', () => {
  test('metadata inspection reports missing fixed roots without creating state', () => {
    const home = realpathSync(mkdtempSync(path.join(root, 'empty-')));
    const before = readdirSync(home);
    const result = inspect(home);
    expect(Object.keys(result)).toEqual(names);
    for (const name of names) expect(result[name]).toEqual({ state: 'absent', kind: null, ownerMatches: null, ancestorBlocked: false });
    expect(readdirSync(home)).toEqual(before);
    expect(lstatSync(home).mode & 0o777).toBe(0o700);
  });

  test('metadata inspection never follows ancestor or target symlinks', () => {
    const outside = realpathSync(mkdtempSync(path.join(root, 'other-')));
    writeFileSync(path.join(outside, 'private-sentinel'), 'unchanged fixture contents');
    const linked = realpathSync(mkdtempSync(path.join(root, 'linked-')));
    symlinkSync(outside, path.join(linked, 'Library'), 'dir');
    const blocked = inspect(linked);
    for (const name of names) expect(blocked[name]).toEqual({ state: 'unavailable', kind: 'symlink', ownerMatches: true, ancestorBlocked: true });
    const home = realpathSync(mkdtempSync(path.join(root, 'target-')));
    mkdirSync(path.join(home, 'Library'));
    symlinkSync(outside, path.join(home, 'Library/Safari'), 'dir');
    expect(inspect(home).safari).toEqual({ state: 'present', kind: 'symlink', ownerMatches: true, ancestorBlocked: false });
    expect(readdirSync(outside)).toEqual(['private-sentinel']);
    expect(readFileSync(path.join(outside, 'private-sentinel'), 'utf8')).toBe('unchanged fixture contents');
  });

  test('wrong ancestor types and access failures are unavailable, never absent', () => {
    const home = realpathSync(mkdtempSync(path.join(root, 'wrong-type-')));
    writeFileSync(path.join(home, 'Library'), 'not a directory');
    expect(inspect(home).dia).toEqual({ state: 'unavailable', kind: 'file', ownerMatches: true, ancestorBlocked: true });
    const denied = realpathSync(mkdtempSync(path.join(root, 'denied-')));
    const library = path.join(denied, 'Library');
    mkdirSync(library, { mode: 0o700 });
    chmodSync(library, 0);
    try {
      expect(inspect(denied).dia).toEqual({ state: 'unavailable', kind: 'directory', ownerMatches: true, ancestorBlocked: true });
      expect(lstatSync(library).mode & 0o777).toBe(0);
    } finally { chmodSync(library, 0o700); }
  });

  test('present root metadata does not open contents or change them', () => {
    const home = realpathSync(mkdtempSync(path.join(root, 'present-')));
    const safari = path.join(home, 'Library/Safari');
    mkdirSync(safari, { recursive: true });
    const file = path.join(safari, 'private-sentinel');
    writeFileSync(file, 'private fixture content');
    chmodSync(file, 0);
    const before = lstatSync(file);
    const result = inspect(home);
    expect(result.safari).toEqual({ state: 'present', kind: 'directory', ownerMatches: true, ancestorBlocked: false });
    expect(lstatSync(file).mode).toBe(before.mode);
    expect(lstatSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(JSON.stringify(result)).not.toContain('private');
    chmodSync(file, 0o600);
    expect(readFileSync(file, 'utf8')).toBe('private fixture content');
  });

  test('GUI usability requires both the security capability and the caller-owned logged-in Quartz session', () => {
    const original = observation();
    const before = JSON.stringify(original);
    Object.freeze(original.identity); Object.freeze(original.security); Object.freeze(original.quartz); Object.freeze(original);
    expect(parseGuiReadiness(original, false).usableGui).toBe(true);
    expect(JSON.stringify(original)).toBe(before);
    for (const changed of [
      { ...observation(), security: { ...observation().security, graphicAccess: false } },
      { ...observation(), quartz: { present: false, sameUid: null, loginDone: null, onConsole: null } },
      { ...observation(), quartz: { present: true, sameUid: false, loginDone: null, onConsole: null } },
      { ...observation(), quartz: { ...observation().quartz, loginDone: false } },
      { ...observation(), identity: { effectiveUidMatches: true, homeMatchesRegistered: false } },
      { ...observation(), security: { status: -60500, graphicAccess: null, rootSession: null, tty: null, remote: null } },
    ]) expect(parseGuiReadiness(changed, false).usableGui).toBe(false);
  });

  test('schema rejects extra identity text, cross-UID session details and false absence claims', () => {
    for (const changed of [
      { ...observation(), username: 'private-name' },
      { ...observation(), quartz: { ...observation().quartz, uid: 501 } },
      { ...observation(), quartz: { present: true, sameUid: false, loginDone: true, onConsole: true } },
      { ...observation(), security: { ...observation().security, status: -1 } },
      { ...observation(), security: { ...observation().security, graphicAccess: 1 } },
    ]) expect(() => parseGuiReadiness(changed, false)).toThrow('invalid_gui_readiness_receipt');
    const roots = Object.fromEntries(names.map(name => [name, { state: 'absent', kind: null, ownerMatches: null, ancestorBlocked: false }]));
    expect(parseGuiReadiness({ ...observation(), browserRoots: roots }, true).browserRoots).toEqual(roots);
    expect(() => parseGuiReadiness({ ...observation(), browserRoots: roots }, false)).toThrow('invalid_gui_readiness_receipt');
    expect(() => parseGuiReadiness({ ...observation(), browserRoots: { ...roots, dia: { state: 'absent', kind: 'symlink', ownerMatches: true, ancestorBlocked: true } } }, true))
      .toThrow('invalid_gui_readiness_receipt');
  });

  test('GUI authority cannot carry browser/comparison authority or placeholder destination hashes', () => {
    const account: any = { work: '/private/tmp/dn-fixture', guiReadiness: { mode: 'gui-readiness-only', executable: '/private/tmp/dn-fixture/bin/gui-readiness',
      executableSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64) } };
    expect(() => validateGuiReadinessAuthority(account, 'coordinator')).not.toThrow();
    for (const changed of [{ ...account, launchComparison: {} }, { ...account, destinationExecutable: '' }, { ...account, destinationSha256: 'a'.repeat(64) },
      { ...account, guiReadiness: null }, { ...account, guiReadiness: { ...account.guiReadiness, executableSha256: ['a'.repeat(64)] } },
      { ...account, guiReadiness: { ...account.guiReadiness, executable: '/unowned/probe' } }]) {
      expect(() => validateGuiReadinessAuthority(changed, 'coordinator')).toThrow('gui_readiness_authority_invalid');
    }
    expect(() => validateGuiReadinessAuthority(account, 'comparison-driver')).toThrow('gui_readiness_authority_invalid');
  });

  test('the registered probe validates hashes, bounds execution, and discards unrecognized output', async () => {
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const exeHash = hash(executable);
    const sourceHash = hash(source);
    const input = observation();
    const execute = ((command: string, args: string[], options: any) => {
      expect(command).toBe(executable); expect(args).toEqual([]);
      expect(options.timeout).toBeGreaterThan(0); expect(options.timeout).toBeLessThanOrEqual(5000);
      expect(options.killSignal).toBe('SIGKILL'); expect(options.maxBuffer).toBe(16 * 1024);
      return { status: 0, stdout: JSON.stringify(input), stderr: 'private diagnostic text' };
    }) as typeof spawnSync;
    const result = await runGuiReadiness(executable, exeHash, source, sourceHash, false, { HOME: root }, 5000, execute);
    expect(result.available).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    await expect(runGuiReadiness(executable, 'c'.repeat(64), source, sourceHash, false, {}, 5000, execute)).rejects.toThrow('gui_readiness_inputs_changed');
    const malformed = (() => ({ status: 0, stdout: JSON.stringify({ ...input, username: 'private-name' }), stderr: '' })) as typeof spawnSync;
    expect((await runGuiReadiness(executable, exeHash, source, sourceHash, false, {}, 5000, malformed)).available).toBe(false);
    for (const timeout of [0, NaN, Infinity]) await expect(runGuiReadiness(executable, exeHash, source, sourceHash, false, {}, timeout, execute)).rejects.toThrow('gui_readiness_budget_exhausted');
  });

  test('the readiness launcher loads without node_modules or Playwright and rejects conflicting CLI modes', () => {
    const directory = path.join(root, 'no-dependencies/.github/scripts');
    mkdirSync(directory, { recursive: true });
    for (const file of ['run-dia-native-qualification.ts', 'qualify-dia-macos.ts']) copyFileSync(path.resolve(import.meta.dir, '../../.github/scripts', file), path.join(directory, file));
    for (const args of [['--gui-readiness-only'], ['--gui-readiness-only', '--launch-comparison', 'node']]) {
      const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', '--no-macros', '--config=/dev/null', path.join(directory, 'run-dia-native-qualification.ts'), ...args],
        { cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 });
      expect(result.status).toBe(2); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).reason).toBe('fresh_account_launcher_preflight_failed');
    }
  });
});

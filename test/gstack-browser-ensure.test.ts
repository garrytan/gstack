/**
 * bin/gstack-browser-ensure: the lazy Chromium install the browse preflight
 * runs on first use. Pinned on the wire lines (BROWSER_OK / BROWSER_UNAVAILABLE),
 * exit codes, the no-install `--check` mode, the install-then-reprobe path
 * under setup's lock, and the preflight wiring in scripts/resolvers/browse.ts.
 * Chromium itself is a stub `node_modules/playwright` whose launch succeeds
 * only once a marker the stubbed `bunx playwright install` writes exists.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateBrowseFallback, generateBrowseSetup } from '../scripts/resolvers/browse';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ctxFor = (host: 'claude' | 'codex', skillName: string) => ({ skillName, tmplPath: '', host, paths: HOST_PATHS[host] });

const REPO = path.resolve(import.meta.dir, '..');
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};

function fixture(opts: { playwright?: boolean } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-ensure-')));
  bases.push(base);
  const root = path.join(base, 'gstack');
  const stub = path.join(base, 'stub');
  const marker = path.join(base, 'chromium-installed');
  fs.mkdirSync(stub, { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'bin/gstack-browser-ensure'), path.join(root, 'bin/gstack-browser-ensure'));
  fs.chmodSync(path.join(root, 'bin/gstack-browser-ensure'), 0o755);
  if (opts.playwright !== false) {
    write(path.join(root, 'node_modules/playwright/index.js'), [
      'const fs = require("fs");',
      `const marker = ${JSON.stringify(marker)};`,
      'module.exports.chromium = { launch: async () => {',
      '  if (!fs.existsSync(marker)) throw new Error("browserType.launch: Executable doesn\'t exist at /nowhere/chrome");',
      '  return { version: () => "141.0.7390.37", close: async () => {}, newPage: async () => ({ setContent: async () => {}, title: async () => "gstack smoke test" }) };',
      '} };',
    ].join('\n'));
  }
  // `bunx playwright install chromium` "installs" by writing the marker and logging its argv.
  write(path.join(stub, 'bunx'), `#!/usr/bin/env bash\necho "$*" >> "${base}/bunx-calls"\ncase "$*" in *"playwright install"*) touch "${marker}" ;; *) exit 9 ;; esac\n`, 0o755);
  write(path.join(stub, 'bun'), '#!/usr/bin/env bash\n[ "$1" = --version ] && { echo 1.4.2; exit 0; }\nexit 0\n', 0o755);
  const env: Record<string, string> = { PATH: `${stub}${path.delimiter}${process.env.PATH ?? ''}`, HOME: base, TMPDIR: base, GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '20' };
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [path.join(root, 'bin/gstack-browser-ensure'), ...args], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 60_000 });
  return { base, root, marker, run, calls: () => fs.existsSync(path.join(base, 'bunx-calls')) ? fs.readFileSync(path.join(base, 'bunx-calls'), 'utf8') : '' };
}

const lastLine = (s: string) => s.trim().split('\n').at(-1);

describe('gstack-browser-ensure', () => {
  test('--check never installs: unavailable Chromium is BROWSER_UNAVAILABLE, exit 1, with the fix line and code', () => {
    const f = fixture();
    const r = f.run(['--check']);
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toMatch(/^BROWSER_UNAVAILABLE Chromium did not launch via node \(browserType\.launch: Executable doesn't exist/);
    expect(r.stderr).toContain('(BROWSER_UNAVAILABLE; https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#browser-ensure-failed)');
    expect(r.stderr).toContain(`fix: ${f.root}/bin/gstack-browser-ensure`);
    expect(f.calls()).toBe('');
    expect(fs.existsSync(f.marker)).toBe(false);
  });

  test('a missing node_modules is reported, not installed, under --check', () => {
    const f = fixture({ playwright: false });
    const r = f.run(['--check']);
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toBe(`BROWSER_UNAVAILABLE playwright is not installed under ${f.root}/node_modules`);
    expect(r.stderr).toContain(`fix: cd ${f.root} && ./setup`);
  });

  test('first use installs Chromium under setup\'s lock, re-probes and prints BROWSER_OK; the second run is a probe only', () => {
    const f = fixture();
    const first = f.run();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(lastLine(first.stdout)).toBe('BROWSER_OK node 141.0.7390.37');
    expect(f.calls().trim()).toBe('playwright install chromium');
    expect(first.stderr).toContain('installing Playwright Chromium');
    expect(fs.existsSync(path.join(f.base, 'gstack-playwright-install.lock'))).toBe(false);
    const second = f.run(['--quiet']);
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe('BROWSER_OK node 141.0.7390.37');
    expect(second.stderr).toBe('');
    expect(f.calls().trim()).toBe('playwright install chromium');
  });

  test('--with-deps reaches the installer; a held lock by a live process is waited on, a dead holder is reclaimed', () => {
    const f = fixture();
    const lock = path.join(f.base, 'gstack-playwright-install.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), '999999999\n');
    const r = f.run(['--with-deps']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(f.calls().trim()).toBe('playwright install --with-deps chromium');
    expect(fs.existsSync(lock)).toBe(false);
  });

  test('an installer failure is BROWSER_UNAVAILABLE with the exit code; usage errors exit 2; --help exits 0', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.base, 'stub/bunx'), '#!/usr/bin/env bash\nexit 7\n');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toBe('BROWSER_UNAVAILABLE bunx playwright install chromium exited 7 (offline, proxy, or blocked download?)');
    expect(f.run(['--bogus']).status).toBe(2);
    const help = f.run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--check');
  });
});

describe('browse preflight wiring (scripts/resolvers/browse.ts)', () => {
  test('every browser skill\'s $B detection runs gstack-browser-ensure from the install root before READY', () => {
    for (const host of ['claude', 'codex'] as const) {
      const fallback = generateBrowseFallback(ctxFor(host, 'browse'));
      expect(fallback).toContain('[ -x "$B" ] && "${B%/browse/*}/bin/gstack-browser-ensure" && echo "READY: $B" || echo "NEEDS_SETUP"');
      const setup = generateBrowseSetup(ctxFor(host, 'pair-agent'));
      expect(setup).toContain('if [ -x "$B" ] && "${B%/browse/*}/bin/gstack-browser-ensure"; then');
      expect(setup).toContain('BROWSER_UNAVAILABLE <reason>');
    }
  });

  test('the suffix strip resolves the install root for every $B shape', () => {
    const r = spawnSync('bash', ['-c', 'for B in /home/u/.claude/skills/gstack/browse/dist/browse /r/.agents/skills/gstack/browse/dist/browse.exe /home/browse/.claude/skills/gstack/browse/dist/browse; do echo "${B%/browse/*}"; done'], { encoding: 'utf8', timeout: 10_000 });
    expect(r.stdout.trim().split('\n')).toEqual(['/home/u/.claude/skills/gstack', '/r/.agents/skills/gstack', '/home/browse/.claude/skills/gstack']);
  });
});

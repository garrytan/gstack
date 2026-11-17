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
  // A winget-shaped Bun (#3131): `bun` and no `bunx` anywhere on PATH. `bun x playwright install chromium`
  // "installs" by writing the marker and logging its argv.
  write(path.join(stub, 'bun'), `#!/usr/bin/env bash\n[ "$1" = --version ] && { echo 1.4.2; exit 0; }\n[ "$1" = x ] || exit 0\nshift\necho "$*" >> "${base}/bunx-calls"\ncase "$*" in *"playwright install"*) touch "${marker}" ;; *) exit 9 ;; esac\n`, 0o755);
  const rest = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'bunx')));
  const env: Record<string, string> = { PATH: [stub, ...rest].join(path.delimiter), HOME: base, TMPDIR: base, GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT: '20' };
  const run = (args: string[] = [], extra: Record<string, string> = {}) =>
    spawnSync('bash', [path.join(root, 'bin/gstack-browser-ensure'), ...args], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 60_000 });
  return { base, root, marker, run, calls: () => fs.existsSync(path.join(base, 'bunx-calls')) ? fs.readFileSync(path.join(base, 'bunx-calls'), 'utf8') : '' };
}

const lastLine = (s: string) => s.trim().split('\n').at(-1);

// Value: protects=a runtime root with no package.json (~/.codex/skills/gstack and
//   the other host roots) probes the dependencies of the gstack checkout its
//   .source-path names, and only of a real gstack checkout; fails_when=the
//   helper ignores the pointer, or follows an empty, stale, relative, linked or
//   non-gstack one, or lets a pointer override a root's own package.json, or
//   --check writes anything; why_new=no fixture had a .source-path;
//   seam=none; no_claim=a real Chromium launch (Playwright is a stub).
describe('gstack-browser-ensure in a runtime root without package.json', () => {
  const playwrightStub = (version: string) =>
    `module.exports.chromium = { launch: async () => ({ version: () => ${JSON.stringify(version)}, close: async () => {}, newPage: async () => ({ setContent: async () => {}, title: async () => "gstack smoke test" }) }) };\n`;
  function runtime(checkoutName = 'checkout') {
    const f = fixture({ playwright: false });
    const checkout = path.join(f.base, checkoutName);
    write(path.join(checkout, 'package.json'), '{\n  "name": "gstack",\n  "version": "0.0.0"\n}\n');
    write(path.join(checkout, 'bin/gstack-browser-ensure'), '#!/usr/bin/env bash\n', 0o755);
    write(path.join(checkout, 'node_modules/playwright/index.js'), playwrightStub('141.1.0'));
    const point = (text: string) => write(path.join(f.root, '.source-path'), text);
    const tree = () => walkFiles(f.base).filter(p => !p.startsWith(path.join(f.base, 'stub'))).sort();
    return { ...f, checkout, point, tree };
  }
  const walkFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const unavailable = (root: string) => `BROWSER_UNAVAILABLE playwright is not installed under ${root}/node_modules`;

  for (const [label, name, eol] of [
    ['the recorded checkout', 'checkout', '\n'],
    ['a checkout path with spaces', 'gstack checkout', '\n'],
    ['a CRLF pointer', 'checkout', '\r\n'],
  ] as const) {
    test(`--check probes ${label} and writes nothing`, () => {
      const f = runtime(name);
      f.point(f.checkout + eol);
      const files = f.tree();
      const r = f.run(['--check']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(lastLine(r.stdout)).toBe('BROWSER_OK node 141.1.0');
      expect(f.tree()).toEqual(files);
      expect(f.calls()).toBe('');
    });
  }

  test('without --check a valid pointer is a probe only, and a link to the checkout resolves to it', () => {
    const f = runtime();
    const link = path.join(f.base, 'checkout-link');
    fs.symlinkSync(f.checkout, link);
    f.point(link + '\n');
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe('BROWSER_OK node 141.1.0');
    expect(fs.existsSync(path.join(f.root, 'node_modules'))).toBe(false);
    expect(f.calls()).toBe('');
  });

  const refused: Array<[string, (f: ReturnType<typeof runtime>) => void]> = [
    ['an empty pointer', f => f.point('\n')],
    ['a stale pointer', f => f.point(path.join(f.base, 'gone') + '\n')],
    ['a relative pointer', f => f.point(path.relative(process.cwd(), f.checkout) + '\n')],
    ['a pointer file that is a link', f => { write(path.join(f.base, 'elsewhere'), f.checkout + '\n'); fs.symlinkSync(path.join(f.base, 'elsewhere'), path.join(f.root, '.source-path')); }],
    ['a directory whose package.json is not gstack\'s', f => { write(path.join(f.checkout, 'package.json'), '{\n  "name": "left-pad"\n}\n'); f.point(f.checkout + '\n'); }],
    ['a directory whose package.json is a link', f => {
      write(path.join(f.base, 'real-package.json'), fs.readFileSync(path.join(f.checkout, 'package.json'), 'utf8'));
      fs.rmSync(path.join(f.checkout, 'package.json'));
      fs.symlinkSync(path.join(f.base, 'real-package.json'), path.join(f.checkout, 'package.json'));
      f.point(f.checkout + '\n');
    }],
    ['a directory without gstack-browser-ensure', f => { fs.rmSync(path.join(f.checkout, 'bin'), { recursive: true }); f.point(f.checkout + '\n'); }],
  ];
  for (const [label, setUp] of refused) {
    test(`--check ignores ${label} and reports the runtime root, as before`, () => {
      const f = runtime();
      setUp(f);
      const files = f.tree();
      const r = f.run(['--check']);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(lastLine(r.stdout)).toBe(unavailable(f.root));
      expect(f.tree()).toEqual(files);
      expect(f.calls()).toBe('');
    });
  }

  test('a root with its own package.json keeps its own dependencies over a valid pointer', () => {
    const f = runtime();
    write(path.join(f.root, 'package.json'), '{\n  "name": "gstack"\n}\n');
    write(path.join(f.root, 'node_modules/playwright/index.js'), playwrightStub('142.2.0'));
    f.point(f.checkout + '\n');
    const r = f.run(['--check']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe('BROWSER_OK node 142.2.0');
  });
});

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
    fs.writeFileSync(path.join(f.base, 'stub/bun'), '#!/usr/bin/env bash\nexit 7\n');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toBe(`BROWSER_UNAVAILABLE ${path.join(f.base, 'stub/bun')} x playwright install chromium exited 7 (offline, proxy, or blocked download?)`);
    expect(f.run(['--bogus']).status).toBe(2);
    const help = f.run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--check');
  });
});

describe('gstack-browser-ensure with a winget-shaped Bun (#3131)', () => {
  test('the install runs as `bun x` when no bunx exists, then re-probes to BROWSER_OK', () => {
    const f = fixture();
    const r = f.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lastLine(r.stdout)).toBe('BROWSER_OK node 141.0.7390.37');
    expect(f.calls().trim()).toBe('playwright install chromium');
  });

  test('exit 127 names the resolved bun and Bun from bun.sh, not the network', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.base, 'stub/bun'), '#!/usr/bin/env bash\nexit 127\n');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(lastLine(r.stdout)).toBe(`BROWSER_UNAVAILABLE ${path.join(f.base, 'stub/bun')} x playwright install chromium exited 127 (command not found)`);
    expect(r.stderr).toContain('fix: install Bun from bun.sh (winget Bun ships no bunx), then re-run');
    expect(r.stderr).not.toContain('Playwright CDN');
  });
});

// Generated by /ship Step 7 coverage audit (GSTA-97).
// Value: protects=a missing node_modules is installed production-only, a stale lockfile is refreshed before the retry, and a failed install ends in BROWSER_UNAVAILABLE;
//   fails_when=--production leaves either install, the lockfile refresh is lost, or a failed install no longer reports the fix line;
//   why_new=setup-production-deps.test.ts matches the line's text only, and the --check case never installs;
//   seam=none; no_claim=a real bun install (a stub bun records argv, models Bun's frozen --production rule and restores a stub playwright)
describe('gstack-browser-ensure installs a missing node_modules production-only (GSTA-97)', () => {
  function installing(frozenRc: number, fallbackRc: number) {
    const f = fixture();
    fs.writeFileSync(f.marker, '');
    fs.renameSync(path.join(f.root, 'node_modules/playwright'), path.join(f.base, 'playwright-stub'));
    fs.writeFileSync(path.join(f.base, 'stub/bun'), [
      '#!/usr/bin/env bash',
      '[ "$1" = install ] || exit 9',
      `echo "$*" >> ${JSON.stringify(path.join(f.base, 'install-calls'))}`,
      `refreshed=${JSON.stringify(path.join(f.base, 'lockfile-refreshed'))}`,
      `case "$*" in\n  *--lockfile-only*) rc=${fallbackRc}; [ "$rc" -eq 0 ] && : > "$refreshed"; exit "$rc" ;;\n  *--frozen-lockfile*) rc=${frozenRc}; [ -f "$refreshed" ] && rc=0 ;;\n  *) exit 9 ;;\nesac`,
      `[ "$rc" -eq 0 ] && mkdir -p node_modules && cp -R ${JSON.stringify(path.join(f.base, 'playwright-stub'))} node_modules/playwright`,
      'exit "$rc"',
    ].join('\n') + '\n', { mode: 0o755 });
    const r = f.run();
    const calls = fs.existsSync(path.join(f.base, 'install-calls')) ? fs.readFileSync(path.join(f.base, 'install-calls'), 'utf8').trim().split('\n') : [];
    return { f, r, calls };
  }

  test('the frozen production install, then BROWSER_OK', () => {
    const { r, calls } = installing(0, 0);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(calls).toEqual(['install --production --frozen-lockfile']);
    expect(lastLine(r.stdout)).toBe('BROWSER_OK node 141.0.7390.37');
  });

  test('a stale lockfile is refreshed, then installed production-only again', () => {
    const { r, calls } = installing(1, 0);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(calls).toEqual(['install --production --frozen-lockfile', 'install --lockfile-only', 'install --production --frozen-lockfile']);
    expect(lastLine(r.stdout)).toBe('BROWSER_OK node 141.0.7390.37');
  });

  test('a failed install is BROWSER_UNAVAILABLE with the fix line', () => {
    const { f, r, calls } = installing(1, 1);
    expect(r.status).toBe(1);
    expect(calls).toEqual(['install --production --frozen-lockfile', 'install --lockfile-only']);
    expect(lastLine(r.stdout)).toBe(`BROWSER_UNAVAILABLE bun install failed under ${f.root}`);
    expect(r.stderr).toContain(`fix: cd ${f.root} && bun install --production --frozen-lockfile, then re-run`);
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

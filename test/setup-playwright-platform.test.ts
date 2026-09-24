import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runBashScript } from './helpers/bash-script';

const ROOT = resolve(import.meta.dir, '..');
const source = readFileSync(join(ROOT, 'setup'), 'utf8');
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), 'gstack-pw-platform-')); owned.push(dir); return dir; }
function slice(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('setup anchors missing');
  return source.slice(a, b);
}
function fn(name: string) { return slice(`${name}() {`, '\n}\n') + '\n}'; }

function platform(id: string, version: string, cpu: string, wholeBlock = false) {
  const dir = temp();
  const osRelease = join(dir, 'os-release');
  writeFileSync(osRelease, `ID=${id}\nVERSION_ID="${version}"\n`);
  const selector = slice("# 2. Ensure Playwright's Chromium is available", wholeBlock ? '# 2b. Ensure a color-emoji font' : '# Chromium is BEST-EFFORT')
    .replaceAll('/etc/os-release', osRelease);
  return runBashScript([
    'set -e', `uname() { echo ${JSON.stringify(cpu)}; }`,
    `SOURCE_GSTACK_DIR=${JSON.stringify(dir)}`, `TMPDIR=${JSON.stringify(dir)}`, 'IS_WINDOWS=0',
    'ensure_playwright_browser() { echo PROBED; return 0; }',
    'bunx() { echo INSTALL_ATTEMPTED; return 0; }',
    selector,
    'printf "OVERRIDE=%s\\nUNSUPPORTED=%s\\nREASON=%s\\n" "$_PLAYWRIGHT_PLATFORM_OVERRIDE" "${_PLAYWRIGHT_UNSUPPORTED_ARCH:-}" "${_PW_FAIL_REASON:-}"',
  ].join('\n'), { env: { PATH: process.env.PATH, HOME: dir }, timeout: 10_000 });
}

describe('Ubuntu fallback retains CPU architecture', () => {
  for (const [cpu, expected] of [['x86_64', 'x64'], ['aarch64', 'arm64'], ['arm64', 'arm64']]) {
    test(`${cpu} selects the matching real Playwright artifact`, () => {
      const result = platform('ubuntu', '26.04', cpu!);
      expect(result.status, result.stderr).toBe(0);
      const override = result.stdout.match(/^OVERRIDE=(.*)$/m)![1]!;
      expect(override).toBe(`ubuntu24.04-${expected}`);
      const dryRun = spawnSync(process.execPath, [join(ROOT, 'node_modules/playwright/cli.js'), 'install', '--dry-run', 'chromium'], {
        cwd: ROOT, env: { PATH: process.env.PATH, HOME: temp(), PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: override }, encoding: 'utf8', timeout: 20_000,
      });
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(dryRun.stdout).toContain(expected === 'arm64' ? 'chromium-linux-arm64.zip' : 'chrome-linux64.zip');
      expect(dryRun.stdout).not.toContain(expected === 'arm64' ? 'chrome-linux64.zip' : 'chromium-linux-arm64.zip');
    }, 30_000);
  }
  for (const cpu of ['riscv64', 'i686', 'unknown']) test(`${cpu} reports unsupported instead of installing x64`, () => {
    const result = platform('ubuntu', '26.04', cpu, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('OVERRIDE=\n');
    expect(result.stdout).toContain(`UNSUPPORTED=${cpu}\n`);
    expect(result.stdout).toContain('REASON=unsupported-platform\n');
    expect(result.stdout).not.toContain('INSTALL_ATTEMPTED');
    expect(result.stderr).toContain(cpu);
  });
  for (const [id, version] of [['ubuntu', '24.04'], ['debian', '13']]) test(`${id} ${version} keeps native detection`, () => {
    const result = platform(id!, version!, 'aarch64');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('OVERRIDE=\nUNSUPPORTED=\nREASON=\n');
  });
});

describe('actual setup launch probe diagnostics', () => {
  for (const error of ['', 'spawn chromium ENOEXEC: wrong executable architecture', 'Missing shared library: libexample.so']) {
    test(error || 'successful launch is silent', () => {
      const dir = temp();
      mkdirSync(join(dir, 'node_modules/playwright'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/playwright/index.js'), `module.exports = { chromium: { launch: async () => { ${error ? `throw new Error(${JSON.stringify(error)})` : 'return { close: async () => {} }'} } } };\n`);
      const result = runBashScript([
        'set -e', `SOURCE_GSTACK_DIR=${JSON.stringify(dir)}`, 'IS_WINDOWS=0',
        fn('_kill_tree'), fn('_wait_with_deadline'), fn('ensure_playwright_browser'),
        'ensure_playwright_browser',
      ].join('\n'), { env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir }, timeout: 10_000 });
      expect(result.status).toBe(error ? 1 : 0);
      expect(result.stdout).toBe('');
      if (error) expect(result.stderr).toContain(error);
      else expect(result.stderr).toBe('');
    });
  }
});

/**
 * Windows terminal-agent console flash: under the Node polyfill a bare 'bun'
 * resolved to npm's bun.cmd shim and ran as `cmd.exe /c bun ...`. The detached
 * cmd.exe had no console, so bun.exe opened a visible one on every spawn, and
 * proc.pid was cmd.exe's, so the agent failed its startup record check and
 * exited, and the 60s watchdog respawned it. spawnTerminalAgent now spawns
 * bun.exe directly.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBunExecutable } from '../src/terminal-agent-control';

const files = (...paths: string[]) => (p: string) => paths.some(f => f.toLowerCase() === p.toLowerCase());

describe('resolveBunExecutable', () => {
  test('POSIX keeps bare bun', () => {
    expect(resolveBunExecutable({ platform: 'linux', isFile: () => true })).toBe('bun');
    expect(resolveBunExecutable({ platform: 'darwin', isFile: () => true })).toBe('bun');
  });

  test('Windows under bun.exe reuses its own executable', () => {
    expect(resolveBunExecutable({
      platform: 'win32', isBun: true, execPath: 'C:\\Tools\\bun.exe', env: {}, isFile: () => false,
    })).toBe('C:\\Tools\\bun.exe');
  });

  test('a compiled browse.exe is not mistaken for bun', () => {
    expect(resolveBunExecutable({
      platform: 'win32', isBun: true, execPath: 'C:\\gstack\\browse\\dist\\browse.exe',
      env: { PATH: 'C:\\bun\\bin' }, isFile: files('C:\\bun\\bin\\bun.exe'),
    })).toBe('C:\\bun\\bin\\bun.exe');
  });

  test('npm global install resolves through the bun.cmd shim to the real bun.exe', () => {
    const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm';
    expect(resolveBunExecutable({
      platform: 'win32', isBun: false, execPath: 'C:\\Program Files\\nodejs\\node.exe',
      env: { PATH: `C:\\Windows\\System32;${npm}` },
      isFile: files(`${npm}\\bun.cmd`, `${npm}\\node_modules\\bun\\bin\\bun.exe`),
    })).toBe(`${npm}\\node_modules\\bun\\bin\\bun.exe`);
  });

  test('BUN_INSTALL wins over PATH, and USERPROFILE\\.bun is the last resort', () => {
    const isFile = files('C:\\bi\\bin\\bun.exe', 'C:\\p\\bun.exe', 'C:\\Users\\u\\.bun\\bin\\bun.exe');
    const base = { platform: 'win32', isBun: false, execPath: 'node.exe', isFile };
    expect(resolveBunExecutable({ ...base, env: { BUN_INSTALL: 'C:\\bi', PATH: 'C:\\p' } })).toBe('C:\\bi\\bin\\bun.exe');
    expect(resolveBunExecutable({ ...base, env: { PATH: 'C:\\p' } })).toBe('C:\\p\\bun.exe');
    expect(resolveBunExecutable({ ...base, env: { PATH: 'C:\\none', USERPROFILE: 'C:\\Users\\u' } })).toBe('C:\\Users\\u\\.bun\\bin\\bun.exe');
  });

  test('falls back to bare bun when no bun.exe exists', () => {
    expect(resolveBunExecutable({
      platform: 'win32', isBun: false, execPath: 'node.exe', env: { PATH: 'C:\\x;relative' }, isFile: () => false,
    })).toBe('bun');
  });

  test('spawnTerminalAgent spawns through the resolver, not a bare bun', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, '../src/terminal-agent-control.ts'), 'utf8');
    const spawnSite = source.slice(source.indexOf('export function spawnTerminalAgent'));
    expect(spawnSite).toContain('spawn([resolveBunExecutable(), \'run\'');
    expect(spawnSite).not.toMatch(/spawn\(\[\s*'bun'/);
  });
});

/**
 * Static regression coverage for #1784.
 *
 * Bun.spawnSync does not honor windowsHide on Windows (Bun 1.3.11), so
 * cold-start console-subsystem helpers must route through Node's
 * child_process APIs with windowsHide:true. These checks pin the spawn sites
 * that otherwise create focus-stealing conhost.exe windows.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const CLI = path.join(ROOT, 'browse', 'src', 'cli.ts');
const CONFIG = path.join(ROOT, 'browse', 'src', 'config.ts');
const FILE_PERMISSIONS = path.join(ROOT, 'browse', 'src', 'file-permissions.ts');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

describe('#1784 Windows console flash suppression', () => {
  test('Windows detach launcher uses hidden Node spawnSync', () => {
    const body = read(CLI);
    expect(body).toMatch(/spawnSync as nodeSpawnSync/);
    expect(body).toMatch(
      /nodeSpawnSync\(\s*['"]node['"],\s*\[\s*['"]-e['"],\s*launcherCode\s*\][\s\S]{0,250}windowsHide:\s*true/,
    );
    expect(body).not.toMatch(/Bun\.spawnSync\(\s*\[\s*['"]node['"]/);
  });

  test('Windows taskkill helper uses hidden Node spawnSync', () => {
    const body = read(CLI);
    expect(body).toMatch(
      /nodeSpawnSync\(\s*['"]taskkill['"][\s\S]{0,250}windowsHide:\s*true/,
    );
    expect(body).not.toMatch(/Bun\.spawnSync\(\s*\[\s*['"]taskkill['"]/);
  });

  test('git probes use hidden Node spawnSync on Windows and keep Bun on POSIX', () => {
    const body = read(CONFIG);
    const hiddenGitSpawns = body.match(
      /nodeSpawnSync\(\s*['"]git['"][\s\S]{0,250}windowsHide:\s*true/g,
    ) || [];
    expect(body).toContain("process.platform === 'win32'");
    expect(hiddenGitSpawns).toHaveLength(2);
    expect(body).toMatch(
      /Bun\.spawnSync\(\s*\[\s*['"]git['"],\s*['"]rev-parse['"],\s*['"]--show-toplevel['"]/,
    );
    expect(body).toMatch(
      /Bun\.spawnSync\(\s*\[\s*['"]git['"],\s*['"]remote['"],\s*['"]get-url['"],\s*['"]origin['"]/,
    );
  });

  test('icacls ACL helpers pass windowsHide to execFileSync', () => {
    const body = read(FILE_PERMISSIONS);
    const hiddenIcaclsCalls = body.match(
      /execFileSync\(\s*['"]icacls['"][\s\S]{0,250}windowsHide:\s*true/g,
    ) || [];
    expect(hiddenIcaclsCalls).toHaveLength(2);
  });
});

describe('detached server spawns carry windowsHide (#1863 fold-in)', () => {
  test('Windows Node launcher inner spawn carries windowsHide:true', () => {
    const body = read(CLI);
    expect(body).toMatch(/spawn\(process\.execPath,[\s\S]{0,500}detached:true,windowsHide:true/);
  });

  test('non-Windows server nodeSpawn carries windowsHide:true', () => {
    const body = read(CLI);
    expect(body).toMatch(/nodeSpawn\('bun',[\s\S]{0,500}detached:\s*true[\s\S]{0,100}windowsHide:\s*true/);
  });

  test('every detached spawn site in cli.ts carries windowsHide:true', () => {
    const body = read(CLI);
    const detachedSpawns = body.match(/detached:\s*true/g)?.length ?? 0;
    const windowsHideFlags = body.match(/windowsHide:\s*true/g)?.length ?? 0;
    expect(windowsHideFlags).toBeGreaterThanOrEqual(detachedSpawns);
  });
});

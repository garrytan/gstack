import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// REGRESSION TEST for the Windows "stray terminal window" class of bug.
//
// The browse daemon is launched detached (cli.ts startServer), which on Windows
// means it has NO console. Any console child it then spawns — chrome-headless-
// shell.exe via Playwright, `bun` helpers, the taskkill cleanup — finds no
// console to inherit, so Windows allocates a fresh VISIBLE console window for
// it. windowsHide (CREATE_NO_WINDOW) on the CHILD suppresses that window even
// when the parent has no console (verified on Windows 11).
//
// The primary fix is win-console-hide.ts: the daemon patches
// child_process.spawn/spawnSync to default windowsHide:true, so Playwright's
// browser launch (which we can't pass spawn options to) is covered. gstack's own
// Bun.spawn helpers and the detached/telemetry spawns set windowsHide directly.
//
// Static-grep tripwire — read source, assert the invariant. Pattern mirrors
// browse/test/terminal-agent-pid-identity.test.ts. Uses import.meta.dir, NOT
// new URL(import.meta.url).pathname (which yields "/C:/..." -> doubled-drive
// "C:\C:\..." on Windows).
const SRC_DIR = path.resolve(import.meta.dir, '..', 'src');

function read(file: string): string {
  return fs.readFileSync(path.join(SRC_DIR, file), 'utf-8');
}

describe('Windows detached spawns hide the console window', () => {
  test('1. win-console-hide.ts patches spawn and spawnSync with windowsHide', () => {
    const m = read('win-console-hide.ts');
    expect(m).toContain("process.platform === 'win32'");
    expect(m).toMatch(/windowsHide\s*=\s*true/);
    // Must patch both window-creating entry points.
    expect(m).toMatch(/'spawn',\s*'spawnSync'/);
  });

  test('2. server.ts imports win-console-hide before BrowserManager (=> before Playwright)', () => {
    const s = read('server.ts');
    const hide = s.indexOf("./win-console-hide");
    const bm = s.indexOf("./browser-manager");
    expect(hide).toBeGreaterThanOrEqual(0);
    expect(bm).toBeGreaterThanOrEqual(0);
    expect(hide).toBeLessThan(bm); // ordering is load-bearing
  });

  test('3. browser-skill-commands.ts bun spawns set windowsHide', () => {
    const c = read('browser-skill-commands.ts');
    const hits = c.match(/windowsHide:\s*true/g) || [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  test('4. cli.ts Windows server launcher passes windowsHide alongside detached', () => {
    expect(read('cli.ts')).toContain('detached:true,windowsHide:true,');
  });

  test('5. security.ts attack-telemetry reporter passes windowsHide alongside detached', () => {
    expect(read('security.ts')).toMatch(/detached:\s*true,[\s\S]{0,400}?windowsHide:\s*true/);
  });
});

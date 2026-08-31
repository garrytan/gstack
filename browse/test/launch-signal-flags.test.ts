/**
 * Static tripwire for #2220: every Playwright launch site must disable
 * Playwright's process-level signal handlers (handleSIGINT / handleSIGTERM /
 * handleSIGHUP), and server.ts must own the SIGHUP cleanup those flags
 * remove.
 *
 * WHY handleSIGTERM:false is correct here: server.ts DELIBERATELY ignores
 * SIGTERM in normal headless mode (the process.on('SIGTERM') handler —
 * Claude Code's Bash sandbox fires SIGTERM when the parent shell exits
 * between tool invocations, and the daemon must survive it). Playwright's
 * default handleSIGTERM:true registers its OWN handler that closes Chromium
 * on the same signal — so the daemon survived but its browser died out from
 * under it. With the flag false, the daemon's signal policy is the only
 * signal policy: the signals server.ts honors route through activeShutdown,
 * which closes Chromium itself.
 *
 * WHY server.ts needs a SIGHUP handler (ENG-OV4): before #2220 the daemon
 * had NO process-level SIGHUP handler — Playwright's default handleSIGHUP
 * was the only thing closing Chromium on hangup. Flipping the flag without
 * adding a handler would leak a live Chromium on every hangup.
 *
 * Source-level, same style as windows-spawn-hide.test.ts: cheap,
 * deterministic, runs on every platform.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const SRC = (f: string) => fs.readFileSync(path.join(import.meta.dir, '../src', f), 'utf-8');

/** Every occurrence of `needle` must carry all three handleSIG* flags within
 * the next `window` chars (the launch options object). */
function expectSignalFlagsNearEvery(src: string, needle: string, window = 1200): number {
  let idx = src.indexOf(needle);
  expect(idx).toBeGreaterThanOrEqual(0);
  let count = 0;
  while (idx !== -1) {
    const slice = src.slice(idx, idx + window);
    expect(slice).toMatch(/handleSIGINT:\s*false/);
    expect(slice).toMatch(/handleSIGTERM:\s*false/);
    expect(slice).toMatch(/handleSIGHUP:\s*false/);
    count++;
    idx = src.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe('Playwright launch sites disable signal handlers (#2220)', () => {
  test('all chromium.launch / launchPersistentContext sites carry the three flags', () => {
    const src = SRC('browser-manager.ts');
    const launchCount = expectSignalFlagsNearEvery(src, 'chromium.launch({');
    const persistentCount = expectSignalFlagsNearEvery(src, 'chromium.launchPersistentContext(');
    // Three launch sites today: headless launch(), headed launchHeaded(),
    // and the handoff relaunch. A NEW launch site must carry the flags too —
    // bump this only after adding them.
    expect(launchCount + persistentCount).toBe(3);
  });

  test('server.ts owns SIGHUP cleanup now that Playwright does not (ENG-OV4)', () => {
    const src = SRC('server.ts');
    // The SIGHUP handler must route to the same shutdown path Chromium
    // cleanup uses (activeShutdown), like SIGINT does.
    expect(src).toMatch(/process\.on\('SIGHUP',\s*\(\)\s*=>\s*activeShutdown\?\.\(\)\)/);
  });

  test('the deliberate headless SIGTERM-ignore still exists (the reason handleSIGTERM:false is safe)', () => {
    const src = SRC('server.ts');
    // If this handler ever disappears, revisit handleSIGTERM:false — the
    // flag is correct BECAUSE server.ts owns SIGTERM policy.
    expect(src).toContain("process.on('SIGTERM'");
    expect(src).toContain('Received SIGTERM (ignoring');
  });
});

/**
 * /open-gstack-browser must not kill a live browse daemon on its own.
 *
 * Step 0 probes with `$B status` (without auto-starting a daemon). No live
 * daemon → plain `$B connect`, which reaps orphans and refuses to replace a
 * busy daemon itself. A live daemon → AskUserQuestion, and only an explicit
 * yes runs `$B connect --force-restart`. Spawned or headless sessions leave it
 * running and print how to replace it. The skill never kills the PID recorded
 * in .gstack/browse.json by hand.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { expectMentions } from './helpers/prompt-structure';

const ROOT = path.resolve(import.meta.dir, '..');
const TMPL = fs.readFileSync(path.join(ROOT, 'open-gstack-browser', 'SKILL.md.tmpl'), 'utf-8');
// Printed with the resolved browse binary path in place of %s.
const STOP_LINE = 'Live browse daemon left running. Run %s stop, then re-run /open-gstack-browser to replace it.';

const section = (from: string, to: string) => {
  const start = TMPL.indexOf(from);
  const end = TMPL.indexOf(to, start + from.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return TMPL.slice(start, end);
};

describe('/open-gstack-browser daemon liveness', () => {
  test('no hand-rolled kill of the recorded daemon PID', () => {
    expect(TMPL).not.toMatch(/\bkill\b[^\n]*(_OLD_PID|\$\w*PID)/);
    expect(TMPL).not.toMatch(/kill -9/);
    expect(TMPL).not.toMatch(/grep -o '"pid":/);
    expect(TMPL).not.toMatch(/rm -f[^\n]*browse\.json/);
  });

  test('Step 0 probes with $B status without auto-starting a daemon, before any connect', () => {
    const probeAt = TMPL.indexOf('BROWSE_NO_AUTOSTART=1 $B status');
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(TMPL.indexOf('$B connect'));
  });

  test('--force-restart appears only in the explicit-yes branch', () => {
    const live = section('`DAEMON: live`', '## Step 2');
    const ask = live.indexOf('AskUserQuestion');
    expect(ask).toBeGreaterThanOrEqual(0);
    const occurrences = [...TMPL.matchAll(/--force-restart/g)].map((m) => m.index!);
    expect(occurrences.length).toBeGreaterThan(0);
    const liveStart = TMPL.indexOf('`DAEMON: live`');
    const askAbs = liveStart + ask;
    for (const at of occurrences) expect(at).toBeGreaterThan(askAbs);
    expect(live).toMatch(/only an explicit a runs[^\n]*--force-restart/i);
    expect(TMPL).toMatch(/after an explicit a[^\n]*\n+```bash\n\$B connect --force-restart\n```/i);
  });

  test('the no-daemon branch runs plain connect and keeps the Chromium profile-lock cleanup', () => {
    const none = section('`DAEMON: none`', '`DAEMON: headed`');
    expect(none).toContain('plain `$B connect`');
    expect(none).toContain('SingletonLock SingletonSocket SingletonCookie');
    expect(none).not.toContain('--force-restart');
  });

  test('spawned or headless sessions leave the daemon running and print the resolved-binary stop line', () => {
    const live = section('`DAEMON: live`', '## Step 1');
    expectMentions(live, [['do not', 'headless', 'spawned']], 'live');
    expect(live).toContain(`printf '${STOP_LINE}\\n' "$B"`);
    expect(live.indexOf(STOP_LINE)).toBeLessThan(live.indexOf('AskUserQuestion'));
  });
});

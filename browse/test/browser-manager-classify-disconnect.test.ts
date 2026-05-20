import { describe, test, expect } from 'bun:test';
import { classifyDisconnect } from '../src/browser-manager';

// Pins the FATAL-on-clean-tab-close regression: pages.size === 0 at
// disconnect time means the user closed the last tab, not that Chromium
// crashed. Before this split, both paths exited 1 and the daemon log
// printed `FATAL: Chromium process crashed`, killing the sidebar-agent
// every time a user closed their last tab in headed mode.

describe('classifyDisconnect — clean-drain vs crash', () => {
  test('launched mode, zero pages → clean-drain, exit 0, browser-empty-launched', () => {
    expect(classifyDisconnect({ pagesSize: 0, mode: 'launched' })).toEqual({
      kind: 'clean-drain',
      reason: 'browser-empty-launched',
      exitCode: 0,
    });
  });

  test('launched mode, pages still live → crash, exit 1, chromium-crash-launched', () => {
    expect(classifyDisconnect({ pagesSize: 1, mode: 'launched' })).toEqual({
      kind: 'crash',
      reason: 'chromium-crash-launched',
      exitCode: 1,
    });
    expect(classifyDisconnect({ pagesSize: 5, mode: 'launched' })).toEqual({
      kind: 'crash',
      reason: 'chromium-crash-launched',
      exitCode: 1,
    });
  });

  test('rehead mode, zero pages → clean-drain, exit 0, browser-empty-rehead', () => {
    expect(classifyDisconnect({ pagesSize: 0, mode: 'rehead' })).toEqual({
      kind: 'clean-drain',
      reason: 'browser-empty-rehead',
      exitCode: 0,
    });
  });

  test('rehead mode, pages still live → crash, exit 1, chromium-crash-rehead', () => {
    expect(classifyDisconnect({ pagesSize: 3, mode: 'rehead' })).toEqual({
      kind: 'crash',
      reason: 'chromium-crash-rehead',
      exitCode: 1,
    });
  });

  test('reason tag always carries the mode for postmortem disambiguation', () => {
    // ~/.gstack/last-shutdown.json reads this string. Tag must include
    // the mode so an embedder log can tell launched-disconnect from
    // rehead-disconnect at a glance.
    const launched = classifyDisconnect({ pagesSize: 0, mode: 'launched' });
    const rehead = classifyDisconnect({ pagesSize: 0, mode: 'rehead' });
    expect(launched.reason.endsWith('-launched')).toBe(true);
    expect(rehead.reason.endsWith('-rehead')).toBe(true);
  });
});

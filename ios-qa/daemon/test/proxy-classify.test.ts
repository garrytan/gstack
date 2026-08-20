// Tailnet endpoint allowlist + capability tier classification tests.
//
// Codex flagged: "tailnet listener allowlist is too broad. Remote agents
// should not get /state/* by default. Split capabilities: observe, interact,
// mutate state, restore state."

import { describe, test, expect } from 'bun:test';
import { classifyRoute } from '../src/proxy';

describe('classifyRoute', () => {
  test('healthz, screenshot, elements, snapshot are observe-tier', () => {
    expect(classifyRoute('GET', '/healthz').requiredCapability).toBe('observe');
    expect(classifyRoute('GET', '/screenshot').requiredCapability).toBe('observe');
    expect(classifyRoute('GET', '/elements').requiredCapability).toBe('observe');
    expect(classifyRoute('GET', '/state/snapshot').requiredCapability).toBe('observe');
    expect(classifyRoute('GET', '/state/anyKey').requiredCapability).toBe('observe');
  });

  test('tap, swipe, type, session ops are interact-tier', () => {
    expect(classifyRoute('POST', '/tap').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/swipe').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/type').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/session/acquire').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/session/release').requiredCapability).toBe('interact');
    expect(classifyRoute('POST', '/session/heartbeat').requiredCapability).toBe('interact');
  });

  test('arbitrary state writes are mutate-tier', () => {
    expect(classifyRoute('POST', '/state/userIsLoggedIn').requiredCapability).toBe('mutate');
    expect(classifyRoute('POST', '/state/anyField').requiredCapability).toBe('mutate');
  });

  test('state/restore is restore-tier (highest)', () => {
    expect(classifyRoute('POST', '/state/restore').requiredCapability).toBe('restore');
  });

  test('mint endpoint is observe-tier (minimum bar to attempt mint)', () => {
    expect(classifyRoute('POST', '/auth/mint').requiredCapability).toBe('observe');
  });

  test('non-allowlisted endpoints return allowed=false', () => {
    expect(classifyRoute('POST', '/auth/sessions').allowed).toBe(false);
    expect(classifyRoute('GET', '/random').allowed).toBe(false);
    expect(classifyRoute('DELETE', '/anything').allowed).toBe(false);
    expect(classifyRoute('GET', '/auth/sessions').allowed).toBe(false); // loopback-only
  });
});

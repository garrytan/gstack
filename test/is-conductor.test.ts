import { describe, test, expect } from 'bun:test';
import { isConductor } from '../lib/is-conductor';

describe('is-conductor', () => {
  test('true when CONDUCTOR_WORKSPACE_PATH is set', () => {
    expect(isConductor({ CONDUCTOR_WORKSPACE_PATH: '/Users/x/conductor/ws' })).toBe(true);
  });

  test('true when CONDUCTOR_PORT is set', () => {
    expect(isConductor({ CONDUCTOR_PORT: '55070' })).toBe(true);
  });

  test('true when both are set', () => {
    expect(isConductor({ CONDUCTOR_WORKSPACE_PATH: '/ws', CONDUCTOR_PORT: '55070' })).toBe(true);
  });

  test('false when neither is set', () => {
    expect(isConductor({ HOME: '/Users/x', PATH: '/usr/bin' })).toBe(false);
  });

  test('false on an empty env', () => {
    expect(isConductor({})).toBe(false);
  });

  test('false when the vars are present but empty (Codex #1 hardening — empty != set)', () => {
    expect(isConductor({ CONDUCTOR_WORKSPACE_PATH: '', CONDUCTOR_PORT: '' })).toBe(false);
  });

  test('reads the passed env at call time, not a module-load snapshot', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(isConductor(env)).toBe(false);
    // mutate AFTER the first call — a call-time read must see the new value
    env.CONDUCTOR_PORT = '55070';
    expect(isConductor(env)).toBe(true);
  });

  test('defaults to process.env when no arg is passed', () => {
    const saved = process.env.CONDUCTOR_PORT;
    try {
      process.env.CONDUCTOR_PORT = '12345';
      expect(isConductor()).toBe(true);
      delete process.env.CONDUCTOR_PORT;
      // CONDUCTOR_WORKSPACE_PATH may be set in a real Conductor session; guard the assertion
      if (!process.env.CONDUCTOR_WORKSPACE_PATH) expect(isConductor()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CONDUCTOR_PORT;
      else process.env.CONDUCTOR_PORT = saved;
    }
  });
});

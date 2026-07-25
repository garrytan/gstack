import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { terminationAction } from '../src/daemon-ownership-policy';

describe('daemon ownership across browser-mode transitions', () => {
  test('headless launch remains alive after a later user handoff', () => {
    expect(terminationAction({ startedHeaded: false, tunnelActive: false })).toBe('retain');
  });

  test('a daemon launched headed remains owned by external lifecycle signals', () => {
    expect(terminationAction({ startedHeaded: true, tunnelActive: false })).toBe('shutdown');
  });

  test('an active tunnel remains owned by external lifecycle signals', () => {
    expect(terminationAction({ startedHeaded: false, tunnelActive: true })).toBe('shutdown');
  });

  test('watchdog and SIGTERM handlers use launch ownership, not current browser mode', () => {
    const server = fs.readFileSync(
      path.join(import.meta.dir, '..', 'src', 'server.ts'),
      'utf-8',
    );
    const calls = server.match(/terminationAction\(\{/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(server).not.toContain('if (headed || tunnelActive)');
  });
});

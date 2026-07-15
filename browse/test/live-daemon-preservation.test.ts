import { describe, expect, test } from 'bun:test';
import { shouldPreserveUnresponsiveServer, type ServerState } from '../src/cli';

const state = { pid: 42 } as ServerState;

describe('live daemon preservation (#2219)', () => {
  test('preserves an unresponsive daemon while its process is alive', () => {
    expect(shouldPreserveUnresponsiveServer(state, pid => pid === 42)).toBe(true);
  });

  test('allows restart after the daemon process is gone', () => {
    expect(shouldPreserveUnresponsiveServer(state, () => false)).toBe(false);
  });

  test('allows startup when no prior daemon state exists', () => {
    expect(shouldPreserveUnresponsiveServer(null, () => true)).toBe(false);
  });
});

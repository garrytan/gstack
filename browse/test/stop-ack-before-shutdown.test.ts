import { describe, expect, test } from 'bun:test';
import { handleMetaCommand } from '../src/meta-commands';

describe('server control acknowledgement ordering', () => {
  for (const [command, acknowledgement] of [
    ['stop', 'Server stopped'],
    ['restart', 'Restarting...'],
  ] as const) {
    test(`${command} acknowledges before closing the listener`, async () => {
      let shutdownCalls = 0;
      const manager = { getActiveSession: () => ({}) } as any;

      const result = await handleMetaCommand(command, [], manager, async () => {
        shutdownCalls += 1;
      });

      expect(result).toBe(acknowledgement);
      expect(shutdownCalls).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shutdownCalls).toBe(1);
    });
  }
});

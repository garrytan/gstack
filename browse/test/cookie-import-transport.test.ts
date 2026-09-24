import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { sendCommand } from '../src/cli';

afterEach(() => mock.restore());

describe('cookie import CLI transport', () => {
  const state = { port: 9470, token: 'synthetic-fixture' } as any;

  test('allows the bounded import stages to finish without changing other command budgets', async () => {
    const budgets: number[] = [];
    spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      budgets.push(ms);
      return new AbortController().signal;
    });
    spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Synthetic receipt'));
    const output = spyOn(process.stdout, 'write').mockReturnValue(true);
    await sendCommand(state, 'cookie-import-browser', ['chromium', '--domain', 'example.test']);
    await sendCommand(state, 'text', []);
    expect(budgets).toEqual([90_000, 30_000]);
    expect(output).toHaveBeenCalledWith('Synthetic receipt');
  });

  for (const failure of ['ECONNRESET', 'ECONNREFUSED', 'AbortError', 'TimeoutError', 'fetch failed']) {
    test(`does not replay an import after ${failure}`, async () => {
      const request = spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw Object.assign(new Error(failure), { code: failure, name: failure });
      });
      await expect(sendCommand(state, 'cookie-import-browser', ['chromium', '--all'])).rejects.toThrow('was not replayed');
      expect(request).toHaveBeenCalledTimes(1);
    });
  }

  test('does not automatically retry cookie import after an authorization change', async () => {
    const request = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('Unauthorized', { status: 401 }));
    await expect(sendCommand(state, 'cookie-import-browser', ['chromium', '--all'])).rejects.toThrow('retry manually');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

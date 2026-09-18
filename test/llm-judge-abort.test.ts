import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Messages } from '@anthropic-ai/sdk/resources/messages';
import { resolveEvalModel } from '../lib/eval-model';
import { callJudge } from './helpers/llm-judge';

// Stub the SDK request method, not fetch: every test stays local even when an
// operator has API credentials configured. Restore the prototype after each.
const response = { content: [{ type: 'text', text: 'Result: {"passed":true}' }] };
let create: ReturnType<typeof spyOn>;
let random: ReturnType<typeof spyOn>;

beforeEach(() => {
  create = spyOn(Messages.prototype, 'create').mockResolvedValue(response as any);
  random = spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  create.mockRestore();
  random.mockRestore();
});

describe('callJudge cancellation', () => {
  test('preserves default requests and JSON parsing without a signal', async () => {
    expect(await callJudge('Judge this.')).toEqual({ passed: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toEqual([{
      model: resolveEvalModel('judge'),
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'Judge this.' }],
    }, undefined]);
  });

  test('forwards the signal as an SDK request option while preserving model and generation options', async () => {
    const controller = new AbortController();
    expect(await callJudge('Bounded judgment.', 'test-judge-model', {
      signal: controller.signal, temperature: 0, max_tokens: 256,
    })).toEqual({ passed: true });
    expect(create.mock.calls[0]).toEqual([{
      model: 'test-judge-model', max_tokens: 256, temperature: 0,
      messages: [{ role: 'user', content: 'Bounded judgment.' }],
    }, { signal: controller.signal }]);
  });

  test('rejects a pre-aborted signal without invoking the SDK', async () => {
    const controller = new AbortController();
    const reason = new Error('Judge deadline already expired.');
    controller.abort(reason);
    await expect(callJudge('Do not dispatch.', undefined, { signal: controller.signal })).rejects.toBe(reason);
    expect(create).not.toHaveBeenCalled();
  });

  test('aborts an active SDK request without retrying and preserves the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('Judge deadline expired.');
    create.mockImplementation((_body: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('SDK request aborted')), { once: true });
    }));
    const pending = callJudge('Cancelable request.', undefined, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('rejects a late successful SDK response after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('Expired before result delivery.');
    create.mockImplementation((_body: unknown, options: { signal: AbortSignal }) => new Promise(resolve => {
      options.signal.addEventListener('abort', () => resolve(response), { once: true });
    }));
    const pending = callJudge('Late response.', undefined, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('aborts during a 429 retry delay without making another request', async () => {
    const controller = new AbortController();
    const reason = new Error('Expired during rate-limit backoff.');
    create.mockRejectedValue({ status: 429, headers: { 'retry-after': '30' } });
    const pending = callJudge('Rate-limited request.', undefined, { signal: controller.signal });
    // Let the rejected request enter its retry delay before canceling.
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(create).toHaveBeenCalledTimes(1);
  }, 3000);

  test('keeps three 429 retries for callers without a signal', async () => {
    const rateLimit = { status: 429, headers: { 'retry-after': '0.001' } };
    create.mockRejectedValue(rateLimit);
    await expect(callJudge('Retry as before.')).rejects.toBe(rateLimit);
    expect(create).toHaveBeenCalledTimes(4);
  });

  test('still returns a successful retried result and does not retry other errors', async () => {
    create.mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '0.001' } });
    expect(await callJudge('Transient rate limit.')).toEqual({ passed: true });
    expect(create).toHaveBeenCalledTimes(2);

    create.mockClear();
    const failure = new Error('Provider request failed.');
    create.mockRejectedValue(failure);
    await expect(callJudge('Non-rate-limit failure.')).rejects.toBe(failure);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

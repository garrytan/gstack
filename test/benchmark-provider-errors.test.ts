import { describe, expect, test } from 'bun:test';
import { isCapacityError, providerErrorDetail } from './helpers/providers/errors';

describe('benchmark provider error classification', () => {
  test('recognizes the Antigravity model-capacity message', () => {
    expect(isCapacityError('Selected model is at capacity. Please try a different model')).toBe(true);
  });

  test('recognizes overloaded and high-load variants', () => {
    expect(isCapacityError('The provider is overloaded right now')).toBe(true);
    expect(isCapacityError('Model temporarily unavailable due to high demand')).toBe(true);
  });

  test('does not misclassify auth, quota, or generic failures as capacity', () => {
    expect(isCapacityError('Error 401: login required')).toBe(false);
    expect(isCapacityError('429 quota exceeded')).toBe(false);
    expect(isCapacityError('connection reset by peer')).toBe(false);
  });

  test('combines stderr and message without duplicating subprocess output', () => {
    const stderr = 'Selected model is at capacity.';
    expect(providerErrorDetail({ stderr: Buffer.from(stderr), message: `Command failed\n${stderr}` }))
      .toBe(`Command failed\n${stderr}`);
    expect(providerErrorDetail({ stderr: Buffer.from('stderr only'), message: 'message only' }))
      .toBe('stderr only\nmessage only');
  });
});

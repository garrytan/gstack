import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRateLimiter, rateLimitHeaders } from '@/server/rate-limit';

describe('MemoryRateLimiter', () => {
  let limiter: MemoryRateLimiter;
  beforeEach(() => {
    limiter = new MemoryRateLimiter();
  });

  it('allows requests up to the limit and refuses the next one', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.check('k', 3, 60_000)).allowed).toBe(true);
    }
    const fourth = await limiter.check('k', 3, 60_000);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts down remaining', async () => {
    expect((await limiter.check('k', 5, 60_000)).remaining).toBe(4);
    expect((await limiter.check('k', 5, 60_000)).remaining).toBe(3);
  });

  it('keys separately, so one caller cannot exhaust another', async () => {
    await limiter.check('a', 1, 60_000);
    expect((await limiter.check('a', 1, 60_000)).allowed).toBe(false);
    expect((await limiter.check('b', 1, 60_000)).allowed).toBe(true);
  });

  it('opens a fresh window once the old one expires', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
      await limiter.check('k', 1, 60_000);
      expect((await limiter.check('k', 1, 60_000)).allowed).toBe(false);

      vi.setSystemTime(new Date('2026-06-01T00:01:01Z'));
      expect((await limiter.check('k', 1, 60_000)).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('declares itself non-distributed so callers know the guarantee it offers', () => {
    expect(limiter.isDistributed).toBe(false);
  });

  it('never reports negative remaining', async () => {
    for (let i = 0; i < 10; i += 1) await limiter.check('k', 2, 60_000);
    expect((await limiter.check('k', 2, 60_000)).remaining).toBe(0);
  });
});

describe('rateLimitHeaders', () => {
  it('omits Retry-After when the request is allowed', () => {
    const headers = rateLimitHeaders({
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 0,
    });
    expect(headers['RateLimit-Limit']).toBe('10');
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('includes Retry-After when refused', () => {
    const headers = rateLimitHeaders({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      retryAfterSeconds: 30,
    });
    expect(headers['Retry-After']).toBe('30');
  });
});

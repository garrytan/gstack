/**
 * Rate limiting.
 *
 * A fixed-window counter behind an interface, so the in-process implementation
 * can be swapped for a shared store (Redis, Upstash) the moment there is more
 * than one instance. That swap matters: an in-process limiter on N instances
 * lets through N times the configured rate, which is why `isDistributed` is
 * exposed rather than hidden — a caller that needs a hard guarantee can check.
 *
 * Applied to AI endpoints first, because they are the surface where abuse
 * costs real money per request.
 */

import 'server-only';
import { getServerEnv } from '@/lib/env';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Unix ms at which the current window resets. */
  readonly resetAt: number;
  /** Seconds the caller should wait. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  readonly isDistributed: boolean;
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * In-process fixed window.
 *
 * Entries are swept lazily on access rather than on a timer: a timer would
 * keep the process alive and would run even when nothing is being rate
 * limited. The sweep is bounded so one hot key cannot make it O(n) per call.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly isDistributed = false;
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  private sweep(now: number): void {
    // At most once a minute, and only when the map is big enough to matter.
    if (now - this.lastSweep < 60_000 || this.windows.size < 512) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now);

    const existing = this.windows.get(key);
    const window =
      existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };

    window.count += 1;
    this.windows.set(key, window);

    const allowed = window.count <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - window.count),
      resetAt: window.resetAt,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  /** Test-only. */
  reset(): void {
    this.windows.clear();
    this.lastSweep = 0;
  }
}

let limiter: RateLimiter = new MemoryRateLimiter();

export const getRateLimiter = (): RateLimiter => limiter;

/** Swap in a distributed limiter at startup once one exists. */
export const setRateLimiter = (next: RateLimiter): void => {
  limiter = next;
};

/**
 * Rate limit an AI request for a caller.
 *
 * The key is the authenticated user id where there is one, and the client
 * address otherwise. An anonymous caller gets a tighter budget, because an
 * address is far easier to rotate than an account.
 */
export const checkAiRateLimit = async (identity: {
  userId?: string;
  ip?: string;
}): Promise<RateLimitResult> => {
  const perMinute = getServerEnv().AI_RATE_LIMIT_PER_MINUTE;
  const key = identity.userId ? `ai:user:${identity.userId}` : `ai:ip:${identity.ip ?? 'unknown'}`;
  const limit = identity.userId ? perMinute : Math.max(1, Math.floor(perMinute / 2));
  return getRateLimiter().check(key, limit, 60_000);
};

/** Standard headers so a client can back off without guessing. */
export const rateLimitHeaders = (result: RateLimitResult): Record<string, string> => ({
  'RateLimit-Limit': String(result.limit),
  'RateLimit-Remaining': String(result.remaining),
  'RateLimit-Reset': String(Math.ceil((result.resetAt - Date.now()) / 1000)),
  ...(result.allowed ? {} : { 'Retry-After': String(result.retryAfterSeconds) }),
});

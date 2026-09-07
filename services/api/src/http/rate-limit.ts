/**
 * Rate limiting.
 *
 * The in-memory limiter below is per-instance. On a multi-instance deployment it bounds
 * abuse per instance, not globally, so authentication endpoints ALSO carry the persistent
 * per-account lockout in @wolf/auth, which is shared through Postgres and therefore cannot
 * be bypassed by spreading attempts across instances. A shared Redis-backed limiter can
 * replace this implementation without touching call sites.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Consume one unit against `key`. */
  consume(key: string, limit: number, windowSeconds: number, now?: number): RateLimitDecision;
  /** Forget a key, e.g. after a successful login. */
  reset(key: string): void;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  consume(key: string, limit: number, windowSeconds: number, now = Date.now()): RateLimitDecision {
    this.sweep(now);

    const windowMs = windowSeconds * 1000;
    const bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfterMs = bucket.windowStart + windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    return { allowed: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drop expired buckets so a long-running instance does not accumulate keys forever. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const cutoff = now - 3_600_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < cutoff) this.buckets.delete(key);
    }
  }
}

/** Limits applied per endpoint class. */
export const RATE_LIMITS = Object.freeze({
  login: { limit: 10, windowSeconds: 300 },
  refresh: { limit: 60, windowSeconds: 300 },
  command: { limit: 120, windowSeconds: 60 },
  read: { limit: 600, windowSeconds: 60 },
  enrollment: { limit: 20, windowSeconds: 3600 },
});

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Bounded in-memory fixed-window rate limiter (Design D-06, §5.5).
 * Prevents OOM under random-identifier floods via periodic TTL pruning + maxEntries cap.
 */
export class BoundedRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly maxEntries: number;
  private readonly pruneTimer: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    options?: { maxEntries?: number; pruneIntervalMs?: number },
  ) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const pruneIntervalMs = options?.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.pruneTimer = setInterval(() => this.pruneExpired(), pruneIntervalMs);
    this.pruneTimer.unref();
  }

  check(key: string, now: number = Date.now()): RateLimitCheckResult {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      if (existing) {
        this.buckets.delete(key);
      }
      return { allowed: true, retryAfterSeconds: 0, remaining: this.limit };
    }

    if (existing.count >= this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }

    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: Math.max(0, this.limit - existing.count),
    };
  }

  consume(key: string, now: number = Date.now()): RateLimitCheckResult {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      if (existing) {
        this.buckets.delete(key);
      }
      this.ensureCapacity(now);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: Math.max(0, this.limit - 1),
      };
    }

    if (existing.count >= this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }

    existing.count += 1;
    return {
      allowed: true,
      retryAfterSeconds: 0,
      remaining: Math.max(0, this.limit - existing.count),
    };
  }

  recordFailure(key: string, now: number = Date.now()): RateLimitCheckResult {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      if (existing) {
        this.buckets.delete(key);
      }
      this.ensureCapacity(now);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return {
        allowed: 1 < this.limit,
        retryAfterSeconds: 1 >= this.limit ? Math.ceil(this.windowMs / 1000) : 0,
        remaining: Math.max(0, this.limit - 1),
      };
    }

    existing.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return {
      allowed: existing.count < this.limit,
      retryAfterSeconds: existing.count >= this.limit ? retryAfterSeconds : 0,
      remaining: Math.max(0, this.limit - existing.count),
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  size(): number {
    return this.buckets.size;
  }

  pruneExpired(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.pruneTimer);
    this.buckets.clear();
  }

  private ensureCapacity(now: number): void {
    if (this.buckets.size < this.maxEntries) {
      return;
    }
    this.pruneExpired(now);
    while (this.buckets.size >= this.maxEntries) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.buckets.delete(oldestKey);
    }
  }
}

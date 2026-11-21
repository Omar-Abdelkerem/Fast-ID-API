import { BoundedRateLimiter } from './bounded-rate-limiter';

describe('BoundedRateLimiter', () => {
  it('enforces limit, returns Retry-After, and resets after window expires', () => {
    const limiter = new BoundedRateLimiter(3, 60_000, { maxEntries: 100 });
    const start = 1_000_000;

    expect(limiter.consume('ip:1', start).allowed).toBe(true);
    expect(limiter.consume('ip:1', start + 1_000).allowed).toBe(true);
    expect(limiter.consume('ip:1', start + 2_000).allowed).toBe(true);

    const blocked = limiter.consume('ip:1', start + 10_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(50);

    expect(limiter.consume('ip:1', start + 60_001).allowed).toBe(true);
    limiter.destroy();
  });

  it('bounds memory at maxEntries by pruning expired and evicting oldest', () => {
    const limiter = new BoundedRateLimiter(5, 60_000, { maxEntries: 3 });
    const start = 1_000_000;

    limiter.consume('k1', start);
    limiter.consume('k2', start);
    limiter.consume('k3', start);
    limiter.consume('k4', start);

    expect(limiter.size()).toBe(3);
    expect(limiter.check('k1', start).remaining).toBe(5); // evicted
    expect(limiter.check('k4', start).remaining).toBe(4);
    limiter.destroy();
  });

  it('tracks failed login attempts and clears on reset', () => {
    const limiter = new BoundedRateLimiter(5, 15 * 60_000);
    const start = 2_000_000;

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check('127.0.0.1:user@example.com', start).allowed).toBe(true);
      limiter.recordFailure('127.0.0.1:user@example.com', start);
    }

    const blocked = limiter.check('127.0.0.1:user@example.com', start + 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    limiter.reset('127.0.0.1:user@example.com');
    expect(limiter.check('127.0.0.1:user@example.com', start + 1_000).allowed).toBe(true);
    limiter.destroy();
  });
});

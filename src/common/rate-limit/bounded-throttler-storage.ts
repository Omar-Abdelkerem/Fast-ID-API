import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

interface Entry {
  hits: number;
  expiresAt: number;
  blockedUntil: number;
}

const MAX_ENTRIES = 50_000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Bounded in-memory ThrottlerStorage (Design D-06, Prompt Rule #3).
 * Caps stored keys at 50,000 with periodic TTL pruning so floods cannot exhaust memory.
 */
@Injectable()
export class BoundedThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly store = new Map<string, Entry>();
  private readonly pruneTimer: NodeJS.Timeout;

  constructor() {
    this.pruneTimer = setInterval(() => this.pruneExpired(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const now = Date.now();
    const compositeKey = `${throttlerName}:${key}`;
    let entry = this.store.get(compositeKey);

    if (entry && entry.expiresAt <= now && entry.blockedUntil <= now) {
      this.store.delete(compositeKey);
      entry = undefined;
    }

    if (!entry) {
      this.ensureCapacity(now);
      entry = {
        hits: 1,
        expiresAt: now + ttl,
        blockedUntil: 0,
      };
      this.store.set(compositeKey, entry);
    } else {
      entry.hits += 1;
      if (entry.hits > limit && blockDuration > 0 && entry.blockedUntil <= now) {
        entry.blockedUntil = now + blockDuration;
      }
    }

    const isBlocked = entry.blockedUntil > now;
    const timeToExpire = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
    const timeToBlockExpire = isBlocked
      ? Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000))
      : 0;

    return {
      totalHits: entry.hits,
      timeToExpire,
      isBlocked,
      timeToBlockExpire,
    };
  }

  clear(): void {
    this.store.clear();
  }

  pruneExpired(now: number = Date.now()): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now && entry.blockedUntil <= now) {
        this.store.delete(key);
      }
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.pruneTimer);
    this.store.clear();
  }

  private ensureCapacity(now: number): void {
    if (this.store.size < MAX_ENTRIES) {
      return;
    }
    this.pruneExpired(now);
    while (this.store.size >= MAX_ENTRIES) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
    }
  }
}

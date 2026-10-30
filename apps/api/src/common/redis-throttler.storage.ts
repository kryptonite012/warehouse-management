import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';

interface Record {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Rate-limit counters shared by every API replica (fixed window per key).
 * Used when REDIS_URL is set; otherwise Nest's in-memory storage applies per process.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2, enableOfflineQueue: true });
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<Record> {
    const k = `qs:throttle:${throttlerName}:${key}`;
    const blockKey = `${k}:blocked`;
    const blockedTtl = await this.redis.pttl(blockKey);
    if (blockedTtl > 0) {
      return { totalHits: limit + 1, timeToExpire: Math.ceil(blockedTtl / 1000), isBlocked: true, timeToBlockExpire: Math.ceil(blockedTtl / 1000) };
    }
    const [[, hits], [, pttl]] = (await this.redis.multi().incr(k).pttl(k).exec()) as [[null, number], [null, number]];
    let expires = pttl;
    if (pttl < 0) {
      await this.redis.pexpire(k, ttl);
      expires = ttl;
    }
    const isBlocked = hits > limit;
    if (isBlocked && blockDuration > 0) await this.redis.set(blockKey, '1', 'PX', blockDuration);
    return { totalHits: hits, timeToExpire: Math.ceil(expires / 1000), isBlocked, timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0 };
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}

import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

// When Upstash env vars are set, limits are enforced globally across every
// Vercel instance (a real hard cap). Without them, falls back to an
// in-memory sliding window that's only accurate per-instance — still a
// useful first line of defense, just not a strict global guarantee.
const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

export const isDistributedRateLimitConfigured = !!redis;

// One Ratelimit instance per (limit, window) pair — Upstash's client reuses
// the underlying script/connection, so caching by config avoids re-creating
// these on every request.
const limiters = new Map<string, Ratelimit>();

function getLimiter(limit: number, windowMs: number): Ratelimit {
  const cacheKey = `${limit}:${windowMs}`;
  let limiter = limiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: redis!,
      limiter: Ratelimit.slidingWindow(limit, `${Math.max(1, Math.round(windowMs / 1000))} s`),
      prefix: 'navi-rl',
      analytics: false,
    });
    limiters.set(cacheKey, limiter);
  }
  return limiter;
}

// ── In-memory fallback (used when Upstash isn't configured) ──────────────────
interface Bucket {
  hits: number[];
}
const buckets = new Map<string, Bucket>();

function inMemoryRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);

  if (buckets.size > 5000) {
    for (const [k, b] of buckets) {
      if (b.hits.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }
  return true;
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  if (redis) {
    try {
      const { success } = await getLimiter(limit, windowMs).limit(key);
      return success;
    } catch (e) {
      console.error('Upstash rate limit failed, falling back to in-memory:', e);
      return inMemoryRateLimit(key, limit, windowMs);
    }
  }
  return inMemoryRateLimit(key, limit, windowMs);
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}

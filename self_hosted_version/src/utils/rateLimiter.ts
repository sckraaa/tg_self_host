/**
 * Sliding-window rate limiter with per-key buckets.
 * Each key (e.g. IP, sessionId, phone) gets independent limits.
 */

interface RateLimitBucket {
  timestamps: number[];
}

export interface RateLimitConfig {
  /** Max requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, RateLimitBucket>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private config: RateLimitConfig) {
    // Periodic cleanup of expired buckets every 60s
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Check if the key is allowed to proceed. Returns true if allowed, false if rate-limited.
   */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }

    // Remove expired timestamps
    bucket.timestamps = bucket.timestamps.filter(t => t > cutoff);

    if (bucket.timestamps.length >= this.config.maxRequests) {
      return false;
    }

    bucket.timestamps.push(now);
    return true;
  }

  /** Reset a specific key's bucket */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    for (const [key, bucket] of this.buckets) {
      bucket.timestamps = bucket.timestamps.filter(t => t > cutoff);
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}

// Pre-configured limiters for different operations
export const authCodeLimiter = new RateLimiter({
  maxRequests: 3,      // 3 auth code requests
  windowMs: 5 * 60_000, // per 5 minutes
});

export const authSignInLimiter = new RateLimiter({
  maxRequests: 5,      // 5 sign-in attempts
  windowMs: 5 * 60_000, // per 5 minutes
});

export const rpcLimiter = new RateLimiter({
  maxRequests: 300,    // 300 RPC calls
  windowMs: 60_000,    // per minute
});

export const messageLimiter = new RateLimiter({
  maxRequests: 30,     // 30 messages
  windowMs: 60_000,    // per minute
});

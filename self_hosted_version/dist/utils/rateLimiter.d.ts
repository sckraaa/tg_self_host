/**
 * Sliding-window rate limiter with per-key buckets.
 * Each key (e.g. IP, sessionId, phone) gets independent limits.
 */
export interface RateLimitConfig {
    /** Max requests allowed in the window */
    maxRequests: number;
    /** Time window in milliseconds */
    windowMs: number;
}
export declare class RateLimiter {
    private config;
    private buckets;
    private cleanupTimer;
    constructor(config: RateLimitConfig);
    /**
     * Check if the key is allowed to proceed. Returns true if allowed, false if rate-limited.
     */
    check(key: string): boolean;
    /** Reset a specific key's bucket */
    reset(key: string): void;
    private cleanup;
    destroy(): void;
}
export declare const authCodeLimiter: RateLimiter;
export declare const authSignInLimiter: RateLimiter;
export declare const rpcLimiter: RateLimiter;
export declare const messageLimiter: RateLimiter;
//# sourceMappingURL=rateLimiter.d.ts.map
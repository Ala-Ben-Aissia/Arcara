import { type Middleware, HttpError } from '../types.js';

export interface RateLimitOptions {
  /**
   * Time window in milliseconds. Default: 60_000 (1 minute).
   */
  window?: number;
  /**
   * Max requests per window per key. Default: 100.
   */
  limit?: number;
  /**
   * Custom key extractor. Defaults to req.socket.remoteAddress.
   */
  keyBy?: (req: import('http').IncomingMessage) => string;
  /**
   * Called when limit is exceeded. Defaults to throwing HttpError(429).
   */
  onLimitReached?: Middleware;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(options: RateLimitOptions = {}): Middleware {
  const {
    window: windowMs = 60_000,
    limit = 100,
    keyBy = (req) => req.socket.remoteAddress ?? 'unknown',
    onLimitReached,
  } = options;

  const store = new Map<string, Bucket>();

  // Periodic cleanup to prevent unbounded memory growth
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of store) {
      if (now >= bucket.resetAt) store.delete(key);
    }
  }, windowMs);

  // Don't keep the process alive for cleanup alone
  cleanup.unref();

  return (req, res, next) => {
    const key = keyBy(req);
    const now = Date.now();

    let bucket = store.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      store.set(key, bucket);
    }

    bucket.count++;

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader(
      'X-RateLimit-Remaining',
      String(Math.max(0, limit - bucket.count)),
    );
    res.setHeader(
      'X-RateLimit-Reset',
      String(Math.ceil(bucket.resetAt / 1000)),
    );

    if (bucket.count > limit) {
      res.setHeader(
        'Retry-After',
        String(Math.ceil((bucket.resetAt - now) / 1000)),
      );
      if (onLimitReached) return onLimitReached(req, res, next);
      throw new HttpError(429, 'Too many requests');
    }

    next();
  };
}

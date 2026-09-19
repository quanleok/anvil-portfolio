export type FixedWindowRateLimitResult = {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
};

type RateBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateBucket>();

export function checkFixedWindowRateLimit({
  key,
  limit,
  windowMs,
  now = Date.now(),
}: {
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
}): FixedWindowRateLimitResult {
  const safeLimit = Math.max(0, Math.floor(limit));
  const safeWindowMs = Math.max(1_000, Math.floor(windowMs));
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    const resetAt = now + safeWindowMs;
    const count = safeLimit > 0 ? 1 : 0;
    buckets.set(key, { count, resetAt });
    return {
      allowed: safeLimit > 0,
      count,
      remaining: Math.max(0, safeLimit - count),
      resetAt,
      ...(safeLimit > 0 ? {} : { retryAfterSeconds: Math.ceil(safeWindowMs / 1000) }),
    };
  }

  if (current.count >= safeLimit) {
    return {
      allowed: false,
      count: current.count,
      remaining: 0,
      resetAt: current.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  return {
    allowed: true,
    count: current.count,
    remaining: Math.max(0, safeLimit - current.count),
    resetAt: current.resetAt,
  };
}

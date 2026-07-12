/**
 * Minimal in-process sliding-window rate limiter.
 *
 * Best-effort on serverless (each warm instance keeps its own window), which
 * is still enough to stop burst abuse of email-sending endpoints. Move to a
 * shared store (Postgres/Redis) if hard guarantees are ever needed.
 */

type Window = { count: number; resetAt: number };

const buckets = new Map<string, Window>();
const MAX_BUCKETS = 10_000;

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const w = buckets.get(key);

  if (!w || now >= w.resetAt) {
    // Opportunistic cleanup so the map can't grow unbounded.
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) {
        if (now >= v.resetAt) buckets.delete(k);
      }
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

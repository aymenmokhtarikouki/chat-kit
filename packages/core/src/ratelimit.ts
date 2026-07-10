/**
 * Per-key sliding-window rate limiter (yuma's chat gateway shipped exactly
 * this shape: 10 messages / 10 s per socket). Pure Map, no timers — expired
 * entries are reset on access and swept opportunistically so the map never
 * grows unbounded.
 */

export interface RateLimiter {
  tryAcquire(key: string): { allowed: true } | { allowed: false; retryAfterMs: number }
  /** Entries currently tracked (for tests/metrics). */
  size(): number
}

export function createRateLimiter(
  opts: { windowMs: number; max: number },
  now: () => number = () => Date.now(),
): RateLimiter {
  const entries = new Map<string, { count: number; resetAt: number }>()
  let opsSinceSweep = 0

  function sweep(at: number): void {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= at) entries.delete(key)
    }
  }

  return {
    tryAcquire(key) {
      const at = now()
      if (++opsSinceSweep >= 1000) {
        opsSinceSweep = 0
        sweep(at)
      }
      const entry = entries.get(key)
      if (!entry || entry.resetAt <= at) {
        entries.set(key, { count: 1, resetAt: at + opts.windowMs })
        return { allowed: true }
      }
      if (entry.count < opts.max) {
        entry.count += 1
        return { allowed: true }
      }
      return { allowed: false, retryAfterMs: entry.resetAt - at }
    },
    size() {
      return entries.size
    },
  }
}

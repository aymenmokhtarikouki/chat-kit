import { describe, expect, it } from 'vitest'
import { createRateLimiter } from '../src/ratelimit'

describe('createRateLimiter', () => {
  it('allows up to max within the window, then rejects with retryAfterMs', () => {
    let clock = 1_000
    const limiter = createRateLimiter({ windowMs: 10_000, max: 2 }, () => clock)
    expect(limiter.tryAcquire('u1')).toEqual({ allowed: true })
    expect(limiter.tryAcquire('u1')).toEqual({ allowed: true })
    const third = limiter.tryAcquire('u1')
    expect(third.allowed).toBe(false)
    if (!third.allowed) expect(third.retryAfterMs).toBe(10_000)
    clock += 5_000
    const fourth = limiter.tryAcquire('u1')
    expect(fourth.allowed).toBe(false)
    if (!fourth.allowed) expect(fourth.retryAfterMs).toBe(5_000)
  })

  it('resets after the window and isolates keys', () => {
    let clock = 0
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1 }, () => clock)
    expect(limiter.tryAcquire('u1').allowed).toBe(true)
    expect(limiter.tryAcquire('u2').allowed).toBe(true) // other key unaffected
    expect(limiter.tryAcquire('u1').allowed).toBe(false)
    clock = 1_001
    expect(limiter.tryAcquire('u1').allowed).toBe(true)
  })
})

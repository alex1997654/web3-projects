import { describe, expect, it } from 'vitest'
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, backoffDelayMs } from './backoff'

describe('backoffDelayMs', () => {
  it('keeps attempt 1 within [base/2, base)', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(BACKOFF_BASE_MS / 2)
    expect(backoffDelayMs(1, () => 0.999)).toBe(BACKOFF_BASE_MS - 1)
  })

  it('doubles per attempt', () => {
    expect(backoffDelayMs(2, () => 0)).toBe(BACKOFF_BASE_MS)
    expect(backoffDelayMs(3, () => 0)).toBe(BACKOFF_BASE_MS * 2)
    expect(backoffDelayMs(4, () => 0)).toBe(BACKOFF_BASE_MS * 4)
  })

  it('caps the raw delay before jitter', () => {
    const cappedFloor = Math.floor(BACKOFF_CAP_MS * 0.5)
    for (const attempt of [7, 10, 50]) {
      expect(backoffDelayMs(attempt, () => 0)).toBe(cappedFloor)
      const nearMax = backoffDelayMs(attempt, () => 0.999)
      expect(nearMax).toBeGreaterThanOrEqual(cappedFloor)
      expect(nearMax).toBeLessThan(BACKOFF_CAP_MS)
    }
  })

  it('treats zero and negative attempts as one', () => {
    expect(backoffDelayMs(0, () => 0.5)).toBe(backoffDelayMs(1, () => 0.5))
    expect(backoffDelayMs(-3, () => 0.5)).toBe(backoffDelayMs(1, () => 0.5))
  })
})

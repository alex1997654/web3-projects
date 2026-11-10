export const BACKOFF_BASE_MS = 1000
export const BACKOFF_CAP_MS = 60_000

/**
 * Exponential backoff with multiplicative jitter. For attempt n the raw
 * delay is base * 2^(n-1), capped, then scaled by a random factor in
 * [0.5, 1.0) so concurrent clients of a rate-limited endpoint do not
 * re-align their retries. The result never drops below half the base.
 */
export function backoffDelayMs(attempt: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt))
  const raw = Math.min(BACKOFF_BASE_MS * Math.pow(2, n - 1), BACKOFF_CAP_MS)
  const jitter = 0.5 + rand() / 2
  return Math.floor(raw * jitter)
}

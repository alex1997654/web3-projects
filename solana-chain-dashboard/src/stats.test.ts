import { describe, expect, it } from 'vitest'
import { SessionStats } from './stats'

describe('SessionStats', () => {
  it('counts events per minute over a sliding 60s window', () => {
    const s = new SessionStats()
    // 50 events during t=0..49s, one more two minutes later
    for (let i = 0; i < 50; i++) s.recordEvent(i * 1000)
    s.recordEvent(120_000)
    const snap = s.snapshot(120_500)
    expect(snap.totalEvents).toBe(51)
    expect(snap.eventsPerMinute).toBe(1) // the 50 older ones fell out of the window
  })

  it('sums volume in lamports as bigint', () => {
    const s = new SessionStats()
    s.recordTrade({ wallet: 'w1', solLamports: 1_500_000_000n, isBuy: true })
    s.recordTrade({ wallet: 'w1', solLamports: 250_000_000n, isBuy: false })
    s.recordTrade({ wallet: 'w2', solLamports: 900_000_000n, isBuy: true })
    const snap = s.snapshot(200_000)
    expect(snap.volumeLamports).toBe(2_650_000_000n)
    expect(snap.buys).toBe(2)
    expect(snap.sells).toBe(1)
  })

  it('ranks wallets by volume then trade count', () => {
    const s = new SessionStats()
    s.recordTrade({ wallet: 'low', solLamports: 100n, isBuy: true })
    s.recordTrade({ wallet: 'high', solLamports: 10_000n, isBuy: true })
    s.recordTrade({ wallet: 'tie-a', solLamports: 5_000n, isBuy: true })
    s.recordTrade({ wallet: 'tie-b', solLamports: 5_000n, isBuy: true })
    s.recordTrade({ wallet: 'tie-b', solLamports: 5_000n, isBuy: false })
    // high and tie-b both total 10_000; tie-b wins on trade count
    const snap = s.snapshot(300_000)
    expect(snap.topWallets.map((w) => w.wallet)).toEqual(['tie-b', 'high', 'tie-a', 'low'])
    expect(snap.topWallets[0]?.trades).toBe(2)
  })

  it('counts trades with no wallet but excludes them from rankings', () => {
    const s = new SessionStats()
    s.recordTrade({ wallet: null, solLamports: 1n, isBuy: true })
    const snap = s.snapshot(400_000)
    expect(snap.buys).toBe(1)
    expect(snap.volumeLamports).toBe(1n)
    expect(snap.topWallets).toEqual([])
  })

  it('counts failed tx separately without touching volume', () => {
    const s = new SessionStats()
    s.recordFailedTx()
    s.recordTrade({ wallet: 'w', solLamports: 1n, isBuy: true })
    const snap = s.snapshot(500_000)
    expect(snap.failedTx).toBe(1)
    expect(snap.volumeLamports).toBe(1n)
  })

  it('reset clears everything', () => {
    const s = new SessionStats()
    s.recordEvent(1)
    s.recordTrade({ wallet: 'w', solLamports: 1n, isBuy: true })
    s.recordFailedTx()
    s.reset()
    const snap = s.snapshot(600_000)
    expect(snap.totalEvents).toBe(0)
    expect(snap.eventsPerMinute).toBe(0)
    expect(snap.volumeLamports).toBe(0n)
    expect(snap.topWallets).toEqual([])
    expect(snap.failedTx).toBe(0)
  })
})

export interface TradeRow {
  readonly wallet: string | null
  readonly solLamports: bigint
  readonly isBuy: boolean
}

export interface WalletStat {
  readonly wallet: string
  readonly trades: number
  readonly volumeLamports: bigint
}

export interface StatsSnapshot {
  readonly eventsPerMinute: number
  readonly totalEvents: number
  readonly buys: number
  readonly sells: number
  readonly failedTx: number
  readonly volumeLamports: bigint
  readonly topWallets: readonly WalletStat[]
}

export const WINDOW_MS = 60_000
const TOP_WALLETS = 8

/**
 * Session-scoped aggregation, all client-side. A session is one feed run
 * for one program: automatic reconnects keep the numbers, switching
 * program or endpoint starts over. Failed transactions are counted but
 * never contribute volume or wallet rankings.
 */
export class SessionStats {
  private window: number[] = []
  private totalEvents = 0
  private buys = 0
  private sells = 0
  private failedTx = 0
  private volumeLamports = 0n
  private readonly wallets = new Map<string, { trades: number; volumeLamports: bigint }>()

  recordEvent(tsMs: number): void {
    this.totalEvents++
    this.window.push(tsMs)
  }

  recordFailedTx(): void {
    this.failedTx++
  }

  recordTrade(row: TradeRow): void {
    if (row.isBuy) {
      this.buys++
    } else {
      this.sells++
    }
    this.volumeLamports += row.solLamports
    if (row.wallet !== null) {
      const cur = this.wallets.get(row.wallet) ?? { trades: 0, volumeLamports: 0n }
      cur.trades++
      cur.volumeLamports += row.solLamports
      this.wallets.set(row.wallet, cur)
    }
  }

  reset(): void {
    this.window = []
    this.totalEvents = 0
    this.buys = 0
    this.sells = 0
    this.failedTx = 0
    this.volumeLamports = 0n
    this.wallets.clear()
  }

  snapshot(nowMs: number): StatsSnapshot {
    const cutoff = nowMs - WINDOW_MS
    while (this.window.length > 0 && this.window[0]! <= cutoff) this.window.shift()

    const topWallets = [...this.wallets.entries()]
      .map(([wallet, s]) => ({ wallet, trades: s.trades, volumeLamports: s.volumeLamports }))
      .sort((a, b) => (a.volumeLamports === b.volumeLamports ? b.trades - a.trades : a.volumeLamports > b.volumeLamports ? -1 : 1))
      .slice(0, TOP_WALLETS)

    return {
      eventsPerMinute: this.window.length,
      totalEvents: this.totalEvents,
      buys: this.buys,
      sells: this.sells,
      failedTx: this.failedTx,
      volumeLamports: this.volumeLamports,
      topWallets,
    }
  }
}

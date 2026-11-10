import type { FeedStatus } from './ws'
import type { StatsSnapshot } from './stats'
import { lamportsToSol, grouped, shortAddr } from './format'

export interface FeedRow {
  readonly time: string
  readonly slot: number
  readonly tag: string
  readonly tagClass: string
  readonly line1: string
  readonly line2: string | null
}

const MAX_ROWS = 200

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id)
  if (e === null) throw new Error('missing element #' + id)
  return e as T
}

export class DashboardUI {
  private readonly pill = el<HTMLSpanElement>('status-pill')
  private readonly slot = el<HTMLSpanElement>('slot')
  private readonly notice = el<HTMLParagraphElement>('notice')
  private readonly feed = el<HTMLUListElement>('feed')
  private readonly feedEmpty = el<HTMLParagraphElement>('feed-empty')
  private readonly feedMeta = el<HTMLSpanElement>('feed-meta')
  private readonly footerEndpoint = el<HTMLSpanElement>('footer-endpoint')
  private rows = 0
  private lastStatus: FeedStatus = { state: 'idle' }

  setStatus(status: FeedStatus, nowMs: number): void {
    this.lastStatus = status
    this.renderStatus(status, nowMs)
  }

  refreshStatus(nowMs: number): void {
    this.renderStatus(this.lastStatus, nowMs)
  }

  private renderStatus(status: FeedStatus, nowMs: number): void {
    switch (status.state) {
      case 'idle':
        this.setPill('idle', 'idle')
        break
      case 'connecting':
        this.setPill('connecting', 'connecting')
        break
      case 'live':
        this.setPill('live', 'live')
        break
      case 'reconnecting': {
        const left = Math.max(0, Math.ceil((status.retryAtMs - nowMs) / 1000))
        this.setPill('reconnecting', 'reconnecting (attempt ' + status.attempt + ', retry in ' + left + 's)')
        break
      }
    }
  }

  setSlot(slot: number): void {
    this.slot.textContent = slot > 0 ? 'slot ' + grouped(slot) : ''
  }

  private setPill(cls: string, text: string): void {
    this.pill.className = 'pill ' + cls
    this.pill.textContent = text
    this.feed.classList.toggle('dimmed', cls === 'reconnecting' || cls === 'connecting')
  }

  setNotice(message: string | null): void {
    if (message === null) {
      this.notice.hidden = true
      this.notice.textContent = ''
    } else {
      this.notice.hidden = false
      this.notice.textContent = message
    }
  }

  setFeedMeta(programLabel: string, endpoint: string): void {
    this.feedMeta.textContent = programLabel
    this.footerEndpoint.textContent = endpoint
  }

  appendRow(row: FeedRow): void {
    this.feedEmpty.hidden = true
    const li = document.createElement('li')

    const t = document.createElement('span')
    t.className = 't'
    t.textContent = row.time

    const slot = document.createElement('span')
    slot.className = 'slot'
    slot.textContent = grouped(row.slot)

    const tag = document.createElement('span')
    tag.className = 'tag ' + row.tagClass
    tag.textContent = row.tag

    const body = document.createElement('span')
    body.className = 'body'
    const l1 = document.createElement('span')
    l1.className = 'line1'
    l1.textContent = row.line1
    body.appendChild(l1)
    if (row.line2 !== null) {
      const l2 = document.createElement('span')
      l2.className = 'line2'
      l2.textContent = ' ' + row.line2
      body.appendChild(l2)
    }

    li.append(t, slot, tag, body)
    this.feed.insertBefore(li, this.feed.firstChild)
    this.rows++
    while (this.rows > MAX_ROWS) {
      const last = this.feed.lastChild
      if (last === null) break
      this.feed.removeChild(last)
      this.rows--
    }
  }

  clearFeed(): void {
    this.feed.textContent = ''
    this.rows = 0
    this.feedEmpty.hidden = false
    this.feedEmpty.textContent = 'connecting will fill this list'
  }

  renderStats(s: StatsSnapshot): void {
    const byId = (id: string) => el<HTMLElement>(id)
    byId('st-epm').textContent = grouped(s.eventsPerMinute)
    byId('st-total').textContent = grouped(s.totalEvents)
    byId('st-volume').textContent = s.volumeLamports === 0n ? '0.000' : lamportsToSol(s.volumeLamports)
    byId('st-trades').textContent = s.buys + ' / ' + s.sells
    byId('st-failed').textContent = grouped(s.failedTx)

    const list = el<HTMLOListElement>('st-wallets')
    list.textContent = ''
    for (const w of s.topWallets) {
      const li = document.createElement('li')
      const addr = document.createElement('span')
      addr.textContent = shortAddr(w.wallet, 6)
      const vol = document.createElement('span')
      vol.className = 'w-vol'
      vol.textContent = ' ' + lamportsToSol(w.volumeLamports) + ' SOL / ' + w.trades + 'x'
      li.append(addr, vol)
      list.appendChild(li)
    }
  }
}

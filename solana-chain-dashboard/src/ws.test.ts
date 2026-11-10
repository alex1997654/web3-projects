import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SolanaFeed, type FeedStatus } from './ws'
import { PUMP_FUN_PROGRAM_ID } from './programs'

class FakeWebSocket {
  readonly sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  open(): void {
    this.onopen?.()
  }

  message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
}

function notification(slot: number, signature: string, logs: string[], err: unknown = null): unknown {
  return {
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: { subscription: 0, result: { context: { slot }, value: { signature, err, logs } } },
  }
}

describe('SolanaFeed', () => {
  let sockets: FakeWebSocket[]
  let statuses: FeedStatus[]
  let notices: string[]
  let notifications: { slot: number; signature: string; err: boolean; logs: readonly string[] }[]
  let feed: SolanaFeed

  const latestStatus = (): FeedStatus => statuses[statuses.length - 1]!

  function makeFeed(overrides: Partial<ConstructorParameters<typeof SolanaFeed>[0]> = {}): SolanaFeed {
    return new SolanaFeed({
      endpoint: 'wss://example.invalid',
      programId: PUMP_FUN_PROGRAM_ID,
      commitment: 'confirmed',
      stallTimeoutMs: 15_000,
      onStatus: (s) => statuses.push(s),
      onNotification: (n) => notifications.push(n),
      onNotice: (m) => notices.push(m),
      socketFactory: () => {
        const sock = new FakeWebSocket()
        sockets.push(sock)
        return sock as unknown as WebSocket
      },
      ...overrides,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    sockets = []
    statuses = []
    notices = []
    notifications = []
  })

  afterEach(() => {
    feed?.stop()
    vi.useRealTimers()
  })

  function connectThroughAck(index: number): void {
    sockets[index]!.open()
    sockets[index]!.message({ jsonrpc: '2.0', id: 1, result: 0 })
  }

  it('subscribes on open and goes live on the ack', () => {
    feed = makeFeed()
    feed.start()
    expect(latestStatus()).toEqual({ state: 'connecting' })
    connectThroughAck(0)
    expect(latestStatus()).toEqual({ state: 'live', slot: null })
    const sent = JSON.parse(sockets[0]!.sent[0]!) as { method: string; params: unknown[] }
    expect(sent.method).toBe('logsSubscribe')
    expect(sent.params[0]).toEqual({ mentions: [PUMP_FUN_PROGRAM_ID] })
    expect(sent.params[1]).toEqual({ commitment: 'confirmed' })
  })

  it('emits notifications with slot, signature, and err flag', () => {
    feed = makeFeed()
    feed.start()
    connectThroughAck(0)
    sockets[0]!.message(notification(1234, 'sigA', ['Program log: x']))
    sockets[0]!.message(notification(1236, 'sigB', ['Program log: y'], { InstructionError: [0, { Custom: 1 }] }))
    expect(notifications).toEqual([
      { slot: 1234, signature: 'sigA', err: false, logs: ['Program log: x'] },
      { slot: 1236, signature: 'sigB', err: true, logs: ['Program log: y'] },
    ])
  })

  it('reconnects with attempt 1 after an early drop', () => {
    feed = makeFeed()
    feed.start()
    connectThroughAck(0)
    sockets[0]!.close()
    const st = latestStatus()
    expect(st.state).toBe('reconnecting')
    if (st.state === 'reconnecting') expect(st.attempt).toBe(1)
    // attempt 1 delay is [500, 1000) ms; advancing 1.2s must fire exactly one reconnect
    vi.advanceTimersByTime(1_200)
    expect(sockets).toHaveLength(2)
    expect(latestStatus()).toEqual({ state: 'connecting' })
  })

  it('backs off longer on consecutive unstable drops', () => {
    feed = makeFeed()
    feed.start()
    connectThroughAck(0)
    sockets[0]!.close() // attempt 1
    vi.advanceTimersByTime(1_200)
    connectThroughAck(1)
    sockets[1]!.close() // opened and closed within 10s: still unstable, attempt 2
    const st = latestStatus()
    expect(st.state).toBe('reconnecting')
    if (st.state !== 'reconnecting') return
    expect(st.attempt).toBe(2)
    // attempt 2 delay: base 1000 * 2^1, jitter [0.5, 1.0) -> [1000, 2000)
    const now = Date.now()
    const wait = st.retryAtMs - now
    expect(wait).toBeGreaterThanOrEqual(1000)
    expect(wait).toBeLessThan(2000)
  })

  it('resets the ladder when a connection stayed healthy for 10s', () => {
    feed = makeFeed()
    feed.start()
    connectThroughAck(0)
    vi.advanceTimersByTime(11_000)
    sockets[0]!.close() // stable -> attempt resets to 1
    let st = latestStatus()
    if (st.state !== 'reconnecting') throw new Error('expected reconnecting')
    expect(st.attempt).toBe(1)
    vi.advanceTimersByTime(1_200)
    connectThroughAck(1)
    vi.advanceTimersByTime(11_000)
    sockets[1]!.close() // stable again -> still attempt 1
    st = latestStatus()
    if (st.state !== 'reconnecting') throw new Error('expected reconnecting')
    expect(st.attempt).toBe(1)
  })

  it('treats a rate-limit style rpc error as a drop: notice, close, backoff', () => {
    feed = makeFeed()
    feed.start()
    connectThroughAck(0)
    sockets[0]!.message({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too Many Requests: logsSubscribe' } })
    expect(notices.some((n) => n.includes('rpc error') && n.includes('Too Many Requests'))).toBe(true)
    expect(sockets[0]!.closed).toBe(true)
    expect(latestStatus().state).toBe('reconnecting')
  })

  it('force-closes a stalled connection and reconnects', () => {
    feed = makeFeed()
    feed.start()
    connectThroughAck(0)
    vi.advanceTimersByTime(20_000)
    expect(notices.some((n) => n.includes('forcing reconnect'))).toBe(true)
    expect(sockets[0]!.closed).toBe(true)
    expect(latestStatus().state).toBe('reconnecting')
  })

  it('does not stall-force when stallTimeoutMs is 0', () => {
    feed = makeFeed({ stallTimeoutMs: 0 })
    feed.start()
    connectThroughAck(0)
    vi.advanceTimersByTime(120_000)
    expect(sockets[0]!.closed).toBe(false)
  })

  it('keeps a stalled connection alive while messages still arrive', () => {
    feed = makeFeed()
    feed.start()
    connectThroughAck(0)
    for (let t = 0; t < 60_000; t += 5_000) {
      sockets[0]!.message(notification(t, 'sig' + t, ['Program log: keepalive']))
      vi.advanceTimersByTime(5_000)
    }
    expect(sockets[0]!.closed).toBe(false)
    expect(latestStatus().state).toBe('live')
  })

  it('invalid endpoint url surfaces a notice and schedules a retry', () => {
    feed = makeFeed({ socketFactory: () => { throw new SyntaxError('invalid url') } })
    feed.start()
    expect(notices.some((n) => n.includes('invalid endpoint URL'))).toBe(true)
    expect(latestStatus().state).toBe('reconnecting')
  })

  it('stop() goes idle and never reconnects again', () => {
    feed = makeFeed()
    feed.start()
    connectThroughAck(0)
    sockets[0]!.close()
    feed.stop()
    expect(latestStatus()).toEqual({ state: 'idle' })
    vi.advanceTimersByTime(300_000)
    expect(sockets).toHaveLength(1)
  })
})

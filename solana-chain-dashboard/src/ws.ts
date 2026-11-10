import { backoffDelayMs } from './backoff'

export type FeedStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'connecting' }
  | { readonly state: 'live'; readonly slot: number | null }
  | { readonly state: 'reconnecting'; readonly attempt: number; readonly retryAtMs: number }

export interface LogNotification {
  readonly slot: number
  readonly signature: string
  readonly err: boolean
  readonly logs: readonly string[]
}

export interface FeedOptions {
  readonly endpoint: string
  readonly programId: string
  readonly commitment: 'confirmed' | 'finalized'
  readonly stallTimeoutMs: number
  readonly onStatus: (status: FeedStatus) => void
  readonly onNotification: (n: LogNotification) => void
  readonly onNotice: (message: string) => void
  /** Injectable for tests and the reconnect verification script; the
   * default is the browser WebSocket. */
  readonly socketFactory?: (url: string) => WebSocket
}

// A connection that survived this long counts as healthy, so the next
// failure restarts the backoff ladder from the bottom.
const STABLE_CONNECTION_MS = 10_000
const STALL_TICK_MS = 5_000

interface RpcMessage {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
  params?: {
    subscription?: number
    result?: {
      context?: { slot?: number }
      value?: { signature?: string; err?: unknown; logs?: string[] }
    }
  }
}

/**
 * logsSubscribe over a raw WebSocket against one endpoint. No endpoint
 * list, no failover: on drop or rate-limit error it reconnects the same
 * URL with jittered exponential backoff, and reports every state change
 * so the UI can show what is happening instead of silently degrading.
 * A stall timer closes connections that stay open but stop delivering,
 * which is how public endpoints usually behave under load.
 */
export class SolanaFeed {
  private ws: WebSocket | null = null
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private stallTimer: ReturnType<typeof setInterval> | null = null
  private lastMessageAt = 0
  private openedAt = 0
  private stopped = true
  private lastSlot: number | null = null

  constructor(private readonly opts: FeedOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.teardown()
    this.opts.onStatus({ state: 'idle' })
  }

  private teardown(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer)
      this.stallTimer = null
    }
    if (this.ws !== null) {
      const ws = this.ws
      this.ws = null
      ws.onclose = null
      ws.onmessage = null
      ws.onopen = null
      ws.onerror = null
      ws.close()
    }
  }

  private connect(): void {
    this.opts.onStatus({ state: 'connecting' })
    const factory = this.opts.socketFactory ?? ((url: string) => new WebSocket(url))
    let ws: WebSocket
    try {
      ws = factory(this.opts.endpoint)
    } catch (e) {
      this.opts.onNotice('invalid endpoint URL: ' + (e instanceof Error ? e.message : String(e)))
      this.scheduleReconnect()
      return
    }
    this.openedAt = Date.now()
    this.lastMessageAt = this.openedAt
    this.ws = ws
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [this.opts.programId] }, { commitment: this.opts.commitment }],
        }),
      )
    }
    ws.onmessage = (ev: MessageEvent) => this.handleFrame(String(ev.data))
    ws.onerror = () => {
      // onclose always follows; nothing to do here.
    }
    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return
      this.ws = null
      if (this.stallTimer !== null) {
        clearInterval(this.stallTimer)
        this.stallTimer = null
      }
      this.scheduleReconnect()
    }
    this.stallTimer = setInterval(() => this.stallTick(), STALL_TICK_MS)
  }

  private scheduleReconnect(): void {
    const stable = Date.now() - this.openedAt >= STABLE_CONNECTION_MS
    this.attempt = stable ? 1 : this.attempt + 1
    const delay = backoffDelayMs(this.attempt)
    const retryAtMs = Date.now() + delay
    this.opts.onStatus({ state: 'reconnecting', attempt: this.attempt, retryAtMs })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.connect()
    }, delay)
  }

  private stallTick(): void {
    if (this.stopped || this.ws === null) return
    if (this.opts.stallTimeoutMs <= 0) return
    const quietFor = Date.now() - this.lastMessageAt
    if (quietFor > this.opts.stallTimeoutMs) {
      this.opts.onNotice('no messages for ' + Math.round(quietFor / 1000) + 's, forcing reconnect')
      this.ws.close()
    }
  }

  private handleFrame(text: string): void {
    this.lastMessageAt = Date.now()
    let msg: RpcMessage
    try {
      msg = JSON.parse(text) as RpcMessage
    } catch {
      return
    }

    if (msg.method === 'logsNotification') {
      const value = msg.params?.result?.value
      if (value?.signature === undefined || value.logs === undefined) return
      this.lastSlot = msg.params?.result?.context?.slot ?? this.lastSlot
      this.opts.onNotification({
        slot: this.lastSlot ?? 0,
        signature: value.signature,
        err: value.err != null,
        logs: value.logs,
      })
      return
    }

    if (msg.id === 1 && msg.result !== undefined) {
      this.opts.onStatus({ state: 'live', slot: this.lastSlot })
      return
    }

    if (msg.error !== undefined) {
      this.opts.onNotice('rpc error: ' + (msg.error.message ?? JSON.stringify(msg.error)))
      this.ws?.close()
    }
  }
}

/*
 * Live reconnect verification. Runs SolanaFeed against a public Solana
 * endpoint, waits until it is live and has received a notification, then
 * force-closes the underlying socket mid-stream and requires the feed to
 * reach 'reconnecting' and recover to 'live' with further notifications,
 * all within the timeout. Exits non-zero on any miss.
 *
 *   npm run verify:reconnect [endpoint]
 */
import WebSocket from 'ws'
import { SolanaFeed, type FeedStatus } from '../src/ws'
import { PUMP_FUN_PROGRAM_ID } from '../src/programs'

const endpoint = process.argv[2] ?? 'wss://api.mainnet-beta.solana.com'
const TIMEOUT_MS = 120_000

let current: WsAdapter | null = null
const t0 = Date.now()
const at = (): string => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's'

function finish(ok: boolean, why: string): never {
  console.log(at(), ok ? 'PASS:' : 'FAIL:', why)
  process.exit(ok ? 0 : 1)
}

const timer = setTimeout(() => finish(false, 'timeout before full recovery'), TIMEOUT_MS)

let liveCount = 0
let notificationCount = 0
let notificationsAfterRecovery = 0
let dropped = false
let sawReconnecting = false

class WsAdapter {
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null

  constructor(private readonly sock: WebSocket) {
    sock.on('open', () => this.onopen?.())
    sock.on('message', (raw: WebSocket.RawData) => this.onmessage?.({ data: String(raw) }))
    sock.on('close', () => this.onclose?.())
    sock.on('error', () => this.onerror?.())
  }

  send(data: string): void {
    this.sock.send(data)
  }

  close(): void {
    this.sock.close()
  }
}

const feed = new SolanaFeed({
  endpoint,
  programId: PUMP_FUN_PROGRAM_ID,
  commitment: 'confirmed',
  stallTimeoutMs: 45_000,
  socketFactory: (url) => {
    current = new WsAdapter(new WebSocket(url))
    return current as unknown as WebSocket
  },
  onStatus: (s: FeedStatus) => {
    console.log(at(), 'status:', JSON.stringify(s))
    if (s.state === 'live') {
      liveCount++
      if (liveCount === 1) console.log(at(), 'first live: waiting for a notification before forcing the drop')
      if (liveCount === 2) console.log(at(), 'recovered to live')
    }
    if (s.state === 'reconnecting' && dropped) sawReconnecting = true
  },
  onNotification: () => {
    notificationCount++
    if (dropped && liveCount >= 2) {
      notificationsAfterRecovery++
      if (sawReconnecting && notificationsAfterRecovery >= 1) {
        clearTimeout(timer)
        feed.stop()
        finish(true, 'drop -> reconnecting -> live -> notification, attempt ladder observed: ' + notificationCount + ' notifications total')
      }
    } else if (!dropped && notificationCount === 1) {
      dropped = true
      console.log(at(), 'forcing socket drop after first notification')
      current?.close()
    }
  },
  onNotice: (m) => console.log(at(), 'notice:', m),
})

console.log(at(), 'endpoint:', endpoint)
feed.start()
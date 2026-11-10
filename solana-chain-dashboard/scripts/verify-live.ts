/*
 * Live layout validation. Connects to a public Solana WS endpoint,
 * subscribes to pump.fun logs, and runs every received Program data
 * payload through the decoder. Exits non-zero if more than a third of
 * data events fail to decode, which usually means the on-chain program
 * was upgraded and src/programs.ts needs a new layout variant.
 *
 *   npm run verify:live [endpoint]
 */
import WebSocket from 'ws'
import { PUMP_FUN } from '../src/programs'
import { parseLogMessages } from '../src/decoder'
import type { ProgramDef } from '../src/programs'

const endpoint = process.argv[2] ?? 'wss://api.mainnet-beta.solana.com'
const program: ProgramDef = PUMP_FUN
const TARGET = 40
const TIMEOUT_MS = 90_000

console.log('endpoint:', endpoint)
console.log('program :', program.id, '(' + program.label + ')')
console.log('collecting', TARGET, 'transactions with Program data lines...')

let known = 0
let unknown = 0
const reasons = new Map<string, number>()
let txSeen = 0

const ws = new WebSocket(endpoint)
const timer = setTimeout(() => finish('timeout before collecting enough data'), TIMEOUT_MS)

ws.on('open', () => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [program.id] }, { commitment: 'confirmed' }] }))
})

ws.on('message', (raw: WebSocket.RawData) => {
  const msg = JSON.parse(String(raw)) as {
    method?: string
    params?: { result?: { value?: { signature?: string; logs?: string[] } } }
  }
  const value = msg.params?.result?.value
  if (msg.method !== 'logsNotification' || value?.logs === undefined) return
  txSeen++
  let hadData = false
  for (const item of parseLogMessages(value.logs, program)) {
    if (item.type !== 'data') continue
    hadData = true
    if (item.event.kind === 'known') {
      known++
    } else {
      unknown++
      const key = (item.event.discriminator ?? 'null') + ' | ' + item.event.reason
      reasons.set(key, (reasons.get(key) ?? 0) + 1)
    }
  }
  if (hadData && known + unknown >= TARGET) finish('collected enough')
})

ws.on('error', (err: Error) => {
  console.error('ws error:', err.message)
  finish('connection error', 1)
})

function finish(why: string, forcedCode?: number): void {
  clearTimeout(timer)
  try {
    ws.close()
  } catch {
    // already closed
  }
  const total = known + unknown
  console.log('---')
  console.log('tx seen:', txSeen, ' data events:', total, ' known:', known, ' unknown:', unknown)
  for (const [reason, count] of reasons) console.log('unknown x' + count + ':', reason)
  const code = forcedCode ?? (total === 0 || unknown / total > 0.34 ? 1 : 0)
  console.log(code === 0 ? 'PASS: layouts match the live program' : 'FAIL: ' + why + ' with too many undecoded events')
  process.exit(code)
}

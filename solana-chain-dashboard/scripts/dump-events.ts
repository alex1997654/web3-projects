/*
 * Maintenance utility: dump the next N 'Program data' payloads that the
 * watched program emits for a given event discriminator, as annotated hex.
 * Used to reverse-engineer layout changes after a program upgrade.
 *
 *   npm run dump -- <discriminatorHex|all> [count]
 */
import WebSocket from 'ws'
import { PUMP_FUN } from '../src/programs'
import { parseLogMessages } from '../src/decoder'
import type { ProgramDef } from '../src/programs'

const disc = process.argv[2] ?? 'all'
const count = Number(process.argv[3] ?? 3)
const endpoint = process.argv[4] ?? 'wss://api.mainnet-beta.solana.com'
const program: ProgramDef = PUMP_FUN

const ws = new WebSocket(endpoint)
let dumped = 0

ws.on('open', () => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [program.id] }, { commitment: 'confirmed' }] }))
})

ws.on('message', (raw: WebSocket.RawData) => {
  const msg = JSON.parse(String(raw)) as {
    method?: string
    params?: { result?: { value?: { logs?: string[] } } }
  }
  const logs = msg.params?.result?.value?.logs
  if (msg.method !== 'logsNotification' || logs === undefined) return
  for (const item of parseLogMessages(logs, program)) {
    if (item.type !== 'data') continue
    if (item.event.kind === 'unknown' && item.event.discriminator === null) continue
    const itemDisc = item.event.kind === 'unknown' ? item.event.discriminator : 'known-decode'
    if (disc !== 'all' && itemDisc !== disc && item.event.kind !== 'unknown') continue
    if (disc !== 'all' && itemDisc !== disc) continue
    const bytes = Buffer.from(item.payloadBase64, 'base64')
    console.log('---', itemDisc, 'reason:', item.event.kind === 'unknown' ? item.event.reason : 'decoded ok', 'len:', bytes.length)
    const body = bytes.subarray(8)
    for (let off = 0; off < body.length; off += 32) {
      const chunk = body.subarray(off, off + 32)
      console.log(off.toString(16).padStart(3, '0'), chunk.toString('hex').match(/.{1,8}/g)?.join(' '))
    }
    dumped++
    if (dumped >= count) {
      ws.close()
      process.exit(0)
    }
  }
})

ws.on('error', (err: Error) => {
  console.error('ws error:', err.message)
  process.exit(1)
})

setTimeout(() => {
  console.error('timeout waiting for matching events')
  process.exit(1)
}, 60_000)

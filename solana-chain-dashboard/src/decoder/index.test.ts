import { describe, expect, it } from 'vitest'
import { decodeAnchorEvent, decodeBase64, parseLogMessages } from './index'
import { base58Encode } from './base58'
import { PUMP_FUN, MEMO } from '../programs'

const TRADE_DISC = 'bddb7fd34ee661ee'
const CREATE_DISC = '1b72a94ddeeb6376'
const COMPLETE_DISC = '5f72619cd42e9808'

function discBytes(hexStr: string): Uint8Array {
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16)
  return out
}

function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn)
  return out
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) out[i] = (n >> (i * 8)) & 0xff
  return out
}

function str(s: string): Uint8Array {
  const body = new TextEncoder().encode(s)
  const out = new Uint8Array(4 + body.length)
  out.set(u32(body.length), 0)
  out.set(body, 4)
  return out
}

function boolByte(b: boolean): Uint8Array {
  return new Uint8Array([b ? 1 : 0])
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function b64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const mint = new Uint8Array(32).fill(3)
const user = new Uint8Array(32).fill(7)

function tradeBodyV2(): Uint8Array {
  return cat(
    mint,
    u64(500_000_000n), // 0.5 SOL in lamports
    u64(12_345_678n),
    boolByte(true),
    user,
    u64(1_730_000_000n), // timestamp
    u64(30_000_000_000n), // virtual sol reserves
    u64(1_000_000_000_000n), // virtual token reserves
  )
}

function tradeBodyV1(): Uint8Array {
  return cat(mint, u64(500_000_000n), u64(12_345_678n), boolByte(false), user, u64(1_730_000_000n))
}

describe('decodeAnchorEvent', () => {
  it('decodes the current TradeEvent layout with exact field values', () => {
    const payload = cat(discBytes(TRADE_DISC), tradeBodyV2())
    const ev = decodeAnchorEvent(payload, PUMP_FUN.layouts)
    expect(ev).toMatchObject({ kind: 'known', name: 'TradeEvent' })
    if (ev.kind !== 'known') return
    const byName = Object.fromEntries(ev.fields.map((f) => [f.name, f.value]))
    expect(byName['solAmount']).toBe(500_000_000n)
    expect(byName['tokenAmount']).toBe(12_345_678n)
    expect(byName['isBuy']).toBe(true)
    expect(byName['timestamp']).toBe(1_730_000_000n)
    expect(ev.tailBytes).toBeUndefined()
  })

  it('decodes the live program build via the v3 prefix layout and reports the tail', () => {
    // head + reserves + fee recipient (v3 mapped fields), then 40 unmapped bytes
    const feeRecipient = new Uint8Array(32).fill(5)
    const tail = new Uint8Array(40).fill(0xab)
    const payload = cat(discBytes(TRADE_DISC), tradeBodyV2(), u64(30_000_000_000n), u64(1_000_000_000_000n), feeRecipient, tail)
    const ev = decodeAnchorEvent(payload, PUMP_FUN.layouts)
    expect(ev).toMatchObject({ kind: 'known', name: 'TradeEvent' })
    if (ev.kind !== 'known') return
    const byName = Object.fromEntries(ev.fields.map((f) => [f.name, f.value]))
    expect(byName['realSolReserves']).toBe(30_000_000_000n)
    expect(byName['feeRecipient']).toBe(base58Encode(feeRecipient))
    expect(ev.tailBytes).toBe(40)
  })

  it('prefers an exact layout match over a prefix match', () => {
    const payload = cat(discBytes(TRADE_DISC), tradeBodyV1())
    const ev = decodeAnchorEvent(payload, PUMP_FUN.layouts)
    expect(ev).toMatchObject({ kind: 'known', name: 'TradeEvent' })
    if (ev.kind === 'known') expect(ev.tailBytes).toBeUndefined()
  })

  it('falls back to the older TradeEvent layout by exact length', () => {
    const payload = cat(discBytes(TRADE_DISC), tradeBodyV1())
    const ev = decodeAnchorEvent(payload, PUMP_FUN.layouts)
    expect(ev).toMatchObject({ kind: 'known', name: 'TradeEvent' })
    if (ev.kind !== 'known') return
    expect(ev.fields.some((f) => f.name === 'virtualSolReserves')).toBe(false)
    expect(ev.fields.find((f) => f.name === 'isBuy')?.value).toBe(false)
  })

  it('reports unknown when no layout matches the discriminator', () => {
    const payload = cat(new Uint8Array(8).fill(0xab), tradeBodyV2())
    const ev = decodeAnchorEvent(payload, PUMP_FUN.layouts)
    expect(ev.kind).toBe('unknown')
    if (ev.kind === 'unknown') {
      expect(ev.discriminator).toBe('abababababababab')
      expect(ev.reason).toContain('no layout registered')
    }
  })

  it('reports unknown when every variant leaves trailing bytes', () => {
    const padded = cat(tradeBodyV2(), u64(999n))
    const ev = decodeAnchorEvent(cat(discBytes(TRADE_DISC), padded), PUMP_FUN.layouts)
    expect(ev.kind).toBe('unknown')
    if (ev.kind === 'unknown') expect(ev.reason).toContain('bytes unconsumed')
  })

  it('rejects payloads shorter than a discriminator', () => {
    const ev = decodeAnchorEvent(new Uint8Array(5), PUMP_FUN.layouts)
    expect(ev.kind).toBe('unknown')
    if (ev.kind === 'unknown') expect(ev.reason).toContain('shorter')
  })

  it('decodes CreateEvent with strings and both pubkey sets', () => {
    const body = cat(
      str('test token'),
      str('TST'),
      str('https://example.invalid/m.json'),
      mint,
      new Uint8Array(32).fill(1), // bonding curve
      user,
      new Uint8Array(32).fill(9), // creator
      u64(1_730_000_000n),
      u64(1_073_000_000_000n),
      u64(30_000_000_000n),
      u64(793_100_000_000_000n),
    )
    const ev = decodeAnchorEvent(cat(discBytes(CREATE_DISC), body), PUMP_FUN.layouts)
    expect(ev).toMatchObject({ kind: 'known', name: 'CreateEvent' })
    if (ev.kind !== 'known') return
    const byName = Object.fromEntries(ev.fields.map((f) => [f.name, f.value]))
    expect(byName['name']).toBe('test token')
    expect(byName['symbol']).toBe('TST')
    expect(byName['realTokenReserves']).toBe(793_100_000_000_000n)
  })

  it('decodes both CompleteEvent variants', () => {
    const v2 = cat(discBytes(COMPLETE_DISC), mint, new Uint8Array(32).fill(1), user, u64(5n))
    expect(decodeAnchorEvent(v2, PUMP_FUN.layouts)).toMatchObject({ kind: 'known', name: 'CompleteEvent' })
    const v1 = cat(discBytes(COMPLETE_DISC), mint, new Uint8Array(32).fill(1), user)
    const ev = decodeAnchorEvent(v1, PUMP_FUN.layouts)
    expect(ev).toMatchObject({ kind: 'known', name: 'CompleteEvent' })
    if (ev.kind === 'known') expect(ev.fields).toHaveLength(3)
  })

  it('handles a program with no registered layouts', () => {
    const payload = cat(discBytes(TRADE_DISC), tradeBodyV2())
    const ev = decodeAnchorEvent(payload, MEMO.layouts)
    expect(ev.kind).toBe('unknown')
  })
})

describe('parseLogMessages', () => {
  it('extracts instruction names, data events, and plain logs', () => {
    const logs = [
      'Program ' + PUMP_FUN.id + ' invoke [1]',
      'Program log: Instruction: Buy',
      'Program data: ' + b64(cat(discBytes(TRADE_DISC), tradeBodyV2())),
      'Program log: Trade routed',
      'Program ' + PUMP_FUN.id + ' consumed 12345 of 200000 compute units',
      'Program ' + PUMP_FUN.id + ' success',
    ]
    const items = parseLogMessages(logs, PUMP_FUN)
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({ type: 'instruction', name: 'Buy' })
    expect(items[1]?.type).toBe('data')
    expect(items[2]).toEqual({ type: 'log', text: 'Trade routed' })
  })

  it('ignores data and log lines emitted by other programs in the same tx', () => {
    const other = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
    const logs = [
      'Program ' + PUMP_FUN.id + ' invoke [1]',
      'Program log: Instruction: Buy',
      'Program ' + other + ' invoke [2]',
      'Program log: Instruction: Route',
      'Program data: ' + b64(cat(new Uint8Array(8).fill(0xcd), u64(1n))),
      'Program ' + other + ' success',
      'Program data: ' + b64(cat(discBytes(TRADE_DISC), tradeBodyV2())),
      'Program ' + PUMP_FUN.id + ' failed: custom program error: 0x1',
    ]
    const items = parseLogMessages(logs, PUMP_FUN)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ type: 'instruction', name: 'Buy' })
    const second = items[1]
    if (second?.type !== 'data') throw new Error('expected pump data item')
    expect(second.event.kind).toBe('known')
  })

  it('attributes lines after the watched program returns to nobody', () => {
    const logs = [
      'Program ' + PUMP_FUN.id + ' invoke [1]',
      'Program ' + PUMP_FUN.id + ' success',
      'Program data: ' + b64(cat(discBytes(TRADE_DISC), tradeBodyV2())),
    ]
    expect(parseLogMessages(logs, PUMP_FUN)).toEqual([])
  })

  it('returns the memo text as a log item', () => {
    const items = parseLogMessages(
      ['Program ' + MEMO.id + ' invoke [1]', 'Program log: gm from the test fixture', 'Program ' + MEMO.id + ' success'],
      MEMO,
    )
    expect(items).toEqual([{ type: 'log', text: 'gm from the test fixture' }])
  })

  it('flags invalid base64 as unknown rather than throwing', () => {
    const items = parseLogMessages(
      ['Program ' + PUMP_FUN.id + ' invoke [1]', 'Program data: !!!not-base64!!!', 'Program ' + PUMP_FUN.id + ' success'],
      PUMP_FUN,
    )
    expect(items).toHaveLength(1)
    const item = items[0]
    if (item?.type === 'data') {
      expect(item.event.kind).toBe('unknown')
      if (item.event.kind === 'unknown') expect(item.event.reason).toContain('base64')
    } else {
      throw new Error('expected data item')
    }
  })
})

describe('decodeBase64', () => {
  it('round-trips bytes', () => {
    const bytes = discBytes(TRADE_DISC)
    expect(decodeBase64(b64(bytes))).toEqual(bytes)
  })
})

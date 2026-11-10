import { describe, expect, it } from 'vitest'
import { BorshError, BorshReader } from './borsh'

function le(n: bigint, bytes = 8): Uint8Array {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn)
  return out
}

describe('BorshReader', () => {
  it('reads u64 little-endian', () => {
    const r = new BorshReader(le(1_000_000_000n))
    expect(r.u64()).toBe(1_000_000_000n)
    expect(r.remaining).toBe(0)
  })

  it('reads max u64', () => {
    const r = new BorshReader(le(0xffffffffffffffffn))
    expect(r.u64()).toBe(18446744073709551615n)
  })

  it('decodes negative i64 via two-complement', () => {
    const r = new BorshReader(le(0xffffffffffffffc4n))
    expect(r.i64()).toBe(-60n)
  })

  it('reads bool as one nonzero byte', () => {
    expect(new BorshReader(new Uint8Array([1])).bool()).toBe(true)
    expect(new BorshReader(new Uint8Array([0])).bool()).toBe(false)
  })

  it('reads u32-length-prefixed utf8 strings', () => {
    const text = new TextEncoder().encode('wif')
    const buf = new Uint8Array(4 + text.length)
    new DataView(buf.buffer).setUint32(0, text.length, true)
    buf.set(text, 4)
    expect(new BorshReader(buf).string()).toBe('wif')
  })

  it('renders 32-byte pubkeys as base58', () => {
    expect(new BorshReader(new Uint8Array(32)).pubkey()).toBe('1'.repeat(32))
  })

  it('throws on truncated reads', () => {
    const r = new BorshReader(new Uint8Array(3))
    expect(() => r.u64()).toThrow(BorshError)
  })

  it('throws when a string length exceeds the buffer', () => {
    const buf = new Uint8Array(8)
    new DataView(buf.buffer).setUint32(0, 1_000, true)
    expect(() => new BorshReader(buf).string()).toThrow(BorshError)
  })
})

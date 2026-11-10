import { describe, expect, it } from 'vitest'
import { base58Encode } from './base58'

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('base58Encode', () => {
  it('encodes empty input as empty string', () => {
    expect(base58Encode(new Uint8Array([]))).toBe('')
  })

  it('encodes leading zero bytes as 1s', () => {
    expect(base58Encode(new Uint8Array([0]))).toBe('1')
    expect(base58Encode(new Uint8Array([0, 0, 0]))).toBe('111')
  })

  it('matches the bitcoin wiki vector for hello world', () => {
    const bytes = new TextEncoder().encode('hello world')
    expect(base58Encode(bytes)).toBe('StV1DL6CwTryKyV')
  })

  it('matches the 21-byte bitcoin address vector', () => {
    const bytes = hexToBytes('00010966776006953D5567439E5E39F86A0D273BEED61967F6')
    expect(base58Encode(bytes)).toBe('16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM')
  })

  it('round-trips a known Solana address length', () => {
    // sha256('x') bytes, arbitrary but fixed 32-byte input
    const bytes = hexToBytes('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881')
    const enc = base58Encode(bytes)
    expect(enc.length).toBeGreaterThanOrEqual(32)
    expect(enc).not.toMatch(/[0OIl]/)
  })
})

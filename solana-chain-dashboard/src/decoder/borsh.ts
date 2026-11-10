import { base58Encode } from './base58'

const textDecoder = new TextDecoder('utf-8')
const TWO_63 = 1n << 63n
const TWO_64 = 1n << 64n

export class BorshError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BorshError'
  }
}

function leBigInt(bytes: Uint8Array): bigint {
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!)
  return v
}

/**
 * Cursor over a byte buffer with the Anchor/borsh primitive encodings:
 * little-endian integers, 1-byte bools, u32-length-prefixed utf8 strings,
 * and 32-byte public keys rendered as base58 addresses. Every read either
 * succeeds and advances, or throws; 'remaining' lets callers enforce that
 * a layout consumed the buffer exactly.
 */
export class BorshReader {
  private pos = 0

  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos
  }

  private take(n: number): Uint8Array {
    if (this.remaining < n) {
      throw new BorshError('truncated read: need ' + n + ' bytes, ' + this.remaining + ' left')
    }
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  u8(): number {
    return this.take(1)[0]!
  }

  bool(): boolean {
    return this.take(1)[0]! !== 0
  }

  u32(): number {
    return Number(leBigInt(this.take(4)))
  }

  u64(): bigint {
    return leBigInt(this.take(8))
  }

  i64(): bigint {
    const raw = leBigInt(this.take(8))
    return raw >= TWO_63 ? raw - TWO_64 : raw
  }

  pubkey(): string {
    return base58Encode(this.take(32))
  }

  string(): string {
    const len = this.u32()
    if (len > 1_048_576) {
      throw new BorshError('implausible string length ' + len)
    }
    return textDecoder.decode(this.take(len))
  }
}

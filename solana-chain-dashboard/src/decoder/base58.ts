const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * Base58 (Bitcoin alphabet) encoding of raw bytes. Used to render decoded
 * 32-byte public keys as Solana addresses. Decode is not needed anywhere,
 * so it is deliberately absent.
 */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  const digits: number[] = []
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8
      digits[j]! = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let out = '1'.repeat(zeros)
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!]
  return out
}

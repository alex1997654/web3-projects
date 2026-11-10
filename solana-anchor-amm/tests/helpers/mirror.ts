// Pure BigInt mirror of the on-chain math in programs/amm/src/math.rs.
// Rounding contract: fee rounds up (ceiling), swap output, LP mint, and
// withdrawal outputs round down (floor), so rounding always favors the pool.

export const FEE_BPS = 25n;
export const BPS_DENOMINATOR = 10_000n;
export const MIN_INITIAL_LP = 1_000n;
export const LP_DECIMALS = 6;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

// Mirrors the u64 domain the Rust functions take; catches test-side mistakes
// where a value silently exceeded what the program could ever receive.
function assertU64(value: bigint, label: string): void {
  if (value < 0n || value > U64_MAX) {
    throw new Error(`${label} outside u64 range: ${value}`);
  }
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error(`floorDiv denominator must be positive: ${denominator}`);
  }
  return numerator / denominator;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error(`ceilDiv denominator must be positive: ${denominator}`);
  }
  return (numerator + denominator - 1n) / denominator;
}

export function isqrtU128(x: bigint): bigint {
  if (x < 0n || x > U128_MAX) {
    throw new Error(`isqrtU128 input outside u128 range: ${x}`);
  }
  if (x < 2n) {
    return x;
  }
  // Newton iteration seeded above the root; the loop settles exactly at floor(sqrt(x)).
  let r = 1n << BigInt(Math.ceil(x.toString(2).length / 2));
  let next = (r + x / r) >> 1n;
  while (next < r) {
    r = next;
    next = (r + x / r) >> 1n;
  }
  return r;
}

export function feeAmount(amountIn: bigint): bigint {
  assertU64(amountIn, "amount_in");
  return ceilDiv(amountIn * FEE_BPS, BPS_DENOMINATOR);
}

export function computeAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): bigint {
  assertU64(amountIn, "amount_in");
  assertU64(reserveIn, "reserve_in");
  assertU64(reserveOut, "reserve_out");
  const afterFee = amountIn - feeAmount(amountIn);
  if (afterFee === 0n) {
    return 0n;
  }
  const out = floorDiv(afterFee * reserveOut, reserveIn + afterFee);
  assertU64(out, "amount_out");
  return out;
}

export function computeLpFirstLiquidity(base: bigint, quote: bigint): bigint {
  assertU64(base, "base");
  assertU64(quote, "quote");
  const lp = isqrtU128(base * quote);
  if (lp < MIN_INITIAL_LP) {
    throw new Error(`InsufficientInitialLiquidity: lp ${lp} < ${MIN_INITIAL_LP}`);
  }
  return lp;
}

export function computeLpMint(
  base: bigint,
  quote: bigint,
  rBase: bigint,
  rQuote: bigint,
  supply: bigint,
): bigint {
  assertU64(base, "base");
  assertU64(quote, "quote");
  assertU64(rBase, "r_base");
  assertU64(rQuote, "r_quote");
  assertU64(supply, "supply");
  if (supply === 0n) {
    return computeLpFirstLiquidity(base, quote);
  }
  const byBase = floorDiv(base * supply, rBase);
  const byQuote = floorDiv(quote * supply, rQuote);
  return byBase < byQuote ? byBase : byQuote;
}

export function computeWithdrawAmounts(
  lp: bigint,
  supply: bigint,
  rBase: bigint,
  rQuote: bigint,
): [bigint, bigint] {
  assertU64(lp, "lp");
  assertU64(supply, "supply");
  assertU64(rBase, "r_base");
  assertU64(rQuote, "r_quote");
  return [floorDiv(lp * rBase, supply), floorDiv(lp * rQuote, supply)];
}

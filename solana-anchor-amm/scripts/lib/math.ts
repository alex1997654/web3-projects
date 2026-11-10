// BigInt mirror of programs/amm/src/math.rs per SPEC.md. All values are BigInt
// and u64 range is enforced at the edges. No floats, no Number math.

export const FEE_BPS = 25n;
export const BPS_DENOMINATOR = 10_000n;
export const MIN_INITIAL_LP = 1_000n;
export const LP_DECIMALS = 6;
export const U64_MAX = (1n << 64n) - 1n;

export function assertU64(x: bigint, name: string): void {
  if (x < 0n || x > U64_MAX) {
    throw new Error(`${name} out of u64 range: ${x}`);
  }
}

// Floor integer square root, exact over the full u128 range (binary search).
export function isqrtU128(x: bigint): bigint {
  if (x < 0n) {
    throw new Error(`isqrt_u128 negative input: ${x}`);
  }
  if (x < 2n) {
    return x;
  }
  let lo = 1n;
  let hi = x;
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    if (mid * mid <= x) {
      lo = mid;
    } else {
      hi = mid - 1n;
    }
  }
  return lo;
}

// CEIL(amount_in * FEE_BPS / BPS_DENOMINATOR).
export function feeAmount(amountIn: bigint): bigint {
  assertU64(amountIn, "amount_in");
  const num = amountIn * FEE_BPS;
  return (num + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}

// FLOOR((amount_in - fee) * reserve_out / (reserve_in + amount_in - fee)).
export function computeAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  assertU64(amountIn, "amount_in");
  assertU64(reserveIn, "reserve_in");
  assertU64(reserveOut, "reserve_out");
  const aif = amountIn - feeAmount(amountIn);
  return (aif * reserveOut) / (reserveIn + aif);
}

// FLOOR(isqrt(base * quote)); the first-liquidity branch requires >= MIN_INITIAL_LP.
export function computeLpFirstLiquidity(base: bigint, quote: bigint): bigint {
  assertU64(base, "base");
  assertU64(quote, "quote");
  const lp = isqrtU128(base * quote);
  if (lp < MIN_INITIAL_LP) {
    throw new Error(`InsufficientInitialLiquidity: lp ${lp} below minimum ${MIN_INITIAL_LP}`);
  }
  return lp;
}

// supply == 0 -> first-liquidity branch; otherwise the min of the two floor ratios.
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
  if (rBase === 0n || rQuote === 0n) {
    throw new Error("InsufficientLiquidity: reserve is zero while lp supply is nonzero");
  }
  const byBase = (base * supply) / rBase;
  const byQuote = (quote * supply) / rQuote;
  return byBase <= byQuote ? byBase : byQuote;
}

// Both outputs floor; mirrors compute_withdraw_amounts.
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
  if (supply === 0n) {
    throw new Error("InsufficientLiquidity: lp supply is zero");
  }
  return [(lp * rBase) / supply, (lp * rQuote) / supply];
}

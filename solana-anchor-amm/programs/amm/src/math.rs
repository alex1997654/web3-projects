use crate::errors::AmmError;
use anchor_lang::prelude::*;

pub const FEE_BPS: u64 = 25;
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MIN_INITIAL_LP: u64 = 1_000;
pub const LP_DECIMALS: u8 = 6;

// Ceiling division of a by b, for b != 0.
fn ceil_div(a: u128, b: u128) -> u128 {
    if a == 0 {
        return 0;
    }
    1 + (a - 1) / b
}

// Protocol fee taken from a swap input, rounded up so the pool never loses
// sub-denominator dust to rounding.
pub fn fee_amount(amount_in: u64) -> Result<u64> {
    let fee = ceil_div(
        (amount_in as u128) * (FEE_BPS as u128),
        BPS_DENOMINATOR as u128,
    );
    u64::try_from(fee).map_err(|_| error!(AmmError::Overflow))
}

// Constant-product output for an exact-in swap, rounded down. Every
// intermediate is a product or sum of at most two u64 values plus a floor
// division, so u128 cannot overflow. The final narrowing back to u64 is the
// only Overflow site.
pub fn compute_amount_out(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    let fee = fee_amount(amount_in)? as u128;
    let amount_in_after_fee = (amount_in as u128)
        .checked_sub(fee)
        .ok_or(error!(AmmError::Overflow))?;
    let numerator = amount_in_after_fee
        .checked_mul(reserve_out as u128)
        .ok_or(error!(AmmError::Overflow))?;
    let denominator = (reserve_in as u128)
        .checked_add(amount_in_after_fee)
        .ok_or(error!(AmmError::Overflow))?;
    let out = numerator / denominator;
    u64::try_from(out).map_err(|_| error!(AmmError::Overflow))
}

// LP minted for the first deposit: floor of the geometric mean. The
// MIN_INITIAL_LP floor blocks the first-depositor share-dilution attack.
pub fn compute_lp_first_liquidity(base_amount: u64, quote_amount: u64) -> Result<u64> {
    let product = (base_amount as u128)
        .checked_mul(quote_amount as u128)
        .ok_or(error!(AmmError::Overflow))?;
    let lp = isqrt_u128(product);
    if lp < MIN_INITIAL_LP as u128 {
        return Err(error!(AmmError::InsufficientInitialLiquidity));
    }
    u64::try_from(lp).map_err(|_| error!(AmmError::Overflow))
}

// LP minted for a deposit into any pool state, first deposit included. With
// existing supply the deposit is priced by the binding side: the smaller of
// the two floored share ratios.
pub fn compute_lp_mint(
    base_amount: u64,
    quote_amount: u64,
    reserve_base: u64,
    reserve_quote: u64,
    lp_supply: u64,
) -> Result<u64> {
    if lp_supply == 0 {
        return compute_lp_first_liquidity(base_amount, quote_amount);
    }
    let base_shares = (base_amount as u128)
        .checked_mul(lp_supply as u128)
        .ok_or(error!(AmmError::Overflow))?
        / reserve_base as u128;
    let quote_shares = (quote_amount as u128)
        .checked_mul(lp_supply as u128)
        .ok_or(error!(AmmError::Overflow))?
        / reserve_quote as u128;
    let lp = base_shares.min(quote_shares);
    u64::try_from(lp).map_err(|_| error!(AmmError::Overflow))
}

// Token amounts returned for a burn of lp_amount, both rounded down against
// the withdrawing LP.
pub fn compute_withdraw_amounts(
    lp_amount: u64,
    lp_supply: u64,
    reserve_base: u64,
    reserve_quote: u64,
) -> Result<(u64, u64)> {
    let base = (lp_amount as u128)
        .checked_mul(reserve_base as u128)
        .ok_or(error!(AmmError::Overflow))?
        / lp_supply as u128;
    let quote = (lp_amount as u128)
        .checked_mul(reserve_quote as u128)
        .ok_or(error!(AmmError::Overflow))?
        / lp_supply as u128;
    let base = u64::try_from(base).map_err(|_| error!(AmmError::Overflow))?;
    let quote = u64::try_from(quote).map_err(|_| error!(AmmError::Overflow))?;
    Ok((base, quote))
}

// Integer square root of a u128, floored, by the bit-pair method. No floating
// point is used anywhere in this program.
pub fn isqrt_u128(x: u128) -> u128 {
    if x == 0 {
        return 0;
    }
    let mut x = x;
    let mut bit: u128 = 1 << 126;
    while bit > x {
        bit >>= 2;
    }
    let mut result: u128 = 0;
    while bit != 0 {
        if x >= result + bit {
            x -= result + bit;
            result = (result >> 1) + bit;
        } else {
            result >>= 1;
        }
        bit >>= 2;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic LCG so the tests need no rand dependency.
    fn lcg_next(state: &mut u64) -> u64 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *state
    }

    fn amount_out_reference(amount_in: u128, reserve_in: u128, reserve_out: u128) -> u128 {
        let fee = 1 + ((amount_in * FEE_BPS as u128 - 1) / BPS_DENOMINATOR as u128);
        let aif = amount_in - fee;
        aif * reserve_out / (reserve_in + aif)
    }

    #[test]
    fn fee_is_ceiling_of_exact_fraction() {
        assert_eq!(fee_amount(0).unwrap(), 0);
        assert_eq!(fee_amount(1).unwrap(), 1);
        assert_eq!(fee_amount(400).unwrap(), 1);
        assert_eq!(fee_amount(401).unwrap(), 2);
        assert_eq!(fee_amount(10_000).unwrap(), 25);
        // u64::MAX * 25 / 10000 must still fit u64.
        let max_fee = fee_amount(u64::MAX).unwrap();
        assert_eq!(max_fee as u128, 1 + ((u64::MAX as u128 * 25 - 1) / 10_000));
    }

    #[test]
    fn fee_rounds_against_the_swapper() {
        for amount in 1..20_000u64 {
            let fee = fee_amount(amount).unwrap() as u128;
            assert!(fee * 10_000 >= amount as u128 * 25);
        }
    }

    #[test]
    fn amount_out_is_floor_of_exact_rational() {
        let cases = [
            (1u64, 1_000_000_000u64, 1_000_000_000u64),
            (1_000, 1_000_000_000, 1_000_000_000),
            (1, u64::MAX, 1),
            (u64::MAX, u64::MAX, u64::MAX),
            (u64::MAX, 1, u64::MAX),
            (1_000_000_000, 9_000_000_000_000_000_000, 3_000_000_000),
        ];
        for (amount_in, reserve_in, reserve_out) in cases {
            let out = compute_amount_out(amount_in, reserve_in, reserve_out).unwrap() as u128;
            let fee = fee_amount(amount_in).unwrap() as u128;
            let aif = amount_in as u128 - fee;
            let numerator = aif * reserve_out as u128;
            let denominator = reserve_in as u128 + aif;
            assert!(out * denominator <= numerator, "floor violated");
            assert!((out + 1) * denominator > numerator, "not floored enough");
        }
    }

    #[test]
    fn amount_out_monotone_in_amount_in() {
        let reserve_in = 123_456_789u64;
        let reserve_out = 987_654_321u64;
        let mut prev = 0u64;
        for amount_in in 1..5_000u64 {
            let out = compute_amount_out(amount_in, reserve_in, reserve_out).unwrap();
            assert!(out >= prev);
            prev = out;
        }
    }

    #[test]
    fn amount_out_extremes_match_u128_reference() {
        let mut state = 42u64;
        for _ in 0..500 {
            let amount_in = lcg_next(&mut state) % u64::MAX;
            let reserve_in = 1 + lcg_next(&mut state) % (u64::MAX - 1);
            let reserve_out = 1 + lcg_next(&mut state) % (u64::MAX - 1);
            let out = compute_amount_out(amount_in, reserve_in, reserve_out).unwrap();
            assert_eq!(
                out as u128,
                amount_out_reference(amount_in as u128, reserve_in as u128, reserve_out as u128)
            );
        }
        // Naive u64 math would overflow on exactly these inputs.
        let out = compute_amount_out(u64::MAX - 1, u64::MAX - 1, u64::MAX - 1).unwrap();
        assert_eq!(
            out as u128,
            amount_out_reference(
                u64::MAX as u128 - 1,
                u64::MAX as u128 - 1,
                u64::MAX as u128 - 1
            )
        );
    }

    #[test]
    fn k_never_decreases_across_swaps() {
        let mut reserve_in = 1_000_000u64;
        let mut reserve_out = 1_000_000u64;
        let mut state = 7u64;
        for _ in 0..200 {
            let amount_in = 1 + lcg_next(&mut state) % 10_000;
            let out = compute_amount_out(amount_in, reserve_in, reserve_out).unwrap();
            assert!(out < reserve_out);
            let k_before = reserve_in as u128 * reserve_out as u128;
            reserve_in += amount_in;
            reserve_out -= out;
            let k_after = reserve_in as u128 * reserve_out as u128;
            assert!(
                k_after >= k_before,
                "k decreased: {} < {}",
                k_after,
                k_before
            );
        }
    }

    #[test]
    fn isqrt_known_values() {
        assert_eq!(isqrt_u128(0), 0);
        assert_eq!(isqrt_u128(1), 1);
        assert_eq!(isqrt_u128(2), 1);
        assert_eq!(isqrt_u128(3), 1);
        assert_eq!(isqrt_u128(4), 2);
        assert_eq!(isqrt_u128(8), 2);
        assert_eq!(isqrt_u128(9), 3);
        assert_eq!(isqrt_u128(15), 3);
        assert_eq!(isqrt_u128(16), 4);
        let x: u128 = 123_456_789_101u128;
        let r = isqrt_u128(x * x);
        assert_eq!(r, x);
        assert_eq!(isqrt_u128(x * x - 1), x - 1);
        // Largest product of two u64 values: (2^64 - 1)^2.
        let m = u64::MAX as u128;
        assert_eq!(isqrt_u128(m * m), m);
        assert_eq!(isqrt_u128(u128::MAX), m);
    }

    #[test]
    fn first_liquidity_floor_and_minimum() {
        assert_eq!(compute_lp_first_liquidity(1_000, 1_000).unwrap(), 1_000);
        assert_eq!(
            compute_lp_first_liquidity(1_000_000, 2_000_000).unwrap() as u128,
            isqrt_u128(2_000_000_000_000)
        );
        // product 999 * 999 = 998001, sqrt floor 999 < MIN_INITIAL_LP
        assert!(compute_lp_first_liquidity(999, 999).is_err());
        // product 1_000_000_000 -> sqrt 31622 >= 1000, passes
        assert_eq!(
            compute_lp_first_liquidity(1_000, 1_000_000).unwrap(),
            31_622
        );
        // (2^64-1)^2 must not panic and floors exactly to u64::MAX.
        assert_eq!(
            compute_lp_first_liquidity(u64::MAX, u64::MAX).unwrap(),
            u64::MAX
        );
    }

    #[test]
    fn proportional_add_mints_exact_multiple() {
        let reserve_base = 1_000_000u64;
        let reserve_quote = 4_000_000u64;
        let supply = 2_000_000u64;
        for k in [1u64, 2, 3, 7, 100] {
            let lp = compute_lp_mint(
                reserve_base * k,
                reserve_quote * k,
                reserve_base,
                reserve_quote,
                supply,
            )
            .unwrap();
            assert_eq!(lp, supply * k);
        }
    }

    #[test]
    fn skewed_add_mints_the_binding_side() {
        let lp = compute_lp_mint(500_000, 4_000_000, 1_000_000, 4_000_000, 2_000_000).unwrap();
        assert_eq!(lp, 1_000_000);
    }

    #[test]
    fn withdraw_full_supply_returns_full_reserves() {
        let (b, q) = compute_withdraw_amounts(2_000_000, 2_000_000, 1_000_000, 4_000_000).unwrap();
        assert_eq!((b, q), (1_000_000, 4_000_000));
    }

    #[test]
    fn withdraw_floors_against_the_lp() {
        let (b, q) = compute_withdraw_amounts(999, 2_000_000, 1_000_000, 4_000_000).unwrap();
        assert_eq!(b, 499);
        assert_eq!(q, 1_998);
        // Exact rationals are 499.5 and 1998.0: floor keeps both at or below.
        assert!(999u128 * 1_000_000 / 2_000_000 >= b as u128);
        assert!(999u128 * 4_000_000 / 2_000_000 >= q as u128);
    }

    #[test]
    fn constants_are_the_documented_values() {
        assert_eq!(FEE_BPS, 25);
        assert_eq!(BPS_DENOMINATOR, 10_000);
        assert_eq!(MIN_INITIAL_LP, 1_000);
        assert_eq!(LP_DECIMALS, 6);
    }
}

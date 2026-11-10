use crate::errors::EscrowError;
use anchor_lang::prelude::*;

/// Token B owed for taking 'taken_a' base units of token A out of an escrow
/// posted as 'offer_a' base units of A for 'ask_b' base units of B.
///
/// The exchange rate is the rational ask_b / offer_a fixed when the offer was
/// made. The result is rounded UP so the taker never pays less than the exact
/// proportional share; the maker can only gain from rounding dust.
///
/// With taken_a <= offer_a the result is bounded by ask_b, and the u128
/// product of two u64 values always fits, so the two error branches are
/// unreachable for inputs that pass the take-amount check. They are kept as
/// hard stops anyway: this function must never wrap or silently truncate.
pub fn owed_token_b(taken_a: u64, offer_a: u64, ask_b: u64) -> Result<u64> {
    if offer_a == 0 || taken_a == 0 {
        return Err(EscrowError::ZeroAmount.into());
    }
    if taken_a > offer_a {
        return Err(EscrowError::TakeExceedsRemaining.into());
    }
    let product = (taken_a as u128)
        .checked_mul(ask_b as u128)
        .ok_or(EscrowError::MathOverflow)?;
    let quotient = product / offer_a as u128;
    let remainder = product % offer_a as u128;
    let owed = if remainder == 0 {
        quotient
    } else {
        quotient.checked_add(1).ok_or(EscrowError::MathOverflow)?
    };
    u64::try_from(owed).map_err(|_| EscrowError::MathOverflow.into())
}

/// An expiry of 0 means the offer never expires. Otherwise the offer is
/// takeable only strictly before the expiry timestamp; at expiry and after,
/// only refund succeeds. Timestamps are unix seconds from the Clock sysvar.
pub fn ensure_not_expired(expiry: i64, now: i64) -> Result<()> {
    if expiry != 0 && now >= expiry {
        return Err(EscrowError::EscrowExpired.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_division_needs_no_rounding() {
        assert_eq!(owed_token_b(500, 1_000, 2_000).unwrap(), 1_000);
        assert_eq!(owed_token_b(1, 1, 1).unwrap(), 1);
    }

    #[test]
    fn remainder_rounds_up_against_the_taker() {
        // 1/3 of an offer of 3 A for 10 B: 10/3 = 3.33 -> taker pays 4.
        assert_eq!(owed_token_b(1, 3, 10).unwrap(), 4);
        // 2/3: 20/3 = 6.67 -> 7.
        assert_eq!(owed_token_b(2, 3, 10).unwrap(), 7);
        // Full take pays the whole ask regardless of divisibility.
        assert_eq!(owed_token_b(3, 3, 10).unwrap(), 10);
    }

    #[test]
    fn taking_the_whole_offer_costs_the_whole_ask() {
        assert_eq!(owed_token_b(1_000, 1_000, 2_000).unwrap(), 2_000);
    }

    #[test]
    fn owed_is_bounded_by_the_ask() {
        // Even extreme values: any partial take owes at most the full ask,
        // and a full take owes exactly the ask. This is the property that
        // makes the u64 conversion lossless for valid inputs.
        let max = u64::MAX;
        assert_eq!(owed_token_b(max, max, max).unwrap(), max);
        assert_eq!(owed_token_b(1, max, max).unwrap(), 1);
        // (max/2) * max / max divides exactly: no rounding, owed = max/2.
        assert_eq!(owed_token_b(max / 2, max, max).unwrap(), max / 2);
    }

    #[test]
    fn zero_taken_or_zero_offer_is_rejected() {
        assert!(owed_token_b(0, 1_000, 2_000).is_err());
        assert!(owed_token_b(1, 0, 2_000).is_err());
    }

    #[test]
    fn zero_ask_is_rejected_at_offer_creation_not_in_math() {
        // owed_token_b only needs taken_a and offer_a nonzero; a zero ask
        // would make every take free, so make_offer refuses it instead.
        assert_eq!(owed_token_b(5, 10, 0).unwrap(), 0);
    }

    #[test]
    fn taking_more_than_offered_is_rejected() {
        assert!(owed_token_b(1_001, 1_000, 2_000).is_err());
        assert!(owed_token_b(u64::MAX, 1, 1).is_err());
    }

    #[test]
    fn expiry_zero_never_expires() {
        assert!(ensure_not_expired(0, 0).is_ok());
        assert!(ensure_not_expired(0, i64::MAX).is_ok());
    }

    #[test]
    fn expiry_boundary_is_strictly_before() {
        assert!(ensure_not_expired(100, 99).is_ok());
        assert!(ensure_not_expired(100, 100).is_err());
        assert!(ensure_not_expired(100, 101).is_err());
        assert!(ensure_not_expired(100, i64::MAX).is_err());
    }

    #[test]
    fn negative_expiry_is_treated_as_expired() {
        // 0 is the only no-expiry marker; a negative timestamp can only
        // come from a bad offer and must not pass the gate.
        assert!(ensure_not_expired(-1, 0).is_err());
    }
}

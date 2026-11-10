//! Vesting schedule math. Pure functions only, so the exact same code paths
//! are exercised by host unit tests and by on-chain instructions.

/// Seeds for the per-schedule vesting PDA: ["vesting", beneficiary, index_le].
pub const SEED_VESTING: &[u8] = b"vesting";
/// Seeds for the per-beneficiary schedule counter PDA: ["registry", beneficiary].
pub const SEED_REGISTRY: &[u8] = b"registry";

/// Tokens unlocked at now_ts under a cliff + linear schedule.
///
/// Vesting accrues linearly from start_ts to maturity_ts; nothing can be
/// withdrawn before cliff_ts. At the cliff instant the beneficiary can
/// withdraw everything accrued between start and cliff at once, and the rest
/// continues to unlock linearly until maturity, where the total is available.
///
/// The multiplication runs in u128, so a maximal u64 total times a maximal
/// i64 span cannot overflow. Division floors, which pays the rounding
/// remainder to the schedule, never to an early claimant.
pub fn unlocked_amount(
    total: u64,
    start_ts: i64,
    cliff_ts: i64,
    maturity_ts: i64,
    now_ts: i64,
) -> u64 {
    if now_ts < cliff_ts {
        return 0;
    }
    if now_ts >= maturity_ts {
        return total;
    }
    let span = (maturity_ts - start_ts) as u128;
    let elapsed = (now_ts - start_ts) as u128;
    let unlocked = (total as u128) * elapsed / span;
    u64::try_from(unlocked).expect("elapsed < span bounds unlocked by total")
}

/// Schedule shapes the program accepts:
/// start > 0, maturity > start, and start <= cliff <= maturity.
/// cliff == start is plain linear vesting; cliff == maturity unlocks
/// everything at maturity.
pub fn validate_schedule(start_ts: i64, cliff_ts: i64, maturity_ts: i64) -> bool {
    start_ts > 0 && maturity_ts > start_ts && cliff_ts >= start_ts && cliff_ts <= maturity_ts
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1000 tokens at 6 decimals over a 1000 second span.
    const TOTAL: u64 = 1_000_000_000_000;
    const START: i64 = 1_700_000_000;
    const SPAN: i64 = 1_000;
    const CLIFF: i64 = START + 400;

    fn maturity() -> i64 {
        START + SPAN
    }

    #[test]
    fn zero_before_cliff() {
        assert_eq!(unlocked_amount(TOTAL, START, CLIFF, maturity(), START), 0);
        assert_eq!(
            unlocked_amount(TOTAL, START, CLIFF, maturity(), CLIFF - 1),
            0
        );
    }

    #[test]
    fn cliff_edge_pays_accrued_chunk() {
        // At the cliff, everything accrued from start to cliff unlocks at once.
        let at_cliff = unlocked_amount(TOTAL, START, CLIFF, maturity(), CLIFF);
        assert_eq!(at_cliff, TOTAL * 400 / 1000);
    }

    #[test]
    fn linear_midpoints_after_cliff() {
        let half = unlocked_amount(TOTAL, START, CLIFF, maturity(), START + 500);
        assert_eq!(half, TOTAL * 500 / 1000);
        let later = unlocked_amount(TOTAL, START, CLIFF, maturity(), START + 600);
        assert_eq!(later, TOTAL * 600 / 1000);
    }

    #[test]
    fn maturity_pays_full_and_never_more() {
        assert_eq!(
            unlocked_amount(TOTAL, START, CLIFF, maturity(), maturity()),
            TOTAL
        );
        let late = maturity() + 86_400 * 365;
        assert_eq!(
            unlocked_amount(TOTAL, START, CLIFF, maturity(), late),
            TOTAL
        );
    }

    #[test]
    fn division_floors_toward_the_schedule() {
        // 10 * 1 / 3 = 3.33 floors to 3; the final unit arrives at maturity.
        assert_eq!(unlocked_amount(10, 0, 0, 3, 1), 3);
        assert_eq!(unlocked_amount(10, 0, 0, 3, 2), 6);
        assert_eq!(unlocked_amount(10, 0, 0, 3, 3), 10);
    }

    #[test]
    fn maximal_total_does_not_overflow() {
        let max = u64::MAX;
        // span of exactly 1e9 so the midpoint is an exact half
        let mid = unlocked_amount(max, 1, 1, 1_000_000_001, 500_000_001);
        assert_eq!(mid, max / 2);
        let early = unlocked_amount(max, 1, 1, 1_000_000_001, 4);
        let expected = ((max as u128) * 3 / 1_000_000_000) as u64;
        assert_eq!(early, expected);
    }

    #[test]
    fn zero_cliff_is_plain_linear() {
        assert_eq!(unlocked_amount(1_000, 5, 5, 10, 5), 0);
        // span 5, elapsed 2: 1000 * 2 / 5 = 400
        assert_eq!(unlocked_amount(1_000, 5, 5, 10, 7), 400);
    }

    #[test]
    fn cliff_equal_to_maturity_unlocks_everything_at_maturity() {
        let m = 50;
        assert_eq!(unlocked_amount(1_000, 10, m, m, m - 1), 0);
        assert_eq!(unlocked_amount(1_000, 10, m, m, m), 1_000);
    }

    #[test]
    fn validate_rejects_broken_shapes() {
        assert!(validate_schedule(100, 100, 200));
        assert!(validate_schedule(100, 200, 200)); // cliff at maturity is allowed
        assert!(!validate_schedule(200, 100, 100)); // maturity must exceed start
        assert!(!validate_schedule(100, 150, 120)); // cliff past maturity
        assert!(!validate_schedule(100, 99, 200)); // cliff before start
        assert!(!validate_schedule(0, 0, 100)); // start must be a real timestamp
        assert!(!validate_schedule(-5, 0, 100));
    }
}

use anchor_lang::prelude::*;

use crate::math;

/// One vesting schedule. Derived at ["vesting", beneficiary, index_le].
#[account]
#[derive(InitSpace)]
pub struct VestingSchedule {
    /// The only account that may call claim and close_schedule.
    pub beneficiary: Pubkey,
    /// The schedule creator; the only account that may call revoke.
    pub authority: Pubkey,
    /// Token-2022 mint being vested.
    pub mint: Pubkey,
    /// Vault token account (ATA of this PDA) holding the locked tokens.
    pub vault: Pubkey,
    /// Total tokens locked for this schedule.
    pub total_amount: u64,
    /// Total tokens already paid out to the beneficiary.
    pub claimed_amount: u64,
    /// Linear vesting starts here (unix seconds).
    pub start_ts: i64,
    /// Nothing is claimable strictly before this (unix seconds).
    pub cliff_ts: i64,
    /// Everything is claimable from here on (unix seconds).
    pub maturity_ts: i64,
    /// Index of this schedule within the beneficiary's registry.
    pub schedule_idx: u32,
    /// Whether the authority may revoke unvested tokens.
    pub revocable: bool,
    /// Set to true by revoke.
    pub revoked: bool,
    /// Chain timestamp at revoke time; claims freeze here.
    pub revoked_at: i64,
    /// Bump of this account's PDA, stored for CPI signing.
    pub bump: u8,
}

impl VestingSchedule {
    /// The instant claims are computed against. A revoked schedule is frozen
    /// at its revocation timestamp, so the beneficiary keeps everything that
    /// had vested by then and nothing after.
    pub fn effective_now(&self, now_ts: i64) -> i64 {
        if self.revoked {
            self.revoked_at
        } else {
            now_ts
        }
    }

    pub fn unlocked(&self, now_ts: i64) -> u64 {
        math::unlocked_amount(
            self.total_amount,
            self.start_ts,
            self.cliff_ts,
            self.maturity_ts,
            self.effective_now(now_ts),
        )
    }

    pub fn claimable(&self, now_ts: i64) -> u64 {
        self.unlocked(now_ts).saturating_sub(self.claimed_amount)
    }
}

/// Per-beneficiary counter used to derive unique schedule PDAs.
/// Derived at ["registry", beneficiary].
#[account]
#[derive(InitSpace)]
pub struct BeneficiaryRegistry {
    /// Beneficiary this registry counts for; Pubkey::default only between
    /// init and the first write inside create_schedule.
    pub beneficiary: Pubkey,
    /// Number of schedules created; the next schedule uses this index.
    pub next_index: u32,
}

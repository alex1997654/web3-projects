// The anchor-lang macro expansions reference cfg values (custom-heap,
// custom-panic, anchor-debug, solana) that rustc's cfg checking does not
// know about on the host toolchain; they are set by the SBF build.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;
pub mod token_cpi;

pub use instructions::*;
pub use state::*;

declare_id!("A8MoJRBGw2k9MEgK9wzxjtVgpRfYLKQD6UuF9weSAdoF");

#[program]
pub mod token22_vesting {
    use super::*;

    pub fn create_schedule(ctx: Context<CreateSchedule>, args: CreateScheduleArgs) -> Result<()> {
        instructions::create_schedule::handler(ctx, args)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }

    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        instructions::revoke::handler(ctx)
    }

    pub fn close_schedule(ctx: Context<CloseSchedule>) -> Result<()> {
        instructions::close_schedule::handler(ctx)
    }

    pub fn claimable_amount(ctx: Context<ClaimableView>) -> Result<u64> {
        let now = Clock::get()?.unix_timestamp;
        Ok(ctx.accounts.vesting.claimable(now))
    }
}

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::Token2022;

use crate::errors::VestingError;
use crate::math;
use crate::state::{BeneficiaryRegistry, VestingSchedule};
use crate::token_cpi;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateScheduleArgs {
    /// Tokens to lock, in the mint's native units (not UI units).
    pub amount: u64,
    pub start_ts: i64,
    pub cliff_ts: i64,
    pub maturity_ts: i64,
    /// Must equal the beneficiary's registry counter; prevents index gaps
    /// and collisions between concurrent schedules.
    pub schedule_idx: u32,
    pub revocable: bool,
}

#[derive(Accounts)]
#[instruction(args: CreateScheduleArgs)]
pub struct CreateSchedule<'info> {
    /// Pays for the new accounts, supplies the locked tokens, and holds
    /// revoke authority for the schedule.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: only its pubkey is used, for PDA derivation and bookkeeping.
    pub beneficiary: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + BeneficiaryRegistry::INIT_SPACE,
        seeds = [crate::math::SEED_REGISTRY, beneficiary.key().as_ref()],
        bump,
    )]
    pub registry: Account<'info, BeneficiaryRegistry>,

    #[account(
        init,
        payer = authority,
        space = 8 + VestingSchedule::INIT_SPACE,
        seeds = [
            crate::math::SEED_VESTING,
            beneficiary.key().as_ref(),
            &args.schedule_idx.to_le_bytes(),
        ],
        bump,
    )]
    pub vesting: Account<'info, VestingSchedule>,

    /// CHECK: Token-2022 ATA of the vesting PDA. Derivation is checked in
    /// the handler; contents are only ever touched through Token-2022 CPI,
    /// which validates them on chain.
    #[account(mut)]
    pub vault: AccountInfo<'info>,

    /// CHECK: Token-2022 ATA the locked tokens are drawn from. Same deal:
    /// derivation is checked in the handler, contents enforced by the CPI.
    #[account(mut)]
    pub source: AccountInfo<'info>,

    /// CHECK: Token-2022 mint. Decimals are read from its fixed base
    /// layout; transfer_checked re-validates the mint on chain.
    pub mint: AccountInfo<'info>,
    pub token_2022: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateSchedule>, args: CreateScheduleArgs) -> Result<()> {
    require!(args.amount > 0, VestingError::ZeroAmount);
    require!(
        math::validate_schedule(args.start_ts, args.cliff_ts, args.maturity_ts),
        VestingError::InvalidSchedule
    );

    // A fresh registry comes up zeroed; the PDA seeds pin it to this
    // beneficiary, so it is safe to stamp on first use.
    if ctx.accounts.registry.beneficiary == Pubkey::default() {
        ctx.accounts.registry.beneficiary = ctx.accounts.beneficiary.key();
    }
    require!(
        ctx.accounts.registry.beneficiary == ctx.accounts.beneficiary.key(),
        VestingError::RegistryMismatch
    );
    require!(
        args.schedule_idx == ctx.accounts.registry.next_index,
        VestingError::InvalidScheduleIndex
    );

    let bump = ctx.bumps.vesting;
    let schedule = &mut ctx.accounts.vesting;
    schedule.beneficiary = ctx.accounts.beneficiary.key();
    schedule.authority = ctx.accounts.authority.key();
    schedule.mint = ctx.accounts.mint.key();
    schedule.vault = ctx.accounts.vault.key();
    schedule.total_amount = args.amount;
    schedule.claimed_amount = 0;
    schedule.start_ts = args.start_ts;
    schedule.cliff_ts = args.cliff_ts;
    schedule.maturity_ts = args.maturity_ts;
    schedule.schedule_idx = args.schedule_idx;
    schedule.revocable = args.revocable;
    schedule.revoked = false;
    schedule.revoked_at = 0;
    schedule.bump = bump;

    let expected_vault = spl_associated_token_account::get_associated_token_address_with_program_id(
        &ctx.accounts.vesting.key(),
        &ctx.accounts.mint.key(),
        &ctx.accounts.token_2022.key(),
    );
    require!(
        ctx.accounts.vault.key() == expected_vault,
        VestingError::VaultMismatch
    );
    let expected_source =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &ctx.accounts.authority.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.token_2022.key(),
        );
    require!(
        ctx.accounts.source.key() == expected_source,
        VestingError::SourceMismatch
    );

    // Vault: Token-2022 ATA owned by the vesting PDA. Created here rather
    // than through an init wrapper so no token state is unpacked in-process.
    token_cpi::create_ata_idempotent(
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.vesting.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.token_2022.to_account_info(),
    )?;

    let decimals = token_cpi::mint_decimals(&ctx.accounts.mint)?;
    token_cpi::transfer_checked(
        ctx.accounts.token_2022.to_account_info(),
        ctx.accounts.source.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        args.amount,
        decimals,
        &[],
    )?;

    ctx.accounts.registry.next_index = ctx
        .accounts
        .registry
        .next_index
        .checked_add(1)
        .ok_or(VestingError::MathOverflow)?;
    Ok(())
}

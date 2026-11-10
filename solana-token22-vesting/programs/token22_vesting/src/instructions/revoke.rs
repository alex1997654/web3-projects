use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::Token2022;

use crate::errors::VestingError;
use crate::math::SEED_VESTING;
use crate::state::VestingSchedule;
use crate::token_cpi;

#[derive(Accounts)]
pub struct Revoke<'info> {
    #[account(
        mut,
        constraint = vesting.authority == authority.key() @ VestingError::NotAuthority
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vesting: Account<'info, VestingSchedule>,

    /// CHECK: Token-2022 ATA of the vesting PDA; key equality plus a
    /// derivation check in the handler pin it, contents are enforced by
    /// the Token-2022 CPI below.
    #[account(
        mut,
        constraint = vault.key() == vesting.vault @ VestingError::VaultMismatch
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Token-2022 mint of the schedule.
    #[account(constraint = mint.key() == vesting.mint @ VestingError::MintMismatch)]
    pub mint: AccountInfo<'info>,

    /// CHECK: revoking authority's Token-2022 ATA of the mint; derivation
    /// checked in the handler and created if missing.
    #[account(mut)]
    pub destination: AccountInfo<'info>,
    pub token_2022: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Revoke>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let vesting = &ctx.accounts.vesting;
    require!(vesting.revocable, VestingError::ScheduleNotRevocable);
    require!(!vesting.revoked, VestingError::AlreadyRevoked);

    let unlocked = vesting.unlocked(now);
    let unvested = vesting
        .total_amount
        .checked_sub(unlocked)
        .ok_or(VestingError::MathOverflow)?;
    require!(unvested > 0, VestingError::NothingToRevoke);
    let vault_balance = token_cpi::token_amount(&ctx.accounts.vault)?;
    require!(vault_balance >= unvested, VestingError::VaultUnderfunded);

    let expected_vault = spl_associated_token_account::get_associated_token_address_with_program_id(
        &ctx.accounts.vesting.key(),
        &ctx.accounts.vesting.mint,
        &ctx.accounts.token_2022.key(),
    );
    require!(
        ctx.accounts.vault.key() == expected_vault,
        VestingError::VaultMismatch
    );
    let expected_destination =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &ctx.accounts.authority.key(),
            &ctx.accounts.vesting.mint,
            &ctx.accounts.token_2022.key(),
        );
    require!(
        ctx.accounts.destination.key() == expected_destination,
        VestingError::DestinationMismatch
    );

    token_cpi::create_ata_idempotent(
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.destination.to_account_info(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.token_2022.to_account_info(),
    )?;

    let signer_seeds: &[&[&[u8]]] = &[&[
        SEED_VESTING,
        vesting.beneficiary.as_ref(),
        &vesting.schedule_idx.to_le_bytes(),
        &[vesting.bump],
    ]];

    let decimals = token_cpi::mint_decimals(&ctx.accounts.mint)?;
    token_cpi::transfer_checked(
        ctx.accounts.token_2022.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.destination.to_account_info(),
        ctx.accounts.vesting.to_account_info(),
        unvested,
        decimals,
        signer_seeds,
    )?;

    let vesting = &mut ctx.accounts.vesting;
    vesting.revoked = true;
    vesting.revoked_at = now;
    Ok(())
}

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::Token2022;

use crate::errors::VestingError;
use crate::math::SEED_VESTING;
use crate::state::VestingSchedule;
use crate::token_cpi;

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        constraint = vesting.beneficiary == beneficiary.key() @ VestingError::NotBeneficiary
    )]
    pub beneficiary: Signer<'info>,

    #[account(mut)]
    pub vesting: Account<'info, VestingSchedule>,

    /// CHECK: Token-2022 ATA of the vesting PDA. Key equality plus a
    /// derivation check in the handler pin it; contents are only ever
    /// touched through Token-2022 CPI, which validates them on chain.
    #[account(
        mut,
        constraint = vault.key() == vesting.vault @ VestingError::VaultMismatch
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Token-2022 mint of the schedule; key checked against the
    /// schedule record.
    #[account(constraint = mint.key() == vesting.mint @ VestingError::MintMismatch)]
    pub mint: AccountInfo<'info>,

    /// CHECK: beneficiary's Token-2022 ATA of the schedule mint; the
    /// handler checks the derivation and creates it if missing.
    #[account(mut)]
    pub destination: AccountInfo<'info>,
    pub token_2022: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let claimable = ctx.accounts.vesting.claimable(now);
    require!(claimable > 0, VestingError::NothingToClaim);
    let vault_balance = token_cpi::token_amount(&ctx.accounts.vault)?;
    require!(vault_balance >= claimable, VestingError::VaultUnderfunded);

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
            &ctx.accounts.beneficiary.key(),
            &ctx.accounts.vesting.mint,
            &ctx.accounts.token_2022.key(),
        );
    require!(
        ctx.accounts.destination.key() == expected_destination,
        VestingError::DestinationMismatch
    );

    token_cpi::create_ata_idempotent(
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.beneficiary.to_account_info(),
        ctx.accounts.destination.to_account_info(),
        ctx.accounts.beneficiary.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.token_2022.to_account_info(),
    )?;

    let signer_seeds: &[&[&[u8]]] = &[&[
        SEED_VESTING,
        ctx.accounts.vesting.beneficiary.as_ref(),
        &ctx.accounts.vesting.schedule_idx.to_le_bytes(),
        &[ctx.accounts.vesting.bump],
    ]];

    let decimals = token_cpi::mint_decimals(&ctx.accounts.mint)?;
    token_cpi::transfer_checked(
        ctx.accounts.token_2022.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.destination.to_account_info(),
        ctx.accounts.vesting.to_account_info(),
        claimable,
        decimals,
        signer_seeds,
    )?;

    let vesting = &mut ctx.accounts.vesting;
    vesting.claimed_amount = vesting
        .claimed_amount
        .checked_add(claimable)
        .ok_or(VestingError::MathOverflow)?;
    Ok(())
}

/// Read-only view used by clients to price a pending claim without
/// reconstructing the schedule math off-chain.
#[derive(Accounts)]
pub struct ClaimableView<'info> {
    pub vesting: Account<'info, VestingSchedule>,
}

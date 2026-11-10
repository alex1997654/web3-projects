use anchor_lang::prelude::*;
use anchor_spl::token_interface::Token2022;

use crate::errors::VestingError;
use crate::math::SEED_VESTING;
use crate::state::VestingSchedule;
use crate::token_cpi;

#[derive(Accounts)]
pub struct CloseSchedule<'info> {
    #[account(
        mut,
        constraint = vesting.beneficiary == beneficiary.key() @ VestingError::NotBeneficiary
    )]
    pub beneficiary: Signer<'info>,

    #[account(mut, close = beneficiary)]
    pub vesting: Account<'info, VestingSchedule>,

    /// CHECK: Token-2022 ATA of the vesting PDA; the CPI below closes it
    /// and the on-chain program refuses while it still holds tokens.
    #[account(
        mut,
        constraint = vault.key() == vesting.vault @ VestingError::VaultMismatch,
    )]
    pub vault: AccountInfo<'info>,

    pub token_2022: Program<'info, Token2022>,
}

pub fn handler(ctx: Context<CloseSchedule>) -> Result<()> {
    let vault_balance = token_cpi::token_amount(&ctx.accounts.vault)?;
    require!(vault_balance == 0, VestingError::VaultNotEmpty);

    let signer_seeds: &[&[&[u8]]] = &[&[
        SEED_VESTING,
        ctx.accounts.vesting.beneficiary.as_ref(),
        &ctx.accounts.vesting.schedule_idx.to_le_bytes(),
        &[ctx.accounts.vesting.bump],
    ]];

    token_cpi::close_token_account(
        ctx.accounts.token_2022.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.beneficiary.to_account_info(),
        ctx.accounts.vesting.to_account_info(),
        signer_seeds,
    )?;

    // The vesting account itself is closed by the close = beneficiary
    // constraint after this handler returns; its rent joins the vault rent.
    Ok(())
}

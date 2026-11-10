use crate::{errors::AmmError, state::Pool};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = Pool::SPACE,
        seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = payer,
        seeds = [b"lp_mint", pool.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = pool
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        associated_token::mint = base_mint,
        associated_token::authority = pool
    )]
    pub vault_base: Account<'info, TokenAccount>,

    #[account(
        associated_token::mint = quote_mint,
        associated_token::authority = pool
    )]
    pub vault_quote: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
    let base = ctx.accounts.base_mint.key();
    let quote = ctx.accounts.quote_mint.key();
    require!(base != quote, AmmError::IdenticalMints);
    require!(base < quote, AmmError::NonCanonicalPairOrder);

    let pool = &mut ctx.accounts.pool;
    pool.base_mint = base;
    pool.quote_mint = quote;
    pool.lp_mint = ctx.accounts.lp_mint.key();
    pool.vault_base = ctx.accounts.vault_base.key();
    pool.vault_quote = ctx.accounts.vault_quote.key();
    pool.bump = ctx.bumps.pool;
    Ok(())
}

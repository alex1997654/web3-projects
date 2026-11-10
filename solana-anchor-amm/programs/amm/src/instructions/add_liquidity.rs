use crate::{errors::AmmError, math, state::Pool};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AddLiquidityArgs {
    pub amount_base: u64,
    pub amount_quote: u64,
    pub min_lp_out: u64,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [b"lp_mint", pool.key().as_ref()], bump)]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = pool
    )]
    pub vault_base: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = pool
    )]
    pub vault_quote: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = user
    )]
    pub user_base_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = quote_mint,
        associated_token::authority = user
    )]
    pub user_quote_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = lp_mint,
        associated_token::authority = user
    )]
    pub user_lp_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn add_liquidity(ctx: Context<AddLiquidity>, args: AddLiquidityArgs) -> Result<()> {
    require!(args.amount_base > 0, AmmError::ZeroAmount);
    require!(args.amount_quote > 0, AmmError::ZeroAmount);

    // Reserves are read from the vaults before any CPI: the token account
    // amounts are the single source of truth for pool state.
    let reserve_base = ctx.accounts.vault_base.amount;
    let reserve_quote = ctx.accounts.vault_quote.amount;
    let lp_supply = ctx.accounts.lp_mint.supply;

    let lp_out = math::compute_lp_mint(
        args.amount_base,
        args.amount_quote,
        reserve_base,
        reserve_quote,
        lp_supply,
    )?;
    require!(lp_out >= args.min_lp_out, AmmError::SlippageExceeded);

    let base_key = ctx.accounts.base_mint.key();
    let quote_key = ctx.accounts.quote_mint.key();
    let seeds = [
        b"pool".as_ref(),
        base_key.as_ref(),
        quote_key.as_ref(),
        &[ctx.accounts.pool.bump],
    ];
    let signer = &[&seeds[..]];

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.user_base_ata.to_account_info(),
                to: ctx.accounts.vault_base.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        args.amount_base,
    )?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.user_quote_ata.to_account_info(),
                to: ctx.accounts.vault_quote.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        args.amount_quote,
    )?;

    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::MintTo {
                mint: ctx.accounts.lp_mint.to_account_info(),
                to: ctx.accounts.user_lp_ata.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer,
        ),
        lp_out,
    )?;

    Ok(())
}

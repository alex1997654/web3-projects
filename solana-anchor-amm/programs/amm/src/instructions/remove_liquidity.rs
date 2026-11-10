use crate::{errors::AmmError, math, state::Pool};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RemoveLiquidityArgs {
    pub lp_amount: u64,
    pub min_base_out: u64,
    pub min_quote_out: u64,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
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

pub fn remove_liquidity(ctx: Context<RemoveLiquidity>, args: RemoveLiquidityArgs) -> Result<()> {
    require!(args.lp_amount > 0, AmmError::ZeroAmount);

    let reserve_base = ctx.accounts.vault_base.amount;
    let reserve_quote = ctx.accounts.vault_quote.amount;
    let lp_supply = ctx.accounts.lp_mint.supply;
    require!(lp_supply >= args.lp_amount, AmmError::InsufficientLiquidity);

    let (base_out, quote_out) =
        math::compute_withdraw_amounts(args.lp_amount, lp_supply, reserve_base, reserve_quote)?;
    require!(base_out >= args.min_base_out, AmmError::SlippageExceeded);
    require!(quote_out >= args.min_quote_out, AmmError::SlippageExceeded);

    // Burn first, then pay out, so the LP is destroyed before reserves leave.
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Burn {
                mint: ctx.accounts.lp_mint.to_account_info(),
                from: ctx.accounts.user_lp_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        args.lp_amount,
    )?;

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
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.vault_base.to_account_info(),
                to: ctx.accounts.user_base_ata.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer,
        ),
        base_out,
    )?;

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Transfer {
                from: ctx.accounts.vault_quote.to_account_info(),
                to: ctx.accounts.user_quote_ata.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer,
        ),
        quote_out,
    )?;

    Ok(())
}

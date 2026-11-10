use crate::{errors::AmmError, math, state::Pool};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SwapArgs {
    pub is_base_in: bool,
    pub amount_in: u64,
    pub min_out: u64,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        seeds = [b"pool", base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,

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

    pub token_program: Program<'info, Token>,
}

pub fn swap(ctx: Context<Swap>, args: SwapArgs) -> Result<()> {
    require!(args.amount_in > 0, AmmError::ZeroAmount);

    // Reserves are read before either transfer CPI moves funds.
    let (reserve_in, reserve_out) = if args.is_base_in {
        (
            ctx.accounts.vault_base.amount,
            ctx.accounts.vault_quote.amount,
        )
    } else {
        (
            ctx.accounts.vault_quote.amount,
            ctx.accounts.vault_base.amount,
        )
    };
    require!(
        reserve_in > 0 && reserve_out > 0,
        AmmError::InsufficientLiquidity
    );

    let amount_out = math::compute_amount_out(args.amount_in, reserve_in, reserve_out)?;
    require!(amount_out >= args.min_out, AmmError::SlippageExceeded);

    let base_key = ctx.accounts.base_mint.key();
    let quote_key = ctx.accounts.quote_mint.key();
    let seeds = [
        b"pool".as_ref(),
        base_key.as_ref(),
        quote_key.as_ref(),
        &[ctx.accounts.pool.bump],
    ];
    let signer = &[&seeds[..]];

    if args.is_base_in {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_base_ata.to_account_info(),
                    to: ctx.accounts.vault_base.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            args.amount_in,
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
            amount_out,
        )?;
    } else {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_quote_ata.to_account_info(),
                    to: ctx.accounts.vault_quote.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            args.amount_in,
        )?;

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
            amount_out,
        )?;
    }

    Ok(())
}

pub mod errors;
pub mod math;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, close_account, CloseAccount, Mint, Token, TokenAccount, Transfer},
};
use errors::EscrowError;
use math::{ensure_not_expired, owed_token_b};
use state::Escrow;

declare_id!("9VcbzbGs9Et814sq6z7dLYaP6qPq6tffv2nHDSPqoeTo");

#[program]
pub mod escrow {
    use super::*;

    /// Posts an escrow offer: locks 'offer_amount_a' base units of mint_a in
    /// a fresh PDA vault and records the ask in mint_b. Expiry is a unix
    /// timestamp; 0 means the offer stays open until filled or refunded.
    pub fn make_offer(
        ctx: Context<MakeOffer>,
        seed: u64,
        offer_amount_a: u64,
        ask_amount_b: u64,
        expiry: i64,
    ) -> Result<()> {
        require!(offer_amount_a > 0, EscrowError::ZeroAmount);
        require!(ask_amount_b > 0, EscrowError::ZeroAmount);
        require!(
            expiry == 0 || expiry > Clock::get()?.unix_timestamp,
            EscrowError::OfferAlreadyExpired
        );

        let bump = ctx.bumps.escrow;
        ctx.accounts.escrow.set_inner(Escrow {
            maker: ctx.accounts.maker.key(),
            seed,
            mint_a: ctx.accounts.mint_a.key(),
            mint_b: ctx.accounts.mint_b.key(),
            offer_amount_a,
            ask_amount_b,
            remaining_amount_a: offer_amount_a,
            expiry,
            bump,
        });

        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new(
                cpi_program,
                Transfer {
                    from: ctx.accounts.maker_ata_a.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.maker.to_account_info(),
                },
            ),
            offer_amount_a,
        )
    }

    /// Partially fills an open offer. 'take_amount_a' must be strictly less
    /// than the remaining deposit; emptying the offer is take_full's job.
    /// The taker pays ceil(take_amount_a * ask / offer) of mint_b, rounded
    /// against the taker.
    #[allow(unused_variables)]
    pub fn take(ctx: Context<Take>, seed: u64, take_amount_a: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        ensure_not_expired(escrow.expiry, Clock::get()?.unix_timestamp)?;
        require!(
            take_amount_a > 0 && take_amount_a < escrow.remaining_amount_a,
            EscrowError::TakeExceedsRemaining
        );
        let owed_b = owed_token_b(take_amount_a, escrow.offer_amount_a, escrow.ask_amount_b)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_ata_b.to_account_info(),
                    to: ctx.accounts.maker_ata_b.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            owed_b,
        )?;

        let vault_bump = [ctx.bumps.vault];
        let escrow_key = escrow.key();
        let vault_seeds: &[&[u8]] = &[b"vault".as_ref(), escrow_key.as_ref(), &vault_bump];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.taker_ata_a.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            take_amount_a,
        )?;

        escrow.remaining_amount_a = escrow
            .remaining_amount_a
            .checked_sub(take_amount_a)
            .ok_or(EscrowError::MathOverflow)?;
        Ok(())
    }

    /// Fills whatever remains of the offer and closes it: the vault is
    /// emptied and closed through the SPL Token program (rent back to the
    /// maker) and the offer account is closed by Anchor's close constraint.
    /// Any tokens a third party tipped into the vault are swept to the
    /// taker along with the deposit.
    #[allow(unused_variables)]
    pub fn take_full(ctx: Context<TakeFull>, seed: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        ensure_not_expired(escrow.expiry, Clock::get()?.unix_timestamp)?;
        let owed_b = owed_token_b(
            escrow.remaining_amount_a,
            escrow.offer_amount_a,
            escrow.ask_amount_b,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.taker_ata_b.to_account_info(),
                    to: ctx.accounts.maker_ata_b.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            owed_b,
        )?;

        let vault_bump = [ctx.bumps.vault];
        let escrow_key = escrow.key();
        let vault_seeds: &[&[u8]] = &[b"vault".as_ref(), escrow_key.as_ref(), &vault_bump];
        let sweep = ctx.accounts.vault.amount;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.taker_ata_a.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            sweep,
        )?;

        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.maker.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ))
    }

    /// Cancels the offer and returns the remaining deposit. Always allowed,
    /// including after expiry; that is the whole point of expiry.
    #[allow(unused_variables)]
    pub fn refund(ctx: Context<Refund>, seed: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let vault_bump = [ctx.bumps.vault];
        let escrow_key = escrow.key();
        let vault_seeds: &[&[u8]] = &[b"vault".as_ref(), escrow_key.as_ref(), &vault_bump];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.maker_ata_a.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            ctx.accounts.vault.amount,
        )?;

        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.maker.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            &[vault_seeds],
        ))
    }
}

#[derive(Accounts)]
#[instruction(seed: u64, offer_amount_a: u64, ask_amount_b: u64, expiry: i64)]
pub struct MakeOffer<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_a: Box<Account<'info, Mint>>,
    pub mint_b: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = maker,
    )]
    pub maker_ata_a: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = maker,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", maker.key().as_ref(), &seed.to_le_bytes()],
        bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    /// PDA token account holding the deposit. Its token authority is the
    /// vault PDA itself, so only this program can move the locked tokens,
    /// and only through the take/refund paths.
    #[account(
        init,
        payer = maker,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = vault,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: u64, take_amount_a: u64)]
pub struct Take<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_a: Box<Account<'info, Mint>>,
    pub mint_b: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = mint_b,
        associated_token::authority = taker,
    )]
    pub taker_ata_b: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = maker,
    )]
    pub maker_ata_b: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = mint_a,
        associated_token::authority = taker,
    )]
    pub taker_ata_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"escrow", maker.key().as_ref(), &seed.to_le_bytes()],
        bump,
        has_one = mint_a,
        has_one = mint_b,
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint_a,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct TakeFull<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,
    /// Rent destination for both closed accounts; the maker funded them.
    #[account(mut)]
    pub maker: SystemAccount<'info>,
    pub mint_a: Box<Account<'info, Mint>>,
    pub mint_b: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = mint_b,
        associated_token::authority = taker,
    )]
    pub taker_ata_b: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint_b,
        associated_token::authority = maker,
    )]
    pub maker_ata_b: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = mint_a,
        associated_token::authority = taker,
    )]
    pub taker_ata_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"escrow", maker.key().as_ref(), &seed.to_le_bytes()],
        bump,
        has_one = mint_a,
        has_one = mint_b,
        constraint = escrow.remaining_amount_a > 0 @ EscrowError::TakeExceedsRemaining,
        close = maker,
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint_a,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Refund<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_a: Box<Account<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint_a,
        associated_token::authority = maker,
    )]
    pub maker_ata_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"escrow", maker.key().as_ref(), &seed.to_le_bytes()],
        bump,
        has_one = mint_a,
        close = maker,
    )]
    pub escrow: Box<Account<'info, Escrow>>,
    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint_a,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

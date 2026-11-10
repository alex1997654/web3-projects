use anchor_lang::prelude::*;

/// One escrow offer. The exchange rate is fixed at creation as the rational
/// ask_amount_b / offer_amount_a and never changes while the offer is open,
/// even after partial takes.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    /// Owner of the offer; the only wallet that can refund it.
    pub maker: Pubkey,
    /// Client-chosen u64; part of the PDA seeds so a maker can run several
    /// offers of the same token pair at once.
    pub seed: u64,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    /// Deposit that started the escrow, in base units. Rate denominator.
    pub offer_amount_a: u64,
    /// Full ask for the whole deposit, in base units. Rate numerator.
    pub ask_amount_b: u64,
    /// Deposit still locked in the vault. Rate-neutral: only the amounts
    /// above define the price.
    pub remaining_amount_a: u64,
    /// Unix timestamp after which only refund succeeds. 0 = no expiry.
    pub expiry: i64,
    pub bump: u8,
}

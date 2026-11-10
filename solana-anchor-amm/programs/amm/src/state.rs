use anchor_lang::prelude::*;

#[account]
pub struct Pool {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub vault_base: Pubkey,
    pub vault_quote: Pubkey,
    pub bump: u8,
}

impl Pool {
    pub const SPACE: usize = 8 + 32 * 5 + 1;
}

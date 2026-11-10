use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Amounts must be greater than zero.")]
    ZeroAmount,
    #[msg("Take amount exceeds the remaining deposit.")]
    TakeExceedsRemaining,
    #[msg("The escrow has expired and can only be refunded.")]
    EscrowExpired,
    #[msg("Expiry timestamp must be in the future.")]
    OfferAlreadyExpired,
    #[msg("Integer overflow while computing the owed amount.")]
    MathOverflow,
}

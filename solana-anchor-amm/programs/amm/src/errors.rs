use anchor_lang::prelude::*;

#[error_code]
pub enum AmmError {
    #[msg("The two pool mints must differ")]
    IdenticalMints,
    #[msg("Mints must be passed in canonical order: base mint key is below quote mint key")]
    NonCanonicalPairOrder,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Pool reserves are zero on one or both sides")]
    InsufficientLiquidity,
    #[msg("First liquidity deposit would mint less than the minimum initial LP")]
    InsufficientInitialLiquidity,
    #[msg("Output is below the supplied minimum, slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Checked arithmetic overflow")]
    Overflow,
}

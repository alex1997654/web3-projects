use anchor_lang::prelude::*;

#[error_code]
pub enum VestingError {
    #[msg("Invalid schedule: need start > 0, maturity > start, start <= cliff <= maturity")]
    InvalidSchedule,
    #[msg("Vesting amount must be greater than zero")]
    ZeroAmount,
    #[msg("Schedule index must equal the beneficiary's registry counter")]
    InvalidScheduleIndex,
    #[msg("Registry does not belong to this beneficiary")]
    RegistryMismatch,
    #[msg("Nothing has unlocked to claim yet")]
    NothingToClaim,
    #[msg("Schedule was created non-revocable")]
    ScheduleNotRevocable,
    #[msg("Schedule is already revoked")]
    AlreadyRevoked,
    #[msg("Everything already vested; nothing to revoke")]
    NothingToRevoke,
    #[msg("Vault token account does not match the schedule")]
    VaultMismatch,
    #[msg("Mint does not match the schedule's mint")]
    MintMismatch,
    #[msg("Destination is not the expected associated token account")]
    DestinationMismatch,
    #[msg("Source token account is not the authority's ATA of the mint")]
    SourceMismatch,
    #[msg("Vault holds fewer tokens than the schedule math requires")]
    VaultUnderfunded,
    #[msg("Vault still holds tokens; cannot close the schedule")]
    VaultNotEmpty,
    #[msg("Signer is not the schedule beneficiary")]
    NotBeneficiary,
    #[msg("Signer is not the schedule authority")]
    NotAuthority,
    #[msg("Checked arithmetic overflow")]
    MathOverflow,
}

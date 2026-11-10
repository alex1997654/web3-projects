use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};

use crate::errors::VestingError;

/// Read the mint's decimals straight from the fixed base layout that every
/// Token program shares: mint authority COption (4 + 32), supply u64, then
/// one decimals byte at offset 44. The Token-2022 extensions live after the
/// base, so this offset is stable.
pub fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.data.borrow();
    require!(data.len() >= 82, VestingError::MintMismatch);
    Ok(data[44])
}

/// Read a token account's amount from the fixed base layout both token
/// programs share: mint (32), owner (32), then amount u64 at offset 64.
/// The on-chain Token-2022 revision here writes a slightly longer account
/// than the spl-token-2022 3.0.x crate models, so the crate's full unpack
/// is not safe to use in-process; the base prefix is identical.
pub fn token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.data.borrow();
    require!(data.len() >= 72, VestingError::VaultMismatch);
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&data[64..72]);
    Ok(u64::from_le_bytes(raw))
}

/// Token-2022 transfer_checked, built with the spl-token-2022 instruction
/// packer and invoked directly. The on-chain program re-validates every
/// account, so nothing here depends on in-process unpacking of token state.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked<'info>(
    _token_program: AccountInfo<'info>,
    source: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        source.key,
        mint.key,
        destination.key,
        authority.key,
        &[],
        amount,
        decimals,
    )?;
    let accounts = [source, mint, destination, authority];
    if signer_seeds.is_empty() {
        invoke(&ix, &accounts)?;
    } else {
        invoke_signed(&ix, &accounts, signer_seeds)?;
    }
    Ok(())
}

/// Token-2022 close_account: hands the token account's rent to destination.
/// The on-chain program rejects the close while the account still holds
/// tokens, which is exactly the guard the close path needs.
pub fn close_token_account<'info>(
    _token_program: AccountInfo<'info>,
    account: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    owner: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = spl_token_2022::instruction::close_account(
        &spl_token_2022::ID,
        account.key,
        destination.key,
        owner.key,
        &[],
    )?;
    let accounts = [account, destination, owner];
    invoke_signed(&ix, &accounts, signer_seeds)?;
    Ok(())
}

/// Create an associated token account if it does not exist yet, billed to
/// payer. Packs the raw ATA-program instruction; no account data is
/// unpacked on this path.
pub fn create_ata_idempotent<'info>(
    _ata_program: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    ata: AccountInfo<'info>,
    owner: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
) -> Result<()> {
    let ix = spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        payer.key,
        owner.key,
        mint.key,
        token_program.key,
    );
    let accounts = [payer, ata, owner, mint, system_program, token_program];
    invoke(&ix, &accounts)?;
    Ok(())
}

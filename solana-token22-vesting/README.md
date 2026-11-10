# solana-token22-vesting

Anchor program that vests Token-2022 tokens over time. A schedule locks an
amount of a Token-2022 mint behind a cliff timestamp with linear release
until maturity, and the beneficiary claims unlocked tokens whenever they
want. Schedules can be revocable: the creator can pull back the unvested
part, while everything that already vested stays claimable by the
beneficiary. One beneficiary can hold any number of independent schedules,
each with its own vault.

Why another vesting contract. Nearly every Solana portfolio project uses the
legacy SPL Token program, but new mints launch on Token-2022, and it changes
the work in real ways: different program id in every account constraint,
ATAs derived under the token-2022 program, transfer_checked required once
fees or hooks are in play, and extension data appended after the base
account layout. This project works through those details against the real
Token-2022 program on a local validator, including an end-to-end test with a
transfer-fee mint. Vesting is also not a toy problem: launchpads and team
allocations pay for exactly this contract.

## Architecture

Two program accounts, one vault per schedule.

| Account | PDA seeds | Purpose |
|---|---|---|
| VestingSchedule | ["vesting", beneficiary, schedule_idx_le] | One schedule: parties, mint, vault, amounts, timestamps, revocation state, bump |
| BeneficiaryRegistry | ["registry", beneficiary] | u32 counter handing out schedule indices in creation order |

The vault is the schedule PDA's Token-2022 associated token account. Only
the program signs for it, so locked tokens move only through claim and
revoke.

Instructions:

- create_schedule: authority pays for accounts, locks the full amount with a
  transfer_checked CPI into the vault, stamps the schedule, bumps the
  registry counter.
- claim: beneficiary withdraws everything unlocked so far; destination ATA
  created on demand.
- revoke: authority recovers the unvested remainder; claims freeze at the
  revocation timestamp.
- close_schedule: beneficiary closes a fully drained vault and schedule,
  reclaiming both rents.
- claimable_amount: read-only view of the pending claim.

```
authority                beneficiary
   |                         |
   | create_schedule         |
   | amount ---transfer_checked---> [vault ATA of schedule PDA]
   |                         |
   |          claim (unlocked) / revoke (unvested, if revocable)
   |                         |
   v                         v
authority ATA         beneficiary ATA
```

Client pieces:

- tests/token22_vesting.ts: anchor/mocha integration tests, real Token-2022
  program on a local validator.
- app/: static browser client served from GitHub Pages. Phantom for
  signatures, hand-encoded borsh instruction data, no build step.
- scripts/devnet-demo.mjs: creates the demo mint and schedule on devnet.

## Design decisions

Vesting accrues linearly from start_ts to maturity_ts, and the cliff gates
withdrawals, not accrual. At the cliff instant the beneficiary can take
everything that accrued between start and cliff in one claim; after that the
remainder unlocks continuously to maturity. This is the standard shape for
team allocations (a year cliff, then a chunk plus linear). Two degenerate
shapes fall out naturally: cliff == start is plain linear vesting, and
cliff == maturity pays everything at maturity.

All unlock math runs in u128 intermediates with checked arithmetic, and the
release profile turns overflow-checks back on. Division floors toward the
schedule: rounding residue never pays an early claimant, and the last unit
is claimable exactly at maturity. A u64::MAX total over a multi-year span
cannot overflow the intermediate.

Every token movement uses transfer_checked, never legacy transfer. Legacy
transfer fails outright on fee-enabled Token-2022 mints, so anything else
would quietly limit which mints the program supports. One consequence worth
spelling out: schedule amounts are gross. With a transfer-fee mint the fee
is withheld inside the beneficiary's account at claim time, the vault is
debited the gross amount, and the schedule accounting stays exact. The
integration suite covers this against a 1 percent fee mint.

One implementation choice deserves its own paragraph. The program does not
deserialize token accounts with anchor-spl's typed wrappers. This validator's
Token-2022 writes a 170-byte account where the spl-token-2022 3.0.x crate
models 165 bytes, and unpacking that mismatch on SBF reads out of bounds
and kills the calling program. So vault, source, and mint arrive as plain
AccountInfos; the handler checks ATA derivations itself against the PDA
seeds, reads decimals and balances from the fixed base offsets both token
programs share (decimals at mint byte 44, amount at token-account bytes
64..72), and builds the transfer_checked / close_account CPIs with the
spl-token-2022 instruction packers, invoked raw. The on-chain token program
re-validates every account during the CPI, which is the authority that
matters anyway. The same drift means the pinned spl-token JavaScript client
misreads extended accounts (its amount parse works, its extension parse does
not), so the fee test asserts base-amount facts client-side and brackets the
claim record instead of reading withheld pots.

Each schedule owns its own vault ATA. No shared custody, no sweeping, and a
schedule's lifetime equals its vault's lifetime. close_schedule refuses
while the vault holds anything, then returns both rents to the beneficiary.

Revoke freezes instead of cancelling. The beneficiary keeps everything
vested up to revoked_at (still claimable, forever), the authority receives
only the unvested remainder. Claim math caps the effective time at
revoked_at, so no path lets a revoke take accrued tokens.

The registry is a dense counter, and schedule_idx must equal its next_index
at creation. Clients enumerate schedules with a simple 0..next_index loop.
The trade-off: the registry account (44 bytes) is never closed, so each
beneficiary leaves one dust rent account behind.

## Devnet

Program id: `A8MoJRBGw2k9MEgK9wzxjtVgpRfYLKQD6UuF9weSAdoF`

Verify it is live:

```
solana program show A8MoJRBGw2k9MEgK9wzxjtVgpRfYLKQD6UuF9weSAdoF --url devnet
```

Then poke it from the browser client (Phantom, devnet):
https://alex1997654.github.io/solana-token22-vesting/

Or from the CLI:

```
yarn node scripts/devnet-demo.mjs
```

The demo assets (a Token-2022 mint and a funded, revocable schedule) are
recreated by that script on demand; see its output for the addresses of the
day.

## Toolchain versions

Built and tested with exactly these (see ../TOOLCHAIN.md in the parent
web3-projects checkout for the shared setup):

- Ubuntu 24.04.5 LTS
- rustc/cargo 1.99.1 (host: unit tests, clippy, anchor IDL build)
- SBF compilation: rustup's "solana" toolchain, rustc 1.84.1-dev
- anchor-cli 0.30.1, solana-cli 1.18.26
- Node v18.19.1, yarn 1.22.22
- @coral-xyz/anchor 0.30.1, @solana/web3.js 1.95.4, @solana/spl-token 0.4.6
  (spl-token is pinned: later 0.4.x releases pull @solana/codecs, which
  requires Node >= 20)

The cargo graph is pinned hard, for three reasons that each cost real time:

- The SBF toolchain's cargo cannot read lockfile format v4, which host cargo
  1.99 writes by default. After any cargo update, the lock gets rewritten to
  v3 (one sed) or every SBF build dies at parse time.
- Crates whose manifests carry [lints] tables make cargo 1.99 emit --check-cfg
  flags that the 1.84 SBF rustc rejects. scripts/resolve_checkcfg.py walks
  those failures and pins each offender to a pre-2025 release without the
  table. scripts/resolve_sbf_deps.py does the same for edition-2024 manifests.
- anchor-syn 0.30.1 calls proc-macro2 span APIs that 2026 proc-macro2
  publishes behind a cfg that no longer compiles here, which breaks anchor's
  IDL build for every project on this toolchain. patches/anchor-syn vendors
  the crate with that block removed, wired in through [patch.crates-io] in
  the workspace Cargo.toml.

The workspace also shares one cargo target dir across all projects
(../.target, set by ../.cargo/config.toml). Anchor 0.30 expects build output
in the project-local target/deploy though, and it will happily deploy a
stale .so sitting there. scripts/build.sh runs anchor build and mirrors the
fresh .so with a checksum check so that cannot happen silently.

## Build, test, deploy

```
# 1. local payer keypair (gitignored; anchor test uses it against the
#    local validator, anchor deploy uses it against devnet)
yarn wallet

# 2. dependencies
yarn install

# 3. program build + unit tests + integration tests on a local validator
anchor test
```

Deploying your own devnet instance (a program id belongs to whoever holds
the program keypair, so yours will differ from the one above):

```
yarn wallet
solana airdrop 2 $(solana-keygen pubkey wallet/devnet-payer.json) --url devnet
# repeat the airdrop until the payer holds ~4 SOL; program accounts are
# rented, not staked

anchor build  # or scripts/build.sh, which also mirrors the .so into target/deploy
anchor deploy --provider.cluster devnet --provider.wallet wallet/devnet-payer.json
```

anchor build generates a fresh target/deploy/token22_vesting-keypair.json
the first time it runs and derives the program id from it. Both files stay
local; the .gitignore covers target/ and wallet/. Never commit a keypair,
not even a devnet one: whoever holds it can replace your deployed program.

## Test coverage

Rust unit tests (host, programs/token22_vesting/src/math.rs): the unlock
function on the cliff edge, mid-schedule, at and after maturity, floor
rounding under division, u64::MAX totals in u128 intermediates, the two
degenerate shapes (cliff at start, cliff at maturity), zero before the
cliff, and every rejected schedule shape (maturity before start, cliff
outside start..=maturity, non-positive start).

Integration tests (local validator, real Token-2022 and ATA programs):

- claim right after the cliff pays the accrued chunk (asserted inside the
  block-time bracket), then a full drain at maturity to exactly the total
- over-claim after maturity rejected; claim before the cliff rejected
- revoke mid-schedule returns exactly total minus unlocked(revoked_at) (read
  back from the account, exact equality), freezes the remainder for the
  beneficiary, and the second revoke is rejected
- revoke before the cliff returns the entire deposit and leaves nothing
  claimable
- revoke rejected on a non-revocable schedule
- two concurrent schedules for one beneficiary stay isolated; the registry
  counts both
- claim signed by anyone else fails the beneficiary constraint
- invalid shapes rejected at creation: maturity <= start, cliff before
  start, zero amount, index not equal to the registry counter
- close reclaims vault plus schedule rent once drained, and is refused while
  the vault holds tokens
- claimable_amount view matches the claim math within block-time resolution
- transfer-fee mint end to end: the vault is debited the full claim, the
  destination is credited the claim minus a 1 percent fee (checked exact
  within sub-unit rounding), and the claim record matches the schedule math
  inside the block-time bracket

Not covered: transfer-hook mints. A hook mint requires the receiving
program to pass the hook's extra accounts into transfers, which needs a
registered extra-accounts-metas program per mint; that is a mint-specific
integration, not a property of this program, so it is documented rather
than tested. Fee mints (above) are the extension that changes the math, and
they are covered.

## License

MIT

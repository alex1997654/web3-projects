# solana-anchor-amm

A constant-product AMM for Solana, written in Rust with Anchor 0.30.1 and deployed to devnet only. This is a portfolio project: I do freelance Solana and Rust work, and I wanted one small program where the hard parts are the math and the account layout, not the feature list. Four instructions, one pool per token pair, no admin authority anywhere.

Why publish another AMM? Mostly so a prospective client can judge the work from code and tests instead of a pitch. The interesting problems in a constant-product pool are unglamorous: rounding that always favors the pool, intermediates that cannot overflow, reserves that cannot drift from what the vaults hold. This program states each of those as a rule and the tests check them directly. It is not audited, which is why it stays on devnet.

## Architecture

### Accounts

For a pair of mints, the canonical order is lower pubkey first. Everything the program owns derives from those two keys:

- Pool PDA, seeds ["pool", base_mint, quote_mint]. 169 bytes: discriminator, five pubkeys, bump. It stores references, not reserves.
- LP mint PDA, seeds ["lp_mint", pool]. 6 decimals, mint authority is the pool PDA.
- vault_base and vault_quote, the associated token accounts of the pool PDA for the two mints. The pool PDA signs every transfer out of them.
- The user needs nothing special: ordinary ATAs for base, quote, and LP.

### Instructions

- initialize_pool() creates the pool PDA and the LP mint. No tokens move. Identical mints and pairs submitted in the wrong order are rejected here. The two vault ATAs are created by the client before the instruction (associated token accounts of the pool PDA, which is an off-curve owner); the program verifies them rather than initializing them, so the instruction only pays for two account creations.
- add_liquidity(amount_base, amount_quote, min_lp_out) reads the vault amounts, pulls both tokens in, and mints LP. The first deposit is special, see design decisions.
- remove_liquidity(lp_amount, min_base_out, min_quote_out) burns LP and transfers both sides back, proportionally, floored.
- swap(is_base_in, amount_in, min_out) takes the fee off the top and runs constant product on the remainder. An output that floors to 0 is allowed when min_out is 0; that is a dust swap, not an error.

### Client

Plain TypeScript against the Anchor IDL (target/idl/amm.json after a build). tests/amm.ts is the full suite. tests/smoke.ts is a short happy-path run on a local validator. tests/helpers/mirror.ts mirrors the on-chain math in TypeScript so the suite can assert exact values against a reference.

scripts/cli.ts is a small command-line client for walking a pool by hand: create-mints, init-pool, add-liquidity, swap, pool, demo. It derives every account from the two mint keys, prints the locally mirrored expected swap output next to the actual one, and works against any cluster via AMM_RPC / --cluster. A full round trip on a local validator:

```bash
yarn cli create-mints 5000000          # prints base and quote mints, canonical order
yarn cli init-pool <base> <quote>
yarn cli add-liquidity <base> <quote> 1000000 1000000
yarn cli swap <base> <quote> base-in 10000
# expected out (local mirror): 9876
# swap base->quote: in 10000 (...), out 9876
yarn cli pool <base> <quote>            # reserves, k, and both prices
```

There is also `demo`, which swaps base for quote and back and prints the round-trip deficit next to the fee it should cost. On the pool above, 10000 in and out of the base side loses 51 units to two legs of 25 bps plus two floors.

Account layout, one diagram:

```text
user (trader or LP)
  |  signs; owns the user token ATAs
  v
amm program: initialize_pool / add_liquidity / remove_liquidity / swap
  |  CPIs into the token program; the pool PDA signs where needed
  v
Pool PDA    seeds: ["pool", base_mint, quote_mint]
  |-- vault_base    base-mint ATA owned by the pool PDA
  |-- vault_quote   quote-mint ATA owned by the pool PDA
  +-- lp_mint PDA   seeds: ["lp_mint", pool], 6 decimals, authority = pool PDA
```

## Design decisions

### Rounding favors the pool, every time

The fee is a ceiling: ceil(amount_in * 25 / 10_000). Swap output, LP mint amounts, and withdraw amounts are all floors. A trader pays slightly more fee and receives slightly less than the exact rational result. An LP mints slightly fewer shares and withdraws slightly less than exact. Each individual loss is dust-sized; taken together they mean the pool never loses value to rounding, and the invariant test can assert that k never decreases rather than that it "approximately" holds.

### Overflow safety is structural, not defensive

All intermediates are u128. Every intermediate is a product of at most two u64 values plus a checked add, and (2^64 - 1)^2 < 2^128, so the u128 stage cannot overflow regardless of input. The Overflow error fires only when a result is narrowed back to u64 through a checked cast. No floats on-chain, no wrapping ops, no truncating as-casts, and the integer sqrt is float-free as well. The extreme-reserve tests push values near u64::MAX specifically to exercise this.

### Reserves are not stored in the pool account

The Pool account holds five pubkeys and a bump, nothing else. Each instruction reads vault_base.amount and vault_quote.amount at the start, before any CPI. There is no stored copy that could go stale, so reserve drift is impossible by construction. One consequence worth knowing: tokens that arrive in a vault outside an instruction still count as reserves, which is exactly what the first-deposit rule below defends against.

### Fees stay in the pool

The fee is subtracted from amount_in before the constant-product formula, so only the net amount crosses the curve. The fee therefore remains in the input vault, in the input token, and k grows with every swap. There is no separate fee account and no claim instruction. LPs earn fees by holding a share of a pool whose k keeps rising.

### First liquidity: floor(sqrt(base * quote)), minimum 1000

The classic first-depositor attack works like this: an attacker mints one wei of LP by depositing one wei of each token, then donates extra tokens directly to the vaults to inflate the reserves. The next depositor's share, computed as deposit * supply / reserve, floors to almost nothing, and the attacker's single wei of LP now controls half the pool.

Here the first mint is the floored geometric mean of the two deposits and must clear MIN_INITIAL_LP = 1000 (raw units, so 0.001 LP at 6 decimals). One wei of each token mints sqrt(1) = 1 and is rejected with InsufficientInitialLiquidity. Owning a real fraction of the pool requires depositing real value up front, and inflating reserves afterward costs more in donations than the theft can recover.

### One pool per pair, canonically ordered

initialize_pool requires base_mint < quote_mint by pubkey comparison, otherwise NonCanonicalPairOrder; equal mints get IdenticalMints. Because the PDA seeds are the two ordered mints, a canonical pair maps to exactly one possible pool address, and a second initialize for the same pair fails because the PDA already exists. Direction is chosen at swap time by the is_base_in flag.

### Parameters

LP decimals: 6. Fee: 25 bps, 0.25% of swap input. No governance knobs; the constants sit in math.rs.

## Devnet program ID

Deployed by the author; the deploy keypair never leaves the operator machine:

```text
DWqPzswcf4rvZSb5yGj14Cy7fnyGvrgUM17N4WnkLheY
```

Verify it, and poke an existing pool by deriving its address from the two mint pubkeys with the seeds above:

```bash
solana program show DWqPzswcf4rvZSb5yGj14Cy7fnyGvrgUM17N4WnkLheY --url devnet
solana account <POOL_PDA> --url devnet
spl-token supply <LP_MINT_PDA> --url devnet
```

A runnable demo command, an actual devnet swap, will be recorded alongside the program ID.

## Toolchain

- Rust 1.99.1 (rustc, cargo, on the host)
- Anchor 0.30.1 (anchor-cli)
- Solana/Agave CLI 1.18.26, which bundles platform-tools v1.41 (sbf rustc 1.75). The GitHub release tarball (solana-labs/solana v1.18.26) installs the same tools when release.solana.com is unreachable; this repo's CI uses the tarball
- Node 18 (18.19.1), yarn 1.22.22
- TypeScript: @coral-xyz/anchor 0.30.1, @solana/web3.js 1.95.3, @solana/spl-token 0.4.6, typescript 5, mocha with ts-node, chai

One version skew needs fixing by hand. The committed Cargo.lock is lockfile v4, which the cargo shipped inside platform-tools v1.41 (cargo 1.75) cannot read, while a current host cargo writes v4 by default. The fix is to drop a newer cargo binary into the platform-tools cache: cargo 1.78/1.79 read v4 and do not pass the --check-cfg flags the sbf rustc 1.75 would reject (cargo started emitting those at 1.80). scripts/fix-sbf-cargo.sh does exactly that, pulling the cargo 1.79 binary from the platform-tools v1.45 release on GitHub. Run it once after installing the Solana CLI, before the first anchor build. Keep Cargo.lock committed; without it a fresh resolve floats crates the old sbf toolchain cannot build.

## Build, test, deploy

The program keypair is gitignored (it lives under target/), so a fresh clone deploys its own instance under its own address.

```bash
git clone https://github.com/alex1997654/web3-projects.git
cd web3-projects/solana-anchor-amm
yarn install
./scripts/fix-sbf-cargo.sh   # one-time, see Toolchain above
mkdir -p wallets
solana-keygen new -o wallets/dev.json --no-bip39-passphrase   # test payer, gitignored
solana-keygen new -o target/deploy/amm-keypair.json --no-bip39-passphrase
anchor keys sync      # writes your keypair's pubkey into declare_id! and Anchor.toml
anchor build
anchor test
```

anchor test starts a local validator on the default ports. The payer wallet comes from the wallet field in Anchor.toml (wallets/dev.json above); the ANCHOR_WALLET environment variable overrides it. target/ holds all build output including the program keypair, and is gitignored.

For devnet, on a fresh wallet:

```bash
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet
```

## What the tests assert

Math functions carry #[cfg(test)] unit tests, run on the host with cargo test. The Anchor suite runs against a local validator through anchor test.

- Rounding direction, sweep-tested: computed swap output never exceeds the exact rational value, and the fee is never below it.
- Fee ceiling on tiny inputs: amount_in = 1 pays a fee of 1.
- k never decreases: a deterministic pseudo-random swap sequence (LCG, no rand dependency) asserts the product of the reserves never drops, fee accrual included.
- Overflow safety at the extremes: reserves and amount_in near u64::MAX go through the u128 path and are compared against a reference; no panic, no wrap. isqrt_u128 is checked on 0 through 4, on squares, on squares minus one, near u128::MAX, and at (2^64 - 1)^2.
- First liquidity: mints floor(sqrt(base * quote)); below MIN_INITIAL_LP it rejects.
- Proportional add and remove: depositing k times the reserves mints exactly k times the supply; withdrawing the full supply returns the full reserves; other cases are floored and checked against the reference.
- Slippage: all three state-changing instructions reject when output is below the minimum, with SlippageExceeded.
- initialize_pool rejections: identical mints, non-canonical pair order, and a second pool for the same ordered pair, which fails because the PDA already exists.
- Smoke: two mints, initialize, first deposit, LP supply equals the integer sqrt of the product, small base-to-quote swap, balances moved, min_out respected.

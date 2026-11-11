# solana-anchor-escrow

[![CI](https://github.com/alex1997654/solana-anchor-escrow/actions/workflows/ci.yml/badge.svg)](https://github.com/alex1997654/solana-anchor-escrow/actions/workflows/ci.yml)

A two-party SPL token escrow in Anchor. The maker locks token A in a PDA vault and names a price in token B. Anyone can take the deal and pay that price atomically, in part or in full, or the maker can cancel and get the deposit back. Offers can carry an expiry, after which only cancel works.

This is the standard screen-out question for Solana contract work, done with the parts people usually skip: partial fills with explicit rounding, optional expiry, and every account the program opens getting closed on chain with rent returned to the maker.

## Architecture

Two program accounts, both PDAs:

- `Escrow` (offer state) - seeds `["escrow", maker, seed_u64_le]`. Holds maker, seed, both mints, the original offer and ask (these two fix the price forever), the remaining deposit, the expiry timestamp, and the bump. The seed is a client-chosen u64 so one maker can run several offers on the same pair.
- `vault` - a plain SPL token account, seeds `["vault", escrow]`. Its token authority is the vault PDA itself. Only the program can move the deposit, and only through take or refund.

```
  maker ATA-A --(deposit)--> [ vault PDA ] --(take / refund)--> taker or maker ATA-A
                                   ^
  escrow PDA (price, remaining)    |
     |                             |
     |  take: taker ATA-B --pay--> maker ATA-B
```

Four instructions:

| instruction | args | what it does |
|---|---|---|
| `make_offer` | seed, offer_amount_a, ask_amount_b, expiry | Creates the escrow PDA and vault, transfers the deposit in. Also creates the maker's mint-b ATA so the offer is takeable immediately. expiry is unix seconds, 0 means none. |
| `take` | seed, take_amount_a | Strictly partial fill: 0 < take_amount_a < remaining. Taker pays ceil(taken * ask / offer) of token B, receives token A. Nothing closes. |
| `take_full` | seed | Takes all that remains, sweeps the vault, closes vault and escrow. Rent goes back to the maker. |
| `refund` | seed | Maker only. Returns the remainder, closes both accounts. Allowed at any time, including after expiry. |

## Design decisions

**Rounding is always against the taker, and the rate is frozen at creation.** The owed amount is ceil(taken_a * ask_b / offer_a) computed in u128. Any partial take costs at least its proportional share, so a taker cannot shave the price by splitting an order. The flip side: filling an offer through several partial takes can total slightly more than the full ask, since each step rounds up independently. That is deliberate. The alternative rounds against the maker. The u128 product of two u64 values cannot overflow, and with taken <= offer the result is bounded by the ask, so the checked conversions in `math.rs` are belt-and-braces rather than load-bearing. The unit tests pin that bound at the u64 extremes.

**Emptying an escrow is a different instruction from partially filling it.** `take` never closes accounts. `take_full` always closes both, using the SPL `close_account` instruction for the vault and Anchor's `close` constraint for the offer account. The alternative is one instruction with a conditional close, which means hand-rolled lamport shuffling on a code path that only runs sometimes. One extra discriminant is a cheap price for keeping close logic inside the framework.

**Decimals never enter the program.** Amounts are raw u64 base units end to end. The tests run a 6-decimal mint against a 9-decimal mint to prove no implicit scaling happens: the price is a pure integer ratio. UIs convert with the mint's decimals, the chain does not.

**No delegate approvals.** The vault PDA is its own token authority. The alternative pattern (delegating the maker's token account to a program PDA) costs an approval per offer, needs a revoke on cancel, and leaves the maker's whole balance exposed to the delegated amount. A dedicated vault costs one account of rent, which the maker gets back.

**Expiry forces refund, never theft.** After the timestamp, take and take_full fail for everyone. Refund always works. The boundary is strict: the offer is takeable only before the second, not at it.

**`init_if_needed` only where an attacker gains nothing.** It appears on the taker's two receiving ATAs and on the maker's ask-side ATA at offer creation, each pinned by `associated_token::mint` and `associated_token::authority` constraints, so a pre-created wrong account cannot be substituted. The escrow and vault use plain `init`: a second offer with the same seed fails loudly instead of overwriting.

## Devnet

Program ID: `9VcbzbGs9Et814sq6z7dLYaP6qPq6tffv2nHDSPqoeTo` (deployed by the author; the deploy keypair never leaves the operator machine)

Verify it is live:

```
solana program show 9VcbzbGs9Et814sq6z7dLYaP6qPq6tffv2nHDSPqoeTo --url devnet
```

Try it without building anything: the static demo at https://alex1997654.github.io/web3-projects/solana-anchor-escrow/docs/ walks a full offer, take, and refund cycle with a Phantom wallet on devnet. It creates throwaway tokens for you.

## Toolchain

Pinned on purpose; the dependency pins below are part of the build.

- Rust 1.99.1 as the host toolchain. The SBF side always compiles with the rustc 1.75.0-dev inside solana-cli's platform-tools, so the host rustc never touches the on-chain artifact. Two anchor 0.30.1 quirks matter for the host: the CLI must be installed from crates.io without --locked (the published lockfile pins an IDL helper that forces a rustc cfg no modern compiler accepts), and RUSTUP_TOOLCHAIN must stay unset or the same helper interpolates a broken toolchain argument
- Anchor CLI 0.30.1 from crates.io (`cargo install anchor-cli --version 0.30.1`), anchor-lang and anchor-spl pinned to =0.30.1
- Solana CLI (Agave line) 1.18.26
- Node 18.19.x, yarn 1.22.x
- `Cargo.lock` is committed and deliberately holds several transitive deps below their newest versions, because the SBF compiler is 1.75-era and current crates.io has moved past it. Known pins: borsh 1.4.0 (1.5 changed a trait anchor-lang 0.30.1 implements), proc-macro2 1.0.94 (1.0.95 dropped the span-locations API anchor-syn uses for the IDL build), the 2024-era spl-token crate family, blake3 1.8.2, and the anchor-syn 0.30.1 set. A bare `cargo update` breaks the SBF build; if you must regenerate, re-pin with targeted `cargo update -p pkg --precise ver` moves.

## Build and test

```
yarn install
anchor test          # builds, starts a local validator, deploys, runs the TS suite
cargo test -p escrow # the Rust unit tests alone
```

Deploy your own instance to devnet:

```
solana-keygen new -o target/deploy/your-keypair.json
# put the printed pubkey into declare_id! in programs/escrow/src/lib.rs
# and into Anchor.toml under [programs.devnet], then:
anchor build
anchor deploy --provider.cluster devnet
solana airdrop 2 <your wallet> --url devnet   # if the wallet is empty
```

Never commit a program keypair. A committed keypair lets anyone replace the deployed program, devnet included. This repo's `.gitignore` excludes `target/` and every `*keypair*.json`.

## Test coverage

Rust unit tests (`programs/escrow/src/math.rs`): the owed-amount function across exact division, remainders that must round up, full-take-equals-full-ask, the u64 extremes (bounded by the ask), and rejection of zero and over-offer amounts; the expiry gate at the boundary, for 0 (never), and for negative timestamps.

TypeScript integration tests (`tests/escrow.ts`, run against a local validator by `anchor test`): the full happy path with on-chain balance checks and account-closure checks; partial fills asserting the rounded prices on real balances; cancel before and after a partial take; a non-maker attempting refund (rejected; the escrow PDA seeds bind it to the maker, so the substitution fails the seed check); expired offers rejecting take while refund still succeeds; creating an offer with a past expiry rejected; take of zero, of everything, and of more than everything rejected; a settled escrow refusing a second take; and the same wallet acting as maker and taker.

Not covered: Token-2022 mints (this program targets the classic SPL Token program only) and fee/rent exact values (closure is asserted, amounts are not).

## License

MIT
# Web3 projects — Solana portfolio

Live site: https://alex1997654.github.io/web3-projects/

One repo, four example projects and the hand-written portfolio site that presents them. Everything is built to be inspected: source, tests, CI workflows per project.

## Projects

| Project | What it is | Status |
|---|---|---|
| [solana-anchor-escrow](./solana-anchor-escrow) | Two-party SPL token escrow. PDA vaults, delegated authority, atomic take or cancel. | deployed on devnet |
| [solana-anchor-amm](./solana-anchor-amm) | Constant-product AMM in Anchor. Checked u64 math, rounding direction fixed up front, slippage enforced on-chain. | deployed on devnet |
| [solana-chain-dashboard](./solana-chain-dashboard) | Live on-chain activity dashboard. Pure client-side over public RPC/WebSocket endpoints, reconnect with backoff, decoder unit-tested in isolation. | live demo |
| [solana-token22-vesting](./solana-token22-vesting) | Token-2022 vesting. Cliff plus linear release, multiple schedules, optional revocation of unvested tokens. | deployed on devnet |

Each Anchor project deploys to devnet and records its program ID in its own README with a verify command, once it lands.

## The production system behind this

My main work is a private automated trading system on Solana: a 24-crate Rust workspace, real-time ingestion over Yellowstone Geyser gRPC, protocol decoding, GPU-resident strategy evaluation, and a real execution path carrying live capital on mainnet since 2026. Built and maintained by one person. Source available under NDA; no wallet activity is published.

## The site

A single static page, hand-written HTML and CSS, no framework and no build step, served by GitHub Pages from this repo's root. Editing notes live in [docs/site.md](./docs/site.md).

## Toolchain

Rust, Solana CLI, Anchor and Node versions are pinned per project; CI installs them itself, so every workflow runs on a bare runner. See each project's README for its exact versions.

## License

MIT, see [LICENSE](./LICENSE). Each project may carry its own license file with the same terms.

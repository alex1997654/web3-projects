# solana-chain-dashboard

[![ci](https://github.com/alex1997654/web3-projects/actions/workflows/ci-dashboard.yml/badge.svg)](https://github.com/alex1997654/web3-projects/actions/workflows/ci-dashboard.yml)

Live demo: https://alex1997654.github.io/web3-projects/solana-chain-dashboard/dashboard/

## What this is

A live on-chain activity dashboard that runs entirely in the browser. It opens one WebSocket to a public Solana RPC endpoint, subscribes to a chosen program's transaction logs, decodes the Anchor events from the raw log lines client-side, and renders a rolling feed plus session stats: events per minute, cumulative SOL volume where the events carry amounts, and the top interacting wallets of the session.

It exists because chain-data plumbing is the part of Solana work that is hardest to show publicly. Production ingestion systems are private, so this is the same discipline rebuilt clean-room against public endpoints: subscription handling, reconnect with backoff, binary event decoding, and honest failure states. No backend, no database, no build-time secrets. Watched programs: pump.fun's bonding curve program on mainnet (default), the memo program, and Jupiter at instruction level.

## Architecture

```
public WSS endpoint
      |  logsSubscribe { mentions: [program] }
      v
src/ws.ts         SolanaFeed: one WebSocket, JSON-RPC, reconnect/backoff, stall watchdog
      |  LogNotification { slot, signature, err, logs[] }
      v
src/decoder/      parseLogMessages: invoke-stack attribution, then borsh decode
      |  LogItem { instruction | log | data(event) }
      v
src/stats.ts      SessionStats: rolling 60s window, volume in lamports, wallet ranking
      v
src/ui.ts         DOM rendering only, no framework, no innerHTML with dynamic data
```

Modules:

- `src/decoder/` is standalone: pure functions, zero DOM or network imports, usable from Node as-is. `base58.ts` (encoder), `borsh.ts` (cursor reader), `index.ts` (log parsing and event decoding).
- `src/programs.ts` holds the watched-program registry: addresses, event layouts, and which fields map to volume/wallet stats.
- `src/backoff.ts` is the delay calculator, pure and seeded for tests.
- `scripts/verify-live.ts` decodes live mainnet traffic and fails if more than a third of the watched program's data events go undecoded; `scripts/dump-events.ts` dumps raw payloads as hex for mapping layout changes after a program upgrade.

## Design decisions

**Log attribution by invoke stack.** A logsNotification carries the whole transaction's logs, not just the watched program's. A pump.fun buy also contains the Jupiter or PumpSwap legs, each with their own `Program data:` events. The parser tracks the `Program X invoke [n]` / `Program X success` nesting as a stack and only decodes lines emitted while the watched program is on top. Skipping this means feeding other programs' events to the wrong layouts, which is exactly the failure mode the first live capture exposed.

**Two-tier layouts, versioned per program build.** Anchor events are sha256(`event:<Name>`) discriminated and borsh bodies. The same discriminator has shipped with different bodies across program upgrades, so layouts are tried in order and one must consume the buffer exactly. For the current on-chain build, whose TradeEvent carries more fields than are mapped here, a prefix layout decodes the verified head (mint, amounts, isBuy, user, timestamp, reserves, fee recipient) and reports the unmapped tail size instead of pretending. Undecodable events render raw with their discriminator. `npm run verify:live` re-checks all of this against real traffic; that is how the current layouts were validated.

**Reconnect policy.** One endpoint, exponential backoff with jitter, capped at 60s, and the ladder resets only after a connection has stayed open for 10 seconds, so flapping does not escalate. A stall watchdog closes connections that stay open but stop delivering messages, which is how public endpoints degrade under load. Every state change surfaces in the UI: connecting, live, or reconnecting with the attempt number and a countdown. The whole state machine is unit-tested against a fake socket, and `npm run verify:reconnect` force-drops a real connection mid-stream and requires recovery.

**No failover.** There is no endpoint list and no retry-to-secondary. On rate limits or drops the app backs off and retries the same endpoint, visibly. Swapping to a different endpoint is a user action in the controls, not a silent code path. Predictable behavior on a rate-limited public endpoint was worth more than uptime theatre.

**Session semantics for stats.** A session is one connect lifecycle for one program. Automatic reconnects keep the counters, because a 2-second blip should not zero the volume; switching program or endpoint resets them. Failed transactions count in their own column and never contribute volume or wallet rankings.

## What it watches

This repo deploys no on-chain program; it is a viewer, and the demo is the GitHub Pages site itself. Presets:

| program | cluster | address |
|---|---|---|
| pump.fun bonding curve | mainnet-beta | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| memo | mainnet-beta / devnet | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` |
| Jupiter aggregator | mainnet-beta | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` |

Verify a program exists on-chain:

```
solana program show 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P --url mainnet
```

Default endpoints are the public cluster endpoints (`wss://api.mainnet-beta.solana.com`, `wss://api.devnet.solana.com`). The endpoint field is editable: point it at any RPC provider endpoint you have, nothing else changes.

## Toolchain

Pinned exact; CI installs from the lockfile.

- Node 18.19.1 (`.nvmrc`, matches the shared system toolchain; any >= 18 works)
- TypeScript 5.9.3
- Vite 5.4.21, Vitest 2.1.9
- ESLint 9.39.5 with typescript-eslint 8.72.2
- ws 8.22.2 (devDependency, used only by the Node maintenance scripts; the app itself uses the browser WebSocket)

No runtime dependencies. The shipped bundle is about 6 kB gzipped.

## Running locally

```
npm install
npm test            # unit tests
npm run dev         # dev server
npm run build       # typecheck + production build into dist/
npm run preview     # serve dist/ locally
npm run verify:live # decode live mainnet pump.fun traffic, exit nonzero on drift
npm run verify:reconnect # live: force a socket drop mid-stream, require full recovery
npm run demo:sync # rebuild + copy dist/ into the committed dashboard/ folder Pages serves
```

The demo is the committed `dashboard/` build folder, served by the monorepo's branch-based Pages at the URL above. CI fails if `dashboard/` drifts from a fresh build (`diff -r dist dashboard`), so the demo cannot silently go stale. `demo:sync` uses POSIX cp; on Windows copy `dist/` to `dashboard/` manually.

No environment variables, no keys, no accounts. Nothing to configure.

## What the tests assert

- base58: known vectors (empty, leading zeros, the bitcoin wiki vectors) and address-charset sanity for 32-byte keys.
- borsh reader: little-endian u64 including max value, two's-complement i64, bools, length-prefixed strings, and truncated reads throwing instead of returning partial data.
- decoder: discriminator dispatch, exact-length variant selection between historical layouts, prefix decode reporting the tail size, exact-over-prefix preference, unknown discriminators, invalid base64 flagged instead of thrown, and invoke-stack attribution including nested foreign-program data lines and post-return lines.
- backoff: jitter bounds, doubling, the 60s cap, and non-positive attempt clamping, with the random source injected.
- stats: sliding-window eviction, lamport-exact volume sums, wallet ranking by volume then count, null-wallet exclusion, failed-tx separation, reset.
- feed client: subscribe-on-open and the ack transition, notification mapping with the err flag, drop with attempt-1 backoff, ladder growth across unstable drops, reset after a 10s-stable connection, rate-limit style rpc error frames surfacing as notice + close + backoff, stall watchdog force-close (and staying quiet when disabled or fed), invalid endpoint rejection, and stop() going idle permanently.

Not covered by unit tests: the DOM layer, and genuine rate-limit frames from the real endpoint (the error path itself is tested with simulated frames). Live behavior is checked by `verify:live` and `verify:reconnect` against the public endpoint. Fixtures are synthetic; no real chain data is embedded.

## License

MIT

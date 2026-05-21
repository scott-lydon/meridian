# Meridian — Architecture

Authoritative architecture document. Mirrors [`plan.md`](./plan.md) decisions; this file is the prose narrative, plan.md is the table. Updates land in the same commit (per the constitution).

## Topology

```
              ┌────────────────────────────┐
              │  User wallet (Phantom)     │
              │  non-custodial             │
              └──────────────┬─────────────┘
                             │ signed tx
┌────────────────────────────▼─────────────────────────────┐
│              Solana devnet (validators)                  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Meridian Anchor program (Rust, anchor 0.31.1)   │    │
│  │  Instructions:                                   │    │
│  │   - initialize_config                            │    │
│  │   - create_strike_market                         │    │
│  │   - mint_pair       — N USDC → N Yes + N No      │    │
│  │   - place_order     — escrow + insert            │    │
│  │   - cancel_order    — refund escrow              │    │
│  │   - settle_market_manual (dev/test)              │    │
│  │   - admin_settle    — time-delayed override      │    │
│  │   - redeem          — burn token → USDC          │    │
│  │   - pause / unpause                              │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  Config PDA · Market PDA · Vault ATA · Yes/No mint PDAs  │
│  OrderBook PDA (zero-copy, 64-deep slabs per side)       │
│  USDC + Yes escrow ATAs                                  │
└──────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ getAccount / WS                  │ submit + sign
        │                                  │
┌───────┴────────────┐         ┌───────────┴──────────────┐
│  Next.js frontend  │         │  Automation service       │
│  (Vercel)          │         │  (Render, Node 20)        │
│  - Landing         │         │  - Morning cron (08:00 ET)│
│  - /markets        │         │  - Settlement (16:05 ET)  │
│  - /trade/...      │         │  - Slack alerter          │
│  - /portfolio      │         │  - /health endpoint       │
│  - /history        │         └───────────────────────────┘
│  - Wallet adapter  │
│  - TanStack Query  │
│  - Zustand UI      │
└────────────────────┘
        ▲
        │
┌───────┴────────────────────┐
│  Pyth Network Hermes       │
│  Equity feeds for MAG7     │
│  Off-chain pull            │
└────────────────────────────┘
```

## Components

### Meridian Anchor program (`programs/meridian/`)

Single Solana program. All on-chain state lives here. Slices 1, 3, 5 are merged; slice 2 (on-chain Pyth read in settle_market) and slice 4 (atomic buy_no / sell_no) are documented but deferred.

Accounts:
- `Config` (351 bytes) — admin, USDC mint, oracle thresholds, paused flag. One per program deployment.
- `Market` — one per (trading-day, ticker, strike) tuple. Holds `Outcome` enum (Pending / YesWins / NoWins) plus closing price + settled_at + admin_override flag.
- `OrderBook` (7,296 bytes) — zero-copy slabs of 64 entries per side. Bids sorted descending, asks ascending, FIFO at price. USDC escrow ATA + Yes escrow ATA owned by `book_authority` PDA.

PDAs all carry a trailing program-version byte for clean v2 coexistence.

### Order book (in-program, slab-based CLOB)

We ship our own minimal book rather than CPI into Phoenix. Reasons in [`plan.md`](./plan.md) §5.1:

- Phoenix listing required off-chain coordination at the time of writing, breaking reproducibility on devnet.
- Atomic `buy_no` (slice 4) bundles mint-pair + sell-Yes IOC in one instruction; doing the second leg via CPI to Phoenix doubles failure modes.

Trade-off: less battle-tested matcher. Mitigation: property tests planned in slice 3.5 (1000 random sequences asserting total-USDC and total-Yes conservation).

The OrderBook is `#[account(zero_copy(unsafe))]` with Pod-compatible struct layout. Order is 56 bytes, naturally aligned, side encoded as `u8` so the whole array is `bytemuck::Pod`. Without zero-copy the 28KB struct overflowed the 4KB BPF stack on borsh deserialize.

Capacity 64 per side: keeps the OrderBook under Solana's 10KB CPI-create-account limit. Plan.md D3 documents the v1.1 upgrade path (separate larger account).

### Frontend (`app/`)

Next.js 14 App Router on Vercel. Pages:

- `/` — landing
- `/markets` — grid of MAG7 cards with each ticker's active strikes (reads every Market via `program.account.market.all()`)
- `/trade/[ticker]/[market]` — order book Yes-perspective bids/asks, polled every 2s, with Buy/Sell Yes/No buttons (tx submission lands with slice 4)
- `/portfolio` — settled-market table with outcome badge + admin-override flag
- `/history` — placeholder linking to Solana Explorer

`useMeridian()` returns a typed Anchor client; writable when wallet is connected, read-only otherwise. `useMarkets()` and `useOrderBookFor()` wrap the `program.account.*` reads in TanStack Query. Branded `UsdcBase = bigint` for money math (plan.md D5).

### Automation service (`automation/`)

Node 20 + `croner` on Render. Two crons in `America/New_York`:

- `0 8 * * 1-5` — morning. Hermes parallel fetch of all 7 MAG7 prices, strike algorithm (±3/6/9% rounded to $10, deduplicated per PRD), idempotent `create_strike_market` (admin signs).
- `5 16 * * 1-5` — settlement. Per-ticker 15-min retry window with 30s intervals, confidence-bps gate, `admin_settle` for each unsettled market.

`/health` endpoint reports `lastMorningRun`, `lastSettlementRun`, next-run timestamps, and cluster. Pinned to Render's health-check.

NYSE calendar hard-coded through 2028. Weekend / holiday short-circuits with a single JSON log line.

Slack webhook alerter is optional; missing webhook falls back to logger-only output.

### Oracle (Pyth Network)

Hermes pull model for off-chain reads (morning + settlement decisions). On-chain verification lands with slice 2 via `pyth-solana-receiver-sdk` (pinned to a version compatible with anchor 0.31.1's solana-program transitive). The on-chain `settle_market` instruction will validate `publish_time` staleness and `conf` confidence band against the thresholds stored in `Config`.

All 7 MAG7 equity feed IDs were verified on Hermes 2026-05-20:

| Ticker | Feed ID (hex) |
|---|---|
| AAPL  | 5a207c4aa0114baecf852fcd9db9beb8ec715f2db48caa525dbd878fd416fb09 |
| MSFT  | 8f98f8267ddddeeb61b4fd11f21dc0c2842c417622b4d685243fa73b5830131f |
| GOOGL | 88d0800b1649d98e21b8bf9c3f42ab548034d62874ad5d80e1c1b730566d7f61 |
| AMZN  | 82c59e36a8e0247e15283748d6cd51f5fa1019d73fbf3ab6d927e17d9e357a7f |
| NVDA  | 61c4ca5b9731a79e285a01e24432d57d89f0ecdd4cd7828196ca8992d5eafef6 |
| META  | 399f1e8f1c4a517859963b56f104727a7a3c7f0f8fee56d34fa1f72e5a4b78ef |
| TSLA  | 42676a595d0099c381687124805c8bb22c75424dffcaa55e3dc6549854ebe20a |

## Data flow

### Mint pair

1. User signs `mint_pair(qty)` from the trade page or portfolio.
2. Program checks `!config.paused` and `!market.outcome.is_settled()`.
3. Transfers `qty * 1_000_000` USDC from user ATA to market vault.
4. Mints `qty` Yes to user_yes_ata and `qty` No to user_no_ata, signed by the `vault_authority` PDA.
5. Invariant: `vault_balance == total_pairs_outstanding * 1.00 USDC` holds.

### Place limit order (Bid)

1. User signs `place_order(Bid, price_ticks, qty)`.
2. Program validates price (1..=99 ticks), pulls `price_ticks * qty * 10_000` USDC from user into `usdc_escrow`.
3. Inserts an Order into bids (sorted descending; FIFO at price). Returns sequence.

### Cancel order

1. User signs `cancel_order(side, sequence)`.
2. Program finds the order (owner + sequence), removes it, refunds remaining escrow back to the user, signed by `book_authority` PDA.

### Settlement (admin override path; on-chain Pyth lands in slice 2)

1. Automation cron at 16:05 ET fetches Hermes close prices for all 7 tickers (with retry).
2. For each unsettled market today, calls `admin_settle(closing_price_micros)` signed by admin.
3. Program enforces `now >= market.admin_override_earliest` (created_at + delay).
4. Writes `Outcome { state, closing_price_micros, settled_at_unix, admin_override: true }`.

### Redeem

1. User signs `redeem(side, qty)`.
2. Program loads `Outcome`; rejects if Pending.
3. Burns `qty` of user's Yes or No tokens.
4. If user holds the winning side, transfers `qty * 1.00 USDC` from vault to user ATA.
5. Losers redeem too (burn for zero USDC; rent on the ATA returns when balance hits zero).

## Decisions table

Mirrors [`plan.md`](./plan.md) §4 verbatim. Single source of truth for the website's table.

| # | Decision | What we chose | Alternative | Why |
|---|---|---|---|---|
| 1 | Chain | Solana devnet | Arbitrum/Base/HyperLiquid | PRD recommends Solana for sub-second finality and CLOB ecosystem; devnet required to pass. |
| 2 | Smart contract framework | Anchor 0.31.1 | Raw Solana program | Account-validation macros, IDL generation, Rust client save weeks. |
| 3 | Order book | In-program slab CLOB | Phoenix CPI | Phoenix listing requires off-chain coordination; atomic Buy No needs both legs in the same program. |
| 4 | Oracle | Pyth Network (pull) | Switchboard | First-class MAG7 equity feeds, confidence intervals, pull model lets us post a fresh price at settle time. |
| 5 | USDC | Circle devnet mint | Custom stable | Real mint matches mainnet semantics. |
| 6 | Token standard | SPL Token | Token-2022 | No transfer-hook need in v1. |
| 7 | Wallet adapter | `@solana/wallet-adapter` | Single-wallet | Standard, supports Phantom + Solflare + Backpack. |
| 8 | Frontend | Next.js 14 App Router | Vite + React Router | SSR for landing; client for rest; Vercel ergonomics. |
| 9 | Server state | TanStack Query | Apollo / SWR | Best cache-invalidation primitives for chain reads. |
| 10 | Client state | Zustand | Redux / Jotai | Existing standard from boxy-fractions; selectors must not allocate. |
| 11 | Real-time | RPC WS onAccountChange | Polling only | Sub-second finality means polling misses fills. |
| 12 | Automation runtime | Node 20 + croner | Lambda / Workers | Long-running process is right for cron + future cranker. |
| 13 | Logging | pino (JSON) | Winston / console | Fastest Node logger, JSON output for Render. |
| 14 | Hosting | Vercel + Render | Render-only / Cloudflare | Vercel is the Next.js reference; Render fits Node crons. |
| 15 | Pre-commit | prek | Husky / lefthook | Project standard. |
| 16 | Tests | anchor test + proptest + vitest | jest / mocha | proptest for invariants; vitest is fast and ESM-native. |

## Trade-offs

### Slab-based in-program book vs Phoenix CPI

Accept: less battle-tested matcher, more code we own. Knowing: Phoenix matched real volume on mainnet for over a year. Mitigated by property tests (1000 random sequences per CI run) asserting total-USDC and total-Yes conservation, plus a manual fuzzing harness. When it would bite: subtle ordering bug nobody happens to write a test for. Triggers a revisit: v1.1 if depth > 64 is needed, or if a matching bug surfaces in production.

### Pyth pull vs Switchboard

Accept: dependence on Pyth's Hermes service for off-chain price fetch. Mitigated by 15-min retry window + admin override fallback. Triggers a revisit: > 1 Hermes outage per quarter.

### Position constraint as UX rule, not program invariant

Accept: a determined user with a CLI can hold both Yes and No simultaneously. Spec carves out market makers transient state. Mitigated by frontend blocking. Triggers a revisit: if user feedback shows confusion in the demo.

### Devnet vs mainnet for v1

Accept: demo runs on testnet with faucet USDC. Mainnet deploy is documented bonus, separate review.

## Risks and limitations

- Devnet only for v1 (constitution §2.2).
- Pyth dependency for settlement; admin override is the fallback.
- Same-day expiry (PRD: 0DTE).
- Position constraint is a UX rule, not a program invariant.
- No regulatory or compliance claims (PRD requirement).

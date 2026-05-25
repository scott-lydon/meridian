# Meridian — Architecture

Authoritative architecture document. Mirrors [`plan.md`](./plan.md) decisions; this file is the prose narrative, plan.md is the table. Updates land in the same commit (per the constitution).

## Topology

The backend is a Solana program (Anchor 0.31.1) deployed on Solana devnet.
Two off-chain Render services support it: a Next.js UI (the product surface)
and a Node automation keeper. Both are clients of the program; neither holds
business logic or user funds. The UI talks to Solana directly; it does NOT
route through the keeper. Phantom or Solflare (any Wallet Standard wallet)
signs transactions inside the user's browser.

```
┌─────────────────────── User's browser ─────────────────────────┐
│                                                                │
│   ┌──────────────────────────┐    ┌──────────────────────────┐ │
│   │ Phantom or Solflare      │ ──►│ Next.js 14 UI            │ │
│   │ (Wallet Standard)        │ ⏎ sign tx                     │ │
│   │ non-custodial            │    │ served from Render        │ │
│   └──────────────────────────┘    │ - landing                 │ │
│                                   │ - /markets, /trade        │ │
│                                   │ - /portfolio, /history    │ │
│                                   │ - wallet adapter          │ │
│                                   │ - TanStack Query          │ │
│                                   └────────────┬──────────────┘ │
└────────────────────────────────────────────────┼────────────────┘
                                                 │ RPC + WS
                                                 ▼
┌──────────────── Solana devnet (decentralized backend) ─────────┐
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Meridian Anchor program (Rust, anchor 0.31.1)            │  │
│  │ ERtAbZetHFVmFKyTzfJd9LdMGsqu5b2TWeWc65sikPaX             │  │
│  │ Instructions: initialize_config, create_strike_market,   │  │
│  │ mint_pair, place_order, cancel_order, settle_market_*,   │  │
│  │ admin_settle, redeem, pause, unpause                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  Config PDA · Market PDA · Vault ATA · Yes/No mint PDAs        │
│  OrderBook PDA (zero-copy, 64-deep slabs per side)             │
│  USDC + Yes escrow ATAs                                        │
│                                                                │
└────────────────────────────────────────────────────────────────┘
        ▲                                          ▲
        │ cron 08:00 ET create_strike_market       │ on-chain verify
        │ cron 16:05 ET admin_settle               │ (slice 2)
        │                                          │
┌───────┴────────────────────┐         ┌───────────┴────────────┐
│ Automation keeper          │         │ Pyth Hermes            │
│ Node 20 + croner on Render │◄────────┤ MAG7 equity feeds      │
│ holds admin keypair        │  prev   │ off-chain pull         │
│ /health endpoint           │  close  └────────────────────────┘
│ Slack alerter              │
└────────────────────────────┘
```

**Notes on the topology:**

- The Next.js UI is *not* the backend. It is a Solana client that runs in the
  user's browser. It is *served from* Render but it *talks to* Solana RPC
  directly. If the Render UI service died, anyone with their own client could
  still trade against the program.
- The automation keeper is also a Solana client. It owns the admin keypair
  and runs scheduled jobs (create markets at 08:00 ET, settle at 16:05 ET),
  but it is not on the user-trade path. If the keeper died, existing
  positions would be unaffected. New market creation and automatic
  settlement would pause until the keeper recovered.
- The on-chain program is the only source of truth for markets, order books,
  positions, and USDC custody. It is decentralized in the sense that it
  executes on the Solana validator network. We retain the upgrade authority
  (we have not transferred or burned it), so the program is *not* upgrade-
  immutable. Mainnet promotion would burn the upgrade authority.
- Wallet support is multi-provider via the Solana Wallet Standard. Phantom,
  Solflare, and Backpack all register themselves and appear in the connect
  modal automatically. The wallet adapter is configured with an empty
  `wallets` array on purpose. See
  [`app/src/components/WalletProvider.tsx`](./app/src/components/WalletProvider.tsx).

## Components

### Meridian Anchor program (`programs/meridian/`)

Single Solana program. All on-chain state lives here. Slices 1, 3, 4, 5 are merged (slice 4 added `buy_no.rs` and `sell_no.rs` with the atomic single-best-only fill semantics described in [Atomic instructions as compositions of vanilla operations](#atomic-instructions-as-compositions-of-vanilla-operations) below). Slice 2 (on-chain Pyth read in `settle_market`) is documented but still uses `admin_settle` in production.

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

Next.js 14 App Router served from Render (the `meridian-app` service in `render.yaml`); the page code itself runs inside the user's browser. Pages:

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

## YES and NO mechanics (single-book design)

Meridian has one on-chain order book per market, and it trades YES only. There is no NO order book and no `place_no_order` instruction. NO liquidity is synthesized by combining a pair mint (or burn) with a YES-book trade. This section captures the consequences of that choice.

### Two ways YES/NO pairs come into existence

Both are user-signed Solana transactions. Nothing mints on a timer or as an event-driven side effect.

1. **`mint_pair(qty)`** ([`mint_pair.rs`](./programs/meridian/src/instructions/mint_pair.rs)). The user signs the instruction directly. The program pulls `qty * $1.00` USDC from the user's USDC ATA into the market PDA's collateral vault, then the `vault_authority` PDA signs two `mint_to` CPIs against the SPL Token program: `qty` YES into the user's YES ATA and `qty` NO into the user's NO ATA. Pairs outstanding rises by `qty`. The vault invariant `vault_balance == yes_supply == no_supply` holds.

2. **`buy_no(qty, min_bid_price_ticks)`** ([`buy_no.rs`](./programs/meridian/src/instructions/buy_no.rs)). The user signs once. The instruction is immediate-or-cancel against the **single best resting YES bid** (`bids[0]`). It does NOT walk the slab; the entire `qty` must fit against that one bid or the whole transaction reverts. The slippage parameter `min_bid_price_ticks` is a **floor** on the resting YES bid price the user will accept, not a "Buy No price" — the frontend computes it as `100 − target_no_price_ticks` before calling. The three pre-flight checks (`buy_no.rs` lines 143-183):

```rust
// programs/meridian/src/instructions/buy_no.rs lines 153-173 (abridged)
if book.bids_len == 0 {
    msg!("IocPartialFillRejected: no bids in book — buy_no needs liquidity");
    return err!(MeridianError::IocPartialFillRejected);
}
let bid = book.bids[0];
if bid.qty < qty {
    msg!("IocPartialFillRejected: best_bid_qty={} < requested_qty={}", bid.qty, qty);
    return err!(MeridianError::IocPartialFillRejected);
}
if bid.price_ticks < min_bid_price_ticks {
    msg!("IocPartialFillRejected (slippage): best_bid_price={} < min_required={}", bid.price_ticks, min_bid_price_ticks);
    return err!(MeridianError::IocPartialFillRejected);
}
```

On the success path the program: (a) pulls `qty * $1.00` USDC from the user into the vault, (b) the `vault_authority` PDA mints `qty` YES and `qty` NO to the user, (c) transfers the freshly-minted YES from the user's YES ATA **directly** to the bid maker's YES ATA (skipping `yes_escrow` — the escrow shortcut described below), (d) the `book_authority` PDA transfers `qty * filled_bid_price` USDC out of `usdc_escrow` to the user, (e) decrements or removes the bid in the slab. The user keeps the NO; their net cost is `qty * ($1.00 − filled_bid_price)`. Note that `filled_bid_price` may be **strictly greater** than `min_bid_price_ticks` if `bids[0]` was a richer-than-floor bid; in that case the user pays LESS than their target No price. The floor is a ceiling on cost, never a fixed price.

The symmetric inverse: **`sell_no(qty, max_ask_price_ticks)`** ([`sell_no.rs`](./programs/meridian/src/instructions/sell_no.rs)) fills against the single best resting YES ask (`asks[0]`), full-`qty`-or-revert, with `max_ask_price_ticks` as the **ceiling** on the YES ask the user will pay. The atomic sequence (`sell_no.rs` lines 181-279): (a) user pays `qty * filled_ask_price` USDC straight to the ask maker's USDC ATA (the symmetric escrow shortcut: payment goes direct, not through `usdc_escrow`), (b) `yes_escrow` releases `qty` YES to the user transiently, (c) the user's `qty` YES and `qty` NO are burned, (d) the vault releases `qty * $1.00` to the user, (e) `asks[0]` decrements. Net proceeds: `qty * ($1.00 − filled_ask_price)`.

`redeem_pair` ([`redeem_pair.rs`](./programs/meridian/src/instructions/redeem_pair.rs)) is the third member of this family: a pure operation, no order book interaction, that burns `qty` YES + `qty` NO from the user and releases `qty * $1.00` from the vault. It works pre-settlement only (post-settlement, `redeem` is the asymmetric winner-pays-$1, loser-pays-$0 path). It is the inverse of `mint_pair`.

### Atomic instructions as compositions of vanilla operations

The deep insight, surfaced during architecture review: `buy_no` and `sell_no` are not new primitives. They are **atomic wrappers around sequences of vanilla `mint_pair` / `place_order` / `match_orders` / `redeem_pair` calls** that the user could perform manually but with worse UX and a vulnerable mid-flow state.

```
Atomic buy_no(qty, min_bid)              Manual three-step equivalent
─────────────────────────────────        ─────────────────────────────────────
1. user_usdc → vault (qty * $1)         1. mint_pair(qty)
2. mint qty YES → user_yes                  (deposits qty * $1, mints YES+NO)
3. mint qty NO  → user_no
4. user_yes → bid_maker_yes (qty)        2. place_order(Ask, min_bid, qty)
   (skips yes_escrow)                       (escrows qty YES into yes_escrow)
5. usdc_escrow → user_usdc               3. (wait one slot for cranker)
   (qty * filled_bid_price)                 match_orders crosses best bid:
6. decrement bids[0]; remove if zero        - yes_escrow → bidder's YES ATA
                                            - usdc_escrow → user_usdc (filled_bid_price)
One signature, one slot, one popup,      Three signatures, two popups, two slots,
escrow shortcuts skip two token CPIs.    cleaner state machine but more friction.
```

```
Atomic sell_no(qty, max_ask)             Manual three-step equivalent
─────────────────────────────────        ─────────────────────────────────────
1. user_usdc → ask_maker_usdc            1. place_order(Bid, max_ask, qty)
   (qty * filled_ask_price)                 (escrows qty * max_ask USDC)
   (skips usdc_escrow)                   2. (wait one slot for cranker)
2. yes_escrow → user_yes (qty)              match_orders crosses best ask:
   (transient)                              - asker's escrowed YES → user_yes
3. burn qty YES from user_yes               - usdc_escrow → asker's USDC
4. burn qty NO  from user_no             3. redeem_pair(qty)
5. vault → user_usdc (qty * $1)             (burn YES + NO, release qty * $1)
6. decrement asks[0]; remove if zero
                                         Three signatures, two popups,
One signature, one slot, one popup.      mid-flow holds a complete pair that
                                         is a fully-hedged no-op if the user
                                         navigates away.
```

So a user "selling a No" is mechanically buying its complement (a YES) at the inverse price and cashing in the resulting pair against the vault. The bookkeeping nets out: the cost of buying the YES, minus the $1 released by `redeem_pair`, equals exactly `$1 − filled_ask_price`, the inverse-Yes-price proceeds on the NO.

The atomic instructions exist for two reasons. First, UX: one signature instead of three, one wallet popup instead of two. Second, atomicity: the manual three-step can leave the user holding a complete YES+NO pair mid-flow (after step 2, before step 3), which is a fully-hedged no-op position they did not ask for. The atomic wrappers eliminate that mid-state by collapsing the sequence into one transaction that either fully succeeds or fully reverts.

### Where each token actually moves

The single-book design creates an asymmetry in how YES and NO flow through the protocol. YES can transfer between wallets via the order book; NO cannot. NO is created and destroyed by mint and burn operations only. The full enumeration:

```
   YES token lifecycle                       NO token lifecycle
───────────────────────────────────────     ───────────────────────────────────────
mint_pair                                   mint_pair
  → minted into user's YES ATA                → minted into user's NO ATA

place_order(Ask, price, qty)                (no equivalent — no "place NO order")
  → moves user_yes → yes_escrow

match_orders crosses an ask                 (no equivalent — no NO matching)
  → moves yes_escrow → bidder's YES ATA
  → REAL TRANSFER, no burn, no mint

cancel_order on a resting ask
  → moves yes_escrow → canceller's YES ATA

buy_no                                      buy_no
  → mints fresh YES into user_yes               → mints fresh NO into user_no
    (transient)                                   (this is the user's final position;
  → immediately transfers user_yes →               never moves again inside buy_no)
    bid_maker_yes (the resting bidder)

sell_no                                     sell_no
  → pulls existing YES from yes_escrow          → BURNS user's existing NO
    into user_yes (transient)                     alongside the YES
  → BURNS user_yes alongside user_no

redeem_pair (pre-settlement)                redeem_pair
  → burns user's YES                            → burns user's NO

redeem at settlement                        redeem at settlement
  → burns user's YES, pays $1 if               → burns user's NO, pays $1 if
    YES won, $0 if NO won                        NO won, $0 if YES won

SPL transfer (outside Meridian)             SPL transfer (outside Meridian)
  → wallet-to-wallet, no Meridian               → wallet-to-wallet, no Meridian
    instruction involved                          instruction involved
```

The "(no equivalent)" rows for NO are the structural source of the asymmetry. Because there is no NO order book and no NO matching, the only way an existing NO can leave one wallet **as part of a trade** is to be burned (in `sell_no` or `redeem_pair`). The buyer of NO gets a freshly minted token. The asymmetry pays for the vault invariant: every NO in circulation is matched to exactly one pair's worth of USDC in the vault, with no "secondhand NO" floating that the protocol does not know about.

### The escrow shortcut in the atomic instructions

The atomic `buy_no` and `sell_no` are slightly more efficient on chain than the manual three-step decompositions above. They skip the `yes_escrow` / `usdc_escrow` round trip that a resting order requires.

- In `buy_no`, the freshly-minted YES goes user → bid maker directly (line 237-247 of `buy_no.rs`). The YES never sits in `yes_escrow` because there is no resting order — the YES exists only for the instant between `mint_to` and `transfer`.
- In `sell_no`, the user's USDC payment goes straight to `ask_maker_usdc` (line 190-200 of `sell_no.rs`). It never sits in `usdc_escrow` because the take is immediate.

Escrow accounts exist for **resting orders** that need to park collateral while waiting for a counterparty. Takes that consume an existing resting order can shortcut around the escrow because the maker's side is already in escrow and the taker's side is moving in the same instruction. Two token-program CPIs saved per atomic take, modest CU win, conceptually clean.

### Why there is no second book

Three reasons. Each one would otherwise add real cost.

* **Storage**. The current `OrderBook` is 7,296 bytes (depth 64 per side). A second book doubles that, and Solana CPI account creation caps at 10KB per account, so two books per market either burn more lamports for rent on separate accounts or require a depth cut.
* **Cranker work**. `match_orders` ([`match_orders.rs`](./programs/meridian/src/instructions/match_orders.rs)) crosses one resting bid against one resting ask per call. Two books means twice the cranker calls and twice the off-chain orchestration.
* **Cross-book consistency invariant**. If a NO book existed independently, the sum of the best YES bid and the best NO bid could exceed $1, which is a free-money arbitrage at the protocol's expense (mint pair for $1, sell both legs for >$1, repeat). The program would have to police that sum on every order insertion. The single-book design removes that whole class of state machine.

### Pricing: NO price = $1 − YES price, enforced by arbitrage

The mint and redeem rails are the arbitrage rails. Pricing is pinned, not just observed.

If `YES_price + NO_price > $1`, anyone can `mint_pair` for $1, sell the YES leg at market and the NO leg at market, and pocket the difference. They repeat until the prices fall to $1. If `YES_price + NO_price < $1`, anyone can buy a YES and a NO at market for less than $1, call `redeem_pair`, and receive $1 from the vault. They repeat until prices rise to $1. So in equilibrium, the two sum to exactly $1.

The bid and ask side flip when crossing from YES to NO. The cheapest way to acquire NO is via the highest YES bid (the price you pay for NO is `$1 − best YES bid`). The most you receive selling NO is via the lowest YES ask (your proceeds are `$1 − best YES ask`). Spread width is preserved; the mid is reflected around $0.50.

Concrete example. With YES best bid = $0.55 and YES best ask = $0.60: NO mark price is $0.425, the cheapest NO purchase costs $0.45 (via `buy_no` hitting the $0.55 YES bid), the most a NO seller receives is $0.40 (via `sell_no` lifting the $0.60 YES ask).

### Capabilities, YES vs NO

| Capability | YES | NO |
|---|---|---|
| Mint (paired with the other side) | yes (`mint_pair`) | yes (`mint_pair`) |
| Burn for $1 pre-settlement (paired) | yes (`redeem_pair`) | yes (`redeem_pair`) |
| Redeem at settlement | yes (`redeem`; winning side pays $1, losing side $0) | yes (`redeem`; same) |
| Free SPL transfer | yes | yes |
| Atomic IOC take-liquidity buy | `place_order(Bid, P)` posted at the best ask, cleared by next `match_orders` crank (no IOC mode in v1) | `buy_no(qty, min_bid_price_ticks)` — single-best-only fill against `bids[0]`, full `qty` or revert; `min_bid_price_ticks` is a FLOOR on the YES bid (not a No price); UI computes `100 − target_no_price` |
| Atomic IOC take-liquidity sell | `place_order(Ask, P)` posted at the best bid, cleared by next `match_orders` crank | `sell_no(qty, max_ask_price_ticks)` — single-best-only fill against `asks[0]`, full `qty` or revert; `max_ask_price_ticks` is a CEILING on the YES ask (not a No proceeds price) |
| Resting LIMIT buy at price P | `place_order(Bid, P)` — **one instruction**, locks `P * qty` USDC | `mint_pair(qty)` then `place_order(Ask, $1 − P, qty)` — **two instructions**, locks `$1 * qty` USDC until ask fills |
| Resting LIMIT sell at price P | `place_order(Ask, P)` — **one instruction**, locks `qty` YES | `place_order(Bid, $1 − P, qty)` then `redeem_pair(qty)` after fill — **two instructions**, non-atomic gap between fill and redeem, locks `($1 − P) * qty` USDC |

Settlement, redemption, transfer, and IOC market-take are fully symmetric. The asymmetry is concentrated in one place: posting a resting limit order to the book takes one instruction on the YES side and two on the NO side.

### Caveats on the two-instruction NO limit-order paths

These are ergonomic costs, not pricing-power costs. A NO holder negotiates price equally well; they just pay for it in instruction count and, on the buy side, in temporarily-locked capital.

* **Buy NO at limit P, capital lockup.** The user mint-pairs for the full $1, even though they only "really" intend to spend `(1 − P)` on the NO. The other `P * qty` is parked as escrowed YES while the ask waits to be filled. If the ask never fills, the user can `cancel_order` to recover the YES, then `redeem_pair` to recover the $1. A hypothetical native "buy NO at limit P" instruction would escrow only `(1 − P) * qty`. The two-instruction route trades capital efficiency for design simplicity.
* **Sell NO at limit P, non-atomicity gap.** The YES bid rests in the book; the NO sits in the user's wallet. `redeem_pair` is a separate call the user must submit after their bid fills. If settlement happens in the gap, the user holds the (YES, NO) pair into resolution; calling `redeem` on the winning side recovers $1 (the same amount `redeem_pair` would have), so the user is procedurally inconvenienced rather than economically harmed. A frontend or bot that watches for fills closes the gap to roughly one slot of latency.

### What "the user signs" means, end to end

Every state-changing call into the program requires a wallet signature. In `buy_no.rs` (and every other instruction), the Accounts struct declares `pub user: Signer<'info>`, which Anchor compiles to a runtime check that the transaction carries a valid signature from the account passed as `user`. In the UI this corresponds to the wallet popup ("Meridian · buy_no · Approve / Reject"): the user's browser wallet (Phantom, Solflare, Backpack via the Solana Wallet Standard) cryptographically signs the transaction bytes with the user's private key, then submits to a Solana validator. There is no daemon and no privileged service that signs on the user's behalf. The cranker (`match_orders`) is permissionless and signs only as itself, and it never mints anything; it only crosses an already-resting YES bid against an already-resting YES ask.

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
| 8 | Frontend | Next.js 14 App Router on Render | Vite + React Router | SSR for landing; client for trading. One Render platform for both services. |
| 9 | Server state | TanStack Query | Apollo / SWR | Best cache-invalidation primitives for chain reads. |
| 10 | Client state | Zustand | Redux / Jotai | Existing standard from boxy-fractions; selectors must not allocate. |
| 11 | Real-time | RPC WS onAccountChange | Polling only | Sub-second finality means polling misses fills. |
| 12 | Automation runtime | Node 20 + croner | Lambda / Workers | Long-running process is right for cron + future cranker. |
| 13 | Logging | pino (JSON) | Winston / console | Fastest Node logger, JSON output for Render. |
| 14 | Hosting | Render for both services | Vercel + Render / Cloudflare | One platform keeps deploy contracts, env-var management, and on-call surface consistent. |
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

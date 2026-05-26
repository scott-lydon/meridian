# Meridian Architectural Plan

How it gets built. Architecture, tech choices, data flow, decisions table, trade-offs, sequencing.

This plan is the source of truth for `ARCHITECTURE.md` and `website/index.html`. The decisions table here is the data those documents render; they MUST NOT diverge. If the website disagrees with this plan, this plan wins.

The plan optimizes against `spec.md`'s user stories under the constraints in `constitution.md`. If a decision below violates the constitution, the decision is wrong; if it violates the spec, the spec is wrong and gets amended first.

---

## 1. System topology

```
                           ┌───────────────────────────────────────────┐
                           │   User wallet (Phantom / Solflare /       │
                           │   Backpack / Coinbase Wallet)             │
                           │   non-custodial, signs                    │
                           └───────────────────┬───────────────────────┘
                                         │ tx + sigs
                                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       Solana devnet (validators)                       │
│  ┌───────────────────────┐   ┌────────────────────────────────────┐    │
│  │  Meridian Anchor      │   │  Pyth Network Price Receivers      │    │
│  │  program (Rust)       │   │  (push or pull stock equity feeds) │    │
│  │  - initialize_config  │   └─────────────────┬──────────────────┘    │
│  │  - create_strike      │                     │  read on-chain        │
│  │  - mint_pair          │ ◄───────────────────┘                       │
│  │  - place_order        │                                             │
│  │  - cancel_order       │                                             │
│  │  - match (cranked)    │                                             │
│  │  - buy_no (atomic)    │                                             │
│  │  - sell_no (atomic)   │                                             │
│  │  - settle_market      │                                             │
│  │  - admin_settle       │                                             │
│  │  - redeem             │                                             │
│  │  - pause / unpause    │                                             │
│  └───────────────────────┘                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────────────┐  │
│  │  Config PDA     │  │  Market PDA     │  │  Order book PDA         │ │
│  │  (admin, oracle │  │  (1 per strike  │  │  (1 per market, slabs)  │ │
│  │   thresholds)   │  │   per day)      │  │                         │ │
│  └─────────────────┘  └─────────────────┘  └────────────────────────┘  │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────────────────┐  │
│  │ Yes mint   │  │ No mint    │  │ USDC vault (PDA-owned token acct)│  │
│  └────────────┘  └────────────┘  └──────────────────────────────────┘  │
└──────────┬──────────────────────────────────┬──────────────────────────┘
           │ getAccount / WS subscribe        │ submit + crank
           ▼                                  ▼
┌───────────────────────────────┐  ┌────────────────────────────────────┐
│  Next.js frontend (Vercel)    │  │  Automation service (Render)        │
│  - Landing, Markets, Trade,   │  │  - Morning cron (08:00 ET)          │
│    Portfolio, History         │  │  - Settlement cron (16:05 ET)       │
│  - TanStack Query for chain   │  │  - Crank loop (matching, idle)      │
│    state, Zustand for UI      │  │  - NYSE calendar check              │
│  - Anchor TS client           │  │  - Retry policy + Slack alert hook  │
│  - WS to RPC for live updates │  │  - Health check at /health          │
└───────────────────────────────┘  └────────────────────────────────────┘
```

Three deployable artifacts: the Anchor program (one program-id, deployed once), the frontend (continuously deployed to Vercel on push), and the automation service (continuously deployed to Render on push). The order book lives inside the Anchor program. Pyth is an external dependency we read; we do not deploy oracle infrastructure ourselves.

Per the constitution's dual-push rule, every commit fans out to GitHub and GitLab. Vercel and Render both watch GitHub for deploy hooks.

## 2. Component breakdown

### 2.1 Meridian Anchor program

**Responsibility.** All on-chain state. Minting, the order book, matching, settlement, redemption, admin operations.

**Why one program (not three).** Buy No and Sell No are atomic: mint-then-sell-Yes and buy-Yes-then-redeem-pair, respectively. Atomicity means one transaction, one signature, and either all instructions land or all revert. Splitting minting and the order book across two programs would require CPI from one program into another for every Buy No, which costs an extra account list, an extra signer permission negotiation, and an extra failure mode. One program keeps the atomicity boundary inside the same code that owns the vault.

**State accounts.**

| Account | Seeds | Owner | Purpose |
|---|---|---|---|
| `Config` | `[b"config", version]` | program | admin pubkey, USDC mint, oracle feed addresses per ticker, staleness threshold, confidence threshold, paused flag, admin override delay seconds |
| `Market` | `[b"market", trading_day_unix, ticker_bytes, strike_le_u64]` | program | strike, ticker, expiry timestamp, oracle feed ref, yes_mint, no_mint, vault, order_book, settlement_state, is_admin_override |
| `OrderBook` | `[b"book", market_pubkey]` | program | bids slab, asks slab, sequence number |
| `Vault` | `[b"vault", market_pubkey]` | program | USDC SPL token account (PDA-owned) |
| `YesMint` | `[b"yes", market_pubkey]` | program | SPL mint, authority = program PDA |
| `NoMint` | `[b"no", market_pubkey]` | program | SPL mint, authority = program PDA |

Every PDA includes a 1-byte program version in its seeds so a future v2 deployment can run side-by-side without account collisions. See `constitution.md` §3 ("PDAs: deterministic seeds documented in a `// seeds:` comment on each derivation").

**Instructions.**

- `initialize_config` — one-time, called by admin in the deploy script.
- `create_strike_market` — admin or automation key calls once per strike per day. Initializes `Market`, `OrderBook`, `Vault`, `YesMint`, `NoMint`.
- `add_strike` — admin convenience; same logic as create with explicit strike.
- `mint_pair` — user deposits N USDC, receives N Yes and N No.
- `place_order(side, price_ticks, qty)` — user posts a resting limit order on the Yes book. Pure inserter: escrows the relevant token (USDC for a Bid, Yes for an Ask) and pushes a new entry into the slab. No matching, no IOC mode, no cross-side reads. Implementation in `programs/meridian/src/instructions/place_order.rs`.
- `cancel_order` — user cancels an unfilled order; returns escrow.
- `match_orders` — permissionless cranker entrypoint. One cross per call: checks `best_bid.price >= best_ask.price`, fills `min(bid.qty, ask.qty)` at the older order's price (price-time priority), pays USDC to the seller and Yes to the buyer, refunds the bidder's spread when the bidder is the taker. Does NOT walk the slab inside a single instruction; the cranker re-invokes until no cross remains. Implementation in `programs/meridian/src/instructions/match_orders.rs`.
- `buy_no(qty, min_bid_price_ticks)` — atomic: pulls `qty * $1.00` USDC into the vault, mints `qty` Yes + `qty` No to the user, transfers the freshly-minted Yes to the single best resting Yes bidder, pays the user `qty * filled_bid_price` from `usdc_escrow`. The `min_bid_price_ticks` parameter is a FLOOR on the Yes bid the user will accept; the user does not pass a No price. Fills against `bids[0]` only and requires the entire `qty` to fit in that single bid; otherwise `IocPartialFillRejected` reverts the whole transaction (no orphan tokens). Implementation in `programs/meridian/src/instructions/buy_no.rs`.
- `sell_no(qty, max_ask_price_ticks)` — atomic: user must hold `qty` No. Pays the single best resting Yes asker `qty * filled_ask_price` USDC, releases `qty` Yes from `yes_escrow` to the user transiently, burns user's `qty` Yes + `qty` No, releases `qty * $1.00` from the vault to the user. `max_ask_price_ticks` is a CEILING on the Yes ask the user will pay; the user does not pass a No proceeds price. Fills against `asks[0]` only with full-`qty`-or-revert semantics. Implementation in `programs/meridian/src/instructions/sell_no.rs`.
- `settle_market` — reads the oracle, validates staleness and confidence, writes the outcome account. Caller pays compute; anyone can call after 16:00 ET.
- `admin_settle` — admin-only fallback. Enforces the 1-hour delay on-chain via `Clock::get()`.
- `redeem` — burns user's Yes or No tokens, transfers USDC out of the vault according to the outcome. Works for losers too (returns rent, pays zero USDC).
- `pause` / `unpause` — admin toggles the paused flag in Config. Mint and order-book entry instructions check the flag; redeem does not (see constitution §2.12).

**Compute and account-list budgets.** Solana has a per-tx compute budget (currently 1.4M CUs) and a per-tx account-list cap (currently 64 accounts). `buy_no` and `sell_no` each fill against exactly one resting order (`bids[0]` for `buy_no`, `asks[0]` for `sell_no`) and either fit the full `qty` against that single entry or revert with `IocPartialFillRejected`. Because there is only ever one maker per atomic-take tx, the account-list is fixed: signer, user's USDC/Yes/No ATAs, Yes mint, No mint, vault, market, order book, token program, plus exactly one maker ATA (`bid_maker_yes` for `buy_no`, `ask_maker_usdc` for `sell_no`). To consume liquidity at multiple price levels in one position-build, the frontend sends N separate atomic-take transactions; v1 does not walk a slab inside a single instruction.

### 2.2 In-program order book (the CLOB)

**Decision.** Ship a minimal in-program book inside the Meridian program rather than CPI into Phoenix.

**Why.** Three reasons. First, Phoenix market listing is permissioned through their UI flow at the time of writing, which adds an off-chain step to each new strike and breaks reproducibility on devnet. Second, the atomic Buy No path needs to bundle mint-pair and the Yes-sell in one instruction; with Phoenix we'd CPI into a separate program for the second leg, doubling the failure surface. Third, the PRD calls out building a minimal book as the "more ambitious" path that "demonstrates deeper understanding." We accept the implementation cost in exchange for control and a cleaner story for the architecture defense.

**Trade-off.** Phoenix's matching engine is battle-tested; ours is not. We mitigate with property tests on the matching algorithm (1000 random order sequences, asserting invariants: total USDC conservation, total Yes conservation, price-time priority).

**Data structure.** Bids and asks are stored as two fixed-capacity slab arrays (linked-list-on-array, the same pattern as Serum v3 used). Each entry is `(qty, sequence, owner, price_ticks, side, _pad)` = 56 bytes per `Order` (see `programs/meridian/src/order_book.rs`). **Slab size 64 per side** (`MAX_DEPTH_PER_SIDE = 64`), not the 256 originally planned. The 256-deep version produced a ~28KB `OrderBook` account that overflowed Solana's 10240-byte CPI-create realloc ceiling; 64-deep brings the account to ~7.3KB and fits cleanly. The account uses Anchor's `#[account(zero_copy(unsafe))]` because the 28KB borsh deserialize also overflowed the 4KB BPF stack. If a popular strike runs the book deep, the v1.1 upgrade path is a separately-allocated larger book account behind a new `init_order_book` variant, not an inline depth bump (see D3 below).

**Tick size.** $0.01 in 6-decimal USDC base units = 10_000 base units per tick. 100 ticks span the full $0.00 to $1.00 range. Quantities are integer Yes tokens (no fractional tokens; tokens are 0-decimal).

**Crank.** The `match_orders` instruction is permissionless and crosses at most one (bid, ask) pair per invocation; the automation service runs a crank loop every slot and re-invokes until no cross remains. Idle when there's nothing to do. Per-invocation cost is bounded.

### 2.3 Frontend (Next.js)

**Responsibility.** Render the wallet flow, the markets grid, the trade page, the portfolio, and the history. Translate user intent into Anchor instructions. Subscribe to chain state and re-render on changes.

**Routing.** Next.js App Router (v14+). Top-level routes: `/`, `/markets`, `/trade/[ticker]/[strike]`, `/portfolio`, `/history`. All client-rendered for chain interactivity; SSR only for the landing route to keep first-paint fast.

**State.**

- **Chain state:** TanStack Query. Query keys are factored into a `queryKeys` const so cache invalidations are exact. Subscriptions: WebSocket via `connection.onAccountChange` for active market accounts; polling fallback at 5s for the rest.
- **UI state:** Zustand. One store per page, sliced per concern (selected strike, order form draft, etc.). Selectors never allocate (see constitution §5 and the boxy-fractions lesson).
- **No Redux.** Adds boilerplate without paying off at our scale.

**Wallet adapter.** `@solana/wallet-adapter-react` with explicit adapters for Phantom, Solflare, and Coinbase Wallet (Backpack is surfaced through the Wallet Standard auto-discovery). Provider lives at the root layout. Meridian replaces the default `wallet-adapter-react-ui` modal with `WalletPickerProvider`, which lists detected wallets (via `WalletReadyState.Installed`) and provides browser-aware install links plus a five-step Devnet setup checklist when none are detected. Coinbase Wallet integrates through `CoinbaseWalletAdapter` (probes `window.coinbaseSolana`); the Anchor / Connection cluster (devnet) is dictated by Meridian, so the wallet only signs and there is no per-network selector for it to mismatch on.

**Anchor client.** Generated TS types from the program IDL on every build (`anchor build && anchor idl parse`). The client is wrapped in a `useMeridian()` hook that returns typed instruction builders. No `as any`, no untyped argument lists.

**Order book rendering.** One book on chain, two perspectives in the UI. The Yes view shows the raw book. The No view flips: bids become "people willing to sell No at $1.00 − price", asks become "people willing to buy No at $1.00 − price". Both views read from the same WebSocket subscription; the No view is a pure transform.

**Atomic transactions.** Buy No and Sell No are built as a single `Transaction` with one instruction (the program's `buy_no` or `sell_no`), one wallet signature, one RPC submission. The UI never shows a "step 1 of 2" indicator for these paths.

**Position constraint enforcement.** Before showing the Buy Yes button, the trade page reads the user's Yes and No token balances for the displayed strike. If No balance > 0, Buy Yes is disabled with a tooltip "Sell No first" and a button "Sell all No first". Symmetric for the reverse. PRD-compliant; not a security boundary.

### 2.4 Automation service (Node.js)

**Responsibility.** Run scheduled jobs on US trading days. Read the oracle's previous close in the morning. Create markets. Run the crank. Trigger settlement at 16:05 ET. Retry on oracle failure. Alert on give-up.

**Runtime.** Node 20+ on Render with a tiny container (1 vCPU, 512 MB RAM is enough). `pnpm` for installs. `node --import tsx` for direct TS execution; no bundler needed.

**Scheduling.** `croner` package (battle-tested, sub-100ms scheduling drift). Two crons:
- `0 8 * * 1-5` America/New_York — morning job
- `5 16 * * 1-5` America/New_York — settlement job

Cron expression timezone is explicit. The container's `TZ` env is set to `America/New_York` for log readability.

**NYSE calendar check.** `nyse-holidays` npm package, validated against the official NYSE calendar at startup. If today is a holiday or a weekend, both jobs exit early after a single log line `{level: "info", msg: "not a US trading day", date: "2026-05-25"}`.

**Strike computation.** Given previous close P:
- Generate raw strikes at P × (1 ± 0.03), P × (1 ± 0.06), P × (1 ± 0.09), plus P itself.
- Round each to the nearest $10.
- Deduplicate (low-priced stocks like AAPL collapse adjacent strikes; PRD examples both verified).

The strike list is logged before any on-chain call so a misbehaving morning job is debuggable from the log alone.

**Retry policy.** Settlement: per ticker, retry every 30 seconds for 15 minutes (30 attempts). Each retry rebuilds the oracle read transaction from scratch (do not reuse a stale price account snapshot). On give-up, fire a Slack webhook with the ticker, the last seen confidence, and a one-click admin override link.

**Idempotency.** Both jobs check on-chain state before submitting. Morning job: query for `Market` PDAs with today's `trading_day_unix` seed; if all 7 tickers have at least one strike, skip. Settlement job: query for unsettled markets only.

**Crank loop.** A background loop polls active order books every 400ms (one Solana slot). If any book has a bid >= best ask, submit a `match_orders` tx. Cheap to run; we pay rent on the cranker's SOL only when there are actual fills.

**Health check.** `GET /health` returns `{status: "ok", lastMorningRun, lastSettlementRun, crankerStatus}`. Render's health check polls this; CI in the frontend pings it before deploys.

### 2.5 Oracle adapter (Pyth)

**Decision.** Pyth Network for stock-equity price feeds.

**Why Pyth over Switchboard.**

| Criterion | Pyth | Switchboard |
|---|---|---|
| Stock equity coverage | Native MAG7 feeds | Possible via custom job, more setup |
| Update model | Pull-based on Pythnet, cross-chain via Wormhole; price-feeds-receiver crate | Push, oracle queues |
| Confidence band | First-class field on every update | Computable from queue submissions |
| On-chain read cost | One account read + signature verify (for pull) | Account read |
| Devnet availability | All MAG7 feeds live on Pyth devnet | Switchboard SOL feeds yes; equity less mature |

We choose Pyth. The pull model (where the client posts a fresh price update before the transaction that reads it) is the right fit for our settlement path because we want the price as close to 4:00 PM ET as we can get. The settlement job posts a Pyth update, then settles the market, in the same transaction when feasible (or in adjacent transactions when over the per-tx CU budget).

**Trade-off.** Pyth's pull model means the automation service has to fetch the latest update from Hermes (Pyth's off-chain price service) and submit it on-chain. One extra HTTPS call per settlement. Negligible cost; predictable behavior.

**Validation.** On-chain, `settle_market`:
1. Loads the Pyth `PriceUpdateV2` account passed by the caller.
2. Verifies its feed ID matches the one stored in `Config` for this ticker (no spoofing).
3. Reads `publish_time`; rejects if `Clock::now().unix_timestamp - publish_time > config.max_staleness_secs`.
4. Reads `price` and `conf`; rejects if `conf * 10_000 / price > config.max_confidence_bps`.
5. Compares `price` to the market's strike (with attention to the at-or-above rule).
6. Writes the outcome.

Default thresholds in `Config`: 300s staleness, 50 bps confidence. Both tunable post-deploy by the admin.

### 2.6 USDC

USDC devnet mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle devnet). Hard-coded in the deploy script's `.env.example`, read from `Config` after initialization. Same mint reused across all markets; one global USDC ATA per user.

## 3. Data flow

### 3.1 Morning market creation (08:00 ET)

```
NYSE calendar check ──► trading day? ──►no──► log + exit
                            │ yes
                            ▼
For each of 7 tickers:
   Pyth Hermes fetch ──► previous close P
   Strike calc        ──► [P*0.91, P*0.94, P*0.97, P, P*1.03, P*1.06, P*1.09]
   Round + dedupe     ──► unique strikes
   For each strike:
      Idempotency check (does Market PDA exist?) ──►exists──► skip
      Build tx: create_strike_market(ticker, strike, trading_day) ──► sign + send ──► confirm
   Log result table
Slack notify if any failure
```

### 3.2 User trade: Buy Yes (limit + cranker-driven match)

`place_order` is a pure inserter; there is no IOC mode in v1. A Buy Yes that needs to fill immediately is a `place_order(Bid, ...)` against the current best ask price, and the cross is completed by the next `match_orders` crank call (typically same slot).

```
User clicks Buy Yes 10
  Frontend reads order book ──► best ask at $0.55
  Frontend builds tx: place_order(side=Bid, price_ticks=55, qty=10)
  Wallet popup ──► user signs
  RPC submit ──► confirm
  Anchor program (place_order):
     pulls 10 * $0.55 = $5.50 USDC: user.user_usdc → usdc_escrow
     inserts {price_ticks: 55, qty: 10, owner: user, sequence: N} into bids slab
  (cranker, separate tx, ~1 slot later)
  Anchor program (match_orders):
     best_bid.price (55) >= best_ask.price (<=55) ✓
     fill_qty = min(bid.qty, ask.qty); fill_price = older order's price
     pays seller USDC out of usdc_escrow; pays user (the bid maker) Yes out of yes_escrow
     refunds bidder spread if bidder is the taker (bid.price > fill_price)
     decrements both sides; removes filled side(s)
  Frontend confirmed signature for place_order; cranker fill arrives via subscription
  TanStack Query invalidates: user balances, this market's order book
  Portfolio re-renders with new position
```

### 3.3 User trade: Buy No (the atomic path)

```
User clicks Buy No 10 at target price 45¢
  Frontend reads best bid Yes ──► 55¢ (better than the 55¢ floor needed)
  Frontend computes min_bid_price_ticks = 100 − target_no_price_ticks
                                        = 100 − 45 = 55
  Frontend builds tx: buy_no(qty=10, min_bid_price_ticks=55)
  Wallet popup ──► user signs ONCE
  Anchor program (buy_no):
     pre-flight: bids_len > 0 ✓, bids[0].qty (>=10) ✓, bids[0].price_ticks (>=55) ✓
     pulls 10 * $1.00 = $10.00 USDC: user.user_usdc → vault
     mints 10 Yes → user.user_yes (transient)
     mints 10 No  → user.user_no   (final position; never moves again)
     transfers 10 Yes: user.user_yes → bid_maker_yes (the resting bidder's Yes ATA)
     pays user: 10 * filled_bid_price USDC out of usdc_escrow → user.user_usdc
     decrements bids[0].qty by 10; removes the entry if it goes to zero
  Confirmed: user holds 10 No, USDC delta = -10 + 10*filled_bid_price
            (e.g. fill at 55¢ → delta = -10 + $5.50 = -$4.50 net for 10 No at 45¢ each;
             fill at a higher 60¢ bid → delta = -$4.00 = better than the 45¢ floor)
```

Key properties: the implementation fills against `bids[0]` only (no slab walk). If the best bid does not have the full `qty` of depth, or its price is below `min_bid_price_ticks`, the entire transaction reverts with `IocPartialFillRejected` and no tokens mint. The user's price floor is a ceiling on cost; they may be filled at a strictly-better price than they asked for. To sweep multiple price levels in one position-build, the frontend sends N separate `buy_no` transactions.

### 3.4 Settlement (16:05 ET)

```
For each unsettled Market today:
   Fetch latest Pyth update from Hermes
   Build tx: [updatePriceFeed(pyth_update), settle_market(market, pyth_update_account)]
   Sign with automation key ──► submit
   Anchor program:
      validate Pyth account passed matches Config-stored feed for ticker
      check staleness and confidence
      if rejected: tx fails with explicit error ──► retry on next loop
      compare price to strike: if price >= strike, yes_wins; else no_wins
      write Outcome: {is_settled: true, closing_price, settled_at}
   Confirmed: emit Settled event
On any rejection in the retry loop, schedule next attempt in 30s
If still failing at +15min: Slack alert; admin will run admin_settle after 17:00 ET
```

### 3.5 Redemption

```
User clicks Redeem on a settled position
  Frontend builds tx: redeem(market, side, qty)
  Wallet popup ──► user signs
  Anchor program:
     load Outcome ──► determine winning side
     if user's side == winning: vault transfers (qty × 1 USDC) to user's USDC ATA
     burn user's qty tokens
     close user's token ATA if balance now 0 (returns rent SOL)
  Confirmed
```

## 4. Decisions table

Every architectural decision, the alternative considered, and why. This table is the data source for the architecture website's decision table.

| # | Decision | What we chose | Alternative | Why |
|---|---|---|---|---|
| 1 | Chain | Solana devnet | Arbitrum / Base / HyperLiquid | PRD recommends Solana for sub-second finality and existing order-book infrastructure. Solana devnet is required for the submission to pass. EVM L2s introduce latency for an on-chain book; HyperLiquid does not natively support custom instruments. |
| 2 | Smart contract framework | Anchor 0.30+ | Raw Solana program (no framework) | Anchor's account-validation macros, IDL generation, and Rust client save weeks of plumbing and prevent the entire class of unchecked-account-deserialize bugs. The cost is one more dependency we justify here. |
| 3 | Order book | In-program minimal CLOB | Phoenix CPI integration | Phoenix listing requires off-chain coordination; the atomic Buy No path needs both legs in the same program for revert safety. PRD calls this the "more ambitious" path. Trade-off: less battle-tested matching engine; mitigated by property tests. |
| 4 | Oracle | Pyth Network (pull model) | Switchboard | Pyth has first-class MAG7 equity feeds on devnet, first-class confidence intervals, and a pull model that lets us post a fresh price at settlement time. Switchboard's equity coverage is less mature. |
| 5 | USDC | Circle devnet USDC | Custom stable mint | Use the real Circle devnet USDC mint so the demo matches mainnet semantics exactly. No bespoke token. |
| 6 | Token standard | SPL Token (not Token-2022) | Token-2022 with transfer hooks | Token-2022 transfer hooks introduce a CPI on every transfer, which inflates the matching tx's CU usage. We do not need confidential transfers or transfer fees in v1. Revisit if v2 needs them. |
| 7 | Wallet adapter | `@solana/wallet-adapter-react` with explicit `PhantomWalletAdapter`, `SolflareWalletAdapter`, `CoinbaseWalletAdapter` (+ Wallet Standard auto-discovery for Backpack et al.) | Single-wallet integration | The wallet-adapter package is the standard. Carrying explicit adapters alongside Wallet Standard auto-discovery is required because Safari's Phantom WebExtension and Coinbase Wallet do not publish the Wallet Standard handshake synchronously; the picker's "Detected" filter would otherwise be empty for users who actually have a wallet installed. Coinbase Wallet was added so users coming from Coinbase have a path that does not require installing a second wallet just for Meridian; the cluster (devnet) is dictated by Meridian's `Connection`, not the wallet, so there is no per-network mismatch path. |
| 8 | Frontend framework | Next.js 14 App Router | Vite + React Router | Next.js gives us SSR for the marketing landing (faster first paint, better social previews) while keeping the rest client-rendered. Vercel's deploy ergonomics are best-in-class. |
| 9 | Server-state library | TanStack Query | Apollo / SWR / hand-rolled | TanStack Query has the best primitives for cache invalidation by query key, which we need when chain state updates per account. Apollo is overkill (no GraphQL). SWR is fine; TanStack is the project's existing standard. |
| 10 | Client-state library | Zustand | Redux Toolkit / Jotai | Zustand is the user's existing standard from boxy-fractions. Redux is forbidden in v1 by the constitution. Jotai is fine but smaller ecosystem. |
| 11 | Real-time updates | RPC `onAccountChange` WebSocket subscriptions | Polling only | Sub-second finality means polling at 1-2s misses fills. WebSocket subscriptions are the idiomatic Solana pattern. Polling at 5s is the fallback for accounts we read less often. |
| 12 | Automation runtime | Node.js 20+ on Render | AWS Lambda / Cloudflare Workers / GitHub Actions cron | Render's persistent-server model is the right fit for the cranker loop, which needs a long-running process. Lambda's cold starts and 15-min execution limit are wrong for cron. GitHub Actions cron has minute-level scheduling drift. |
| 13 | Automation scheduler | `croner` package | `node-cron` / `BullMQ` | `croner` has sub-100ms drift, native timezone support, and zero dependencies. `node-cron` has known drift issues. `BullMQ` requires Redis for two cron jobs; overkill. |
| 14 | Frontend hosting | Vercel | Render / Netlify / Cloudflare Pages | Vercel is the Next.js reference platform; deploy hooks, image optimization, and edge functions work out of the box. Render is fine but slower cold paths. |
| 15 | Logging | `pino` (JSON structured) | Winston / console.log | `pino` is the fastest Node logger, native JSON output (PRD calls for structured logs), and integrates with Render's log shipper. |
| 16 | Telemetry | Skip in v1 | Sentry / Honeycomb | v1 ships without paid telemetry. Logs in Render are sufficient for the demo. Revisit before mainnet. |
| 17 | CI | GitHub Actions | GitLab CI | We dual-push to both, but GitHub Actions has better Anchor/Solana tooling and is what Vercel and Render integrate with. GitLab is mirror-only. |
| 18 | Pre-commit hooks | `prek` (per project rules) | Husky / lefthook | `prek` is the project's existing standard. |
| 19 | Test framework Rust | `anchor test` + `solana-program-test` + `proptest` | `cargo test` only | `anchor test` spins up a local validator; `solana-program-test` is faster for unit-level tests; `proptest` is the project's chosen property-test framework. |
| 20 | Test framework TS | `vitest` + `playwright` | `jest` + `cypress` | `vitest` is faster, native ESM, share configs with Vite tooling. `playwright` is the project's existing E2E choice. |

## 5. Trade-offs

Each panel is a "we accept X, knowing Y, mitigated by Z" statement. The architecture website renders each as a card.

### 5.1 In-program order book vs Phoenix

**We accept:** more implementation work and a less battle-tested matching engine. **Knowing:** Phoenix has handled real volume on mainnet for over a year, and our matcher will have only as many test sequences as we run. **Mitigated by:** property tests (1000 random sequences per CI run) asserting total USDC and total Yes conservation, plus a manual fuzzing harness. **When it would bite:** an obscure ordering bug in slab insertion or removal (the v1 matcher only crosses best-vs-best per call, so there is no multi-level walk to fuzz inside one instruction; the risk is in the resting-order data structure itself). **Triggers a revisit:** if v2 needs more than 64-depth on a side, or if we observe a matching bug in production.

### 5.2 Pyth vs Switchboard

**We accept:** dependence on Pyth's Hermes service for the off-chain fetch. **Knowing:** Hermes is operated by Pyth Data Association and has had outages. **Mitigated by:** the 15-min retry window and the admin-override fallback. **When it would bite:** a same-day Hermes outage > 15 minutes during US market close. **Triggers a revisit:** if Hermes shows > 1 outage per quarter in our observation period.

### 5.3 Atomic Buy No vs separate transactions

**We accept:** more program code (one extra instruction per atomic path) and the constraint that each `buy_no`/`sell_no` fills against exactly one resting maker. **Knowing:** a non-atomic Buy No would be one wallet popup to mint, then a second to sell, with the user holding both Yes and No between the two if they navigate away. **Mitigated by:** the single-maker shape keeps the account list fixed and well under Solana's caps; the frontend pre-checks `bids[0].qty` against the user's requested `qty` and prompts to split if the best bid is too shallow. **When it would bite:** thin books on a popular strike — a 100-No order against a 10-deep best bid forces 10 separate `buy_no` txs, each with its own signature and signature fee. **Triggers a revisit:** if devnet metrics show > 20% of large `buy_no` orders splitting into > 3 txs.

### 5.4 Position constraint as UX rule, not program invariant

**We accept:** a determined user with a CLI can hold both Yes and No simultaneously by calling `mint_pair` directly. **Knowing:** the spec explicitly carves out market makers who need this transiently. **Mitigated by:** the frontend blocks the conflict before showing the trade panel; the portfolio shows a "Pending sell" label during legitimate transients; the program does NOT block at the account level. **When it would bite:** if a sophisticated user holds both and the UX confuses them about their net position. **Triggers a revisit:** if user feedback shows confusion in the demo.

### 5.5 Solana devnet vs mainnet for v1

**We accept:** the demo runs on testnet with test wallets and faucet USDC. **Knowing:** devnet liquidity is whatever our test wallets provide, not realistic. **Mitigated by:** the architecture defense calls out devnet limitations explicitly; mainnet deploy is a documented bonus path. **When it would bite:** if a reviewer believes the demo is misrepresenting mainnet behavior. **Triggers a revisit:** mainnet deploy (separate review).

### 5.6 SPL Token vs Token-2022

**We accept:** no transfer-hook, confidential-transfer, or interest-bearing features. **Knowing:** Token-2022 is the future-default and supports these natively. **Mitigated by:** v1 does not need them; the program can migrate by changing mint creation in `create_strike_market`. **Triggers a revisit:** if v2 adds protocol fees that benefit from a transfer-fee hook.

### 5.7 No telemetry in v1

**We accept:** no Sentry, no Honeycomb, no app-level perf monitoring. **Knowing:** production-grade systems need telemetry. **Mitigated by:** Render's log dashboard, manual `/health` polling, and the dual on-chain audit trail (every state change is an event log). **Triggers a revisit:** before mainnet deploy.

## 6. Sequencing

Slices are ordered so each slice ships independently behind the qa-adversary gate. `tasks.md` decomposes these into checkbox items.

### Slice 1: Anchor program scaffold

Initialize Anchor workspace. Implement `initialize_config`, `create_strike_market`, `mint_pair`, `redeem` (with a stubbed `Outcome` for now; settlement is slice 2). Property test for the vault invariant (`vault == pairs × 1.00 USDC`). PRD user stories served: US-7 (Mint pair), US-9 (Redeem happy path).

### Slice 2: Oracle integration and settlement

Add Pyth dependencies. Implement `settle_market` with full staleness and confidence checks. Property test for $1.00 invariant (1000 samples). Explicit `at_strike_yes_wins` test. PRD user stories: US-8.

### Slice 3: In-program order book

Implement `place_order`, `cancel_order`, `match_orders`. Property tests on conservation invariants. Crank tooling. PRD user stories: US-3 (Buy Yes), US-5 (Sell Yes). Both are direct `place_order` calls from the frontend.

### Slice 4: Atomic Buy No and Sell No

Add `buy_no` and `sell_no` instructions bundling mint-pair-and-IOC-sell and IOC-buy-and-redeem-pair. Tests that the transactions revert atomically. PRD user stories: US-4, US-6.

### Slice 5: Admin override, pause, unpause

Implement `admin_settle` with the 1-hour delay enforced via `Clock`. Implement `pause` and `unpause`. Tests that redeem still works while paused. PRD user stories: US-11, US-12.

### Slice 6: Frontend foundation

Next.js app router scaffold, wallet adapter, TanStack Query setup, Zustand stores, Anchor client hook. Landing and Markets pages with live data. PRD user stories: US-1, US-2.

### Slice 7: Trade page

Order book rendering (Yes and No perspectives), trade panel with Buy Yes / Buy No / Sell Yes / Sell No buttons, atomic transaction builders. Position-constraint enforcement at the UI layer. PRD user stories: US-3, US-4, US-5, US-6, US-10.

### Slice 8: Portfolio and history

Aggregation of user positions across all markets, P&L computation, redeem button, transaction history. PRD user stories: US-9 (Redeem UI), US-13, US-14.

### Slice 9: Automation service

Node service with morning cron, settlement cron, NYSE calendar check, retry policy, Slack alert hook, crank loop, `/health` endpoint. PRD user stories: US-8 (automated), US-15.

### Slice 10: Polish, architecture site, defense docs

`ARCHITECTURE.md` final pass, `website/index.html` with Mermaid diagrams and Chart.js cost panels, `docs/DEFENSE_BREAKOUT_SCRIPT.md`, `docs/AI_INTERVIEW_PREP.md`, README with one-command setup.

## 7. Non-functional targets

| Metric | Target | How measured |
|---|---|---|
| Settlement latency from 16:00 ET | < 10 min for all markets | settlement job log timestamp vs market `settled_at` |
| Trade tx confirmation (devnet) | < 2s p99 | client-side instrumentation |
| Buy No CU cost | < 600k CUs | `solana-test-validator` CU profile |
| Frontend first-paint (landing) | < 1.5s p75 on 4G | Vercel Analytics |
| Frontend bundle gzipped (landing) | < 300 KB | `next build` output |
| Automation `/health` uptime | > 99% during US market hours | Render uptime + log audit |
| Test suite total runtime | < 60s | CI duration |

## 8. Locked decisions (resolutions of the questions the plan parked)

These were open questions; the user locked them in to their recommended defaults on 2026-05-20. Each becomes a normative line of the plan. Overrides require a separate amendment commit.

- **D1: Devnet faucet UX.** The frontend embeds a "Get devnet USDC" button that hits Circle's official devnet USDC faucet. On rate-limit (HTTP 429), it falls back to a clickable link to the faucet page so the user can complete the request manually. Implementation: `src/lib/faucet.ts` with one exported `requestDevnetUsdc(address)` function.
- **D2: Crank wallet funding.** The cranker keypair starts with 5 SOL. The automation service polls the cranker's balance every 5 minutes; when it drops below 1 SOL, fires a Slack alert with a manual top-up link. No auto-top-up in v1 (keeps the admin in the loop on funding).
- **D3: Per-market order book capacity.** 64 entries per side (`MAX_DEPTH_PER_SIDE = 64` in `programs/meridian/src/order_book.rs`). The plan originally specified 256, but the resulting ~28KB `OrderBook` account exceeded Solana's 10240-byte CPI-create realloc ceiling and also overflowed the 4KB BPF stack on borsh deserialize. The fix was twofold: drop the per-side cap to 64 (~7.3KB account) AND switch to `#[account(zero_copy(unsafe))]` so the account is read directly from raw bytes without copying. The v1.1 upgrade path for popular strikes is a separately-allocated larger book account behind a new `init_order_book` variant; raising the compile-time constant in place is not a runtime decision.
- **D4: Order book matching cadence.** Slice 3 ships WITHOUT an event queue; `match_orders` is single-cross-per-invocation (one bid against one ask, fill quantity `min(bid.qty, ask.qty)`). The cranker re-invokes until no cross remains. This keeps each tx well inside the per-tx CU and account-list caps. If a future slice batches multiple fills per crank, an event queue and a separate completion crank instruction would land then; v1 does not need them.
- **D5: USDC representation in the frontend.** Branded type: `type UsdcBase = bigint & { readonly __brand: 'UsdcBase' }`. All arithmetic in base units. Conversion to display happens at the React leaf via a `formatUsdc(amount: UsdcBase): string` function that returns two-decimal strings. The `number` type is forbidden for money values; ESLint rule `no-restricted-syntax` enforces it.
- **D6: Pyth feed timing for the morning job.** Assume Pyth has the previous trading day's 4:00 PM ET close available by 08:00 ET the next morning (Pyth Network's stock-equity feeds publish during US market hours and the last published price persists). The morning job logs `publish_time` for every price it reads, so any drift is immediately debuggable from the log. If Pyth devnet does NOT carry MAG7 stock-equity feeds, slice 2 surfaces this as a hard failure and we pivot to Switchboard (decision #4 reversal documented as an amendment).
- **D7: Order book empty state.** Empty bid AND empty ask sides render a single panel: "Be the first to quote — Mint pair to provide liquidity" with a primary "Mint Pair" button. Empty-only-one-side renders normally (the other side is the source of liquidity for IOC orders). The trade panel disables Market orders when the relevant side is empty, with a tooltip explaining why; limit orders remain available.

## 9. References

- PRD: `binary-blockchain-prd.pdf` (user-uploaded, 2026-05-20)
- Manual test plan: `/Users/scottlydon/Documents/Claude/Projects/Gauntlet/meridian-manual-tests.md` (already drafted; will move into `tests/` once the repo is structured)
- User-level coding rules: CUPID (cupid.dev), Google Swift Style Guide (https://google.github.io/swift/), [user gist 1](https://gist.github.com/scott-lydon/b1498f865af1e5e28a9d15aec3eb93ed), [user gist 2](https://gist.github.com/scott-lydon/3517b7b9f1829845faed826a63bfee76)
- Project-level rules: `/Users/scottlydon/Documents/Claude/Projects/Gauntlet/CLAUDE.md`
- Memory: bug-prevention lessons from boxy-fractions (Zustand selector allocations) and openemr (error reporting)

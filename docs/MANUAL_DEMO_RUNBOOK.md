# Manual demo runbook — Meridian on devnet

End-to-end manual acceptance flow for the submission video and for any wall-clock walkthrough of the full lifecycle (seed, four trade actions, settlement, redeem). Two real wallets. Every step names the actor, the on-chain instruction, the user-visible UI path, the expected on-chain effect, and how to verify it.

> Companion to `docs/DEMO_RECORDING_SCRIPT.md` (the 90-second submission cut) and `spec.md` (the 15 user stories). This runbook is the longer "evidence" path that exercises every user-visible action.

---

## Cast of two accounts

| Label | Role | Wallet | What they do |
|---|---|---|---|
| **Account 1** | Seed wallet / market maker | The admin keypair at `~/.config/solana/id.json` (also drives `scripts/seed-devnet.mjs`) | Mints Yes/No pairs and posts the initial resting Yes ask and Yes bid that Account 2 will cross. |
| **Account 2** | Demo / trader wallet | A fresh Phantom (or Solflare) wallet, devnet mode | Executes all four trade actions (Buy Yes, Sell Yes, Buy No, Sell No), then redeems after settlement. |

You need both wallets funded with devnet SOL (≥ 1 each) and devnet USDC (Account 1 needs ≥ $20, Account 2 needs ≥ $10).

Account 1 must NOT be the same keypair as Account 2. The on-chain self-match guard reverts `buy_no` / `sell_no` if best bid (or best ask) owner equals the caller. The frontend also greys out the button preemptively. From `app/src/app/trade/[ticker]/[market]/page.tsx`:

```ts
// app/src/app/trade/[ticker]/[market]/page.tsx:483, 505
"Best YES bid is your own order. Buy No would self-cross; cancel your own bid first (red ✕ on the (you) row)."
"Best YES ask is your own order. Sell No would self-cross; cancel your own ask first."
```

---

## Pre-flight

| Step | Action | Verify |
|---|---|---|
| 0.1 | Phantom (or Solflare) is in devnet mode. Phantom: ⚙ → Developer Settings → Testnet Mode ON, then network → Devnet. | Header says "Devnet". |
| 0.2 | Both wallets hold ≥ 1 devnet SOL. Use Phantom's faucet button or `solana airdrop 2 <pubkey>`. | Phantom balance ≥ 1 SOL each. |
| 0.3 | Both wallets hold devnet USDC. Account 1 ≥ $20, Account 2 ≥ $10. The frontend has a faucet link on the markets page. | USDC balance shown in the header. |
| 0.4 | Pre-warm the Render free-tier services so the first request is not a cold start: `curl -s https://meridian-frontend-f6af.onrender.com/ > /dev/null && curl -s https://meridian-automation.onrender.com/health > /dev/null` | `/health` returns JSON with `status: "ok"`. |
| 0.5 | If recording outside US trading hours, sign in at https://meridian-frontend-f6af.onrender.com/admin with `admin` / `pass` and turn ON the 🧪 After-hours testing mode in the header. | The flask icon in the header is highlighted and the banner appears. |

---

## Phase A. Seed the order book (Account 1, one-time per market)

The order book starts empty. Buy Yes, Sell Yes, Buy No, and Sell No all require resting orders on the opposite side; you cannot execute any of those four against an empty book. Mint Pair and Redeem Pair are the only actions that work on an empty book, because they touch the vault directly without the order book.

The seeding script is idempotent and does all four prerequisite steps. From `scripts/seed-devnet.mjs`:

```js
// scripts/seed-devnet.mjs:7-13
//   1. Verify config exists (initialized previously).
//   2. Create one NVDA market (today's day, strike $250) — or skip if present.
//   3. Init order book + escrow ATAs — or skip.
//   4. mint_pair 5 (admin keypair plays user too for the seed).
//   5. place_order Bid at $0.45 qty 2.
//   6. place_order Ask at $0.55 qty 2.
```

### A.1 Run the seed script as Account 1

| Step | Actor | Action | On-chain effect | Verify |
|---|---|---|---|---|
| A.1.1 | Account 1 | `cd ~/Desktop/Clutter/iOS/meridian && node tests/seed-devnet.mjs` | If today's NVDA > $250 market does not exist, calls `create_strike_market` (admin only). Then `init_order_book`, `mint_pair(5)`, `place_order(Bid, price_ticks=45, qty=2)`, `place_order(Ask, price_ticks=55, qty=2)`. | Script prints six Explorer URLs (or "(skipped, already exists)" for the idempotent ones). Final book state: Bid 45¢ qty 2 / Ask 55¢ qty 2. |

You can also seed a heavier book by re-running the script and editing the qty constants, or by running it more than once (each run mints 5 more pairs and posts 2 more on each side, stacking depth at the same price levels).

### A.2 Optional: spin up a short-lived test market

If today's NVDA $250 market is already settled (you ran the demo earlier) or you want a custom strike that forces Yes-wins or No-wins, use the admin create-market UI instead of the script. Sign in at /admin first.

| Step | Actor | UI path | Result |
|---|---|---|---|
| A.2.1 | Account 1 (admin signed in) | https://meridian-frontend-f6af.onrender.com/admin/create-market → pick ticker, strike, expiry (minimum 30 seconds) → Submit | A fresh `create_strike_market` tx; the auto-settle cron fires ~1 minute after expiry, so you can demo settlement on a 90-second timeline. |

---

## Phase B. Account 2 executes the six user-visible actions

After Phase A, the book has Bid 45¢ qty 2 and Ask 55¢ qty 2. Account 2 is signed in with Phantom on the trade page for that market.

The deployed frontend wires every action to the corresponding on-chain instruction. From `app/src/hooks/useTrade.ts`:

```ts
// app/src/hooks/useTrade.ts:610-861 (excerpts)
const buyYes  = ...placeOrder({ bid: {} }, priceTicks, new BN(qty)) ...
const sellYes = ...placeOrder({ ask: {} }, priceTicks, new BN(qty)) ...
const buyNo   = ...buyNo(new BN(qty), minBidPriceTicks) ...
const sellNo  = ...sellNo(new BN(qty), maxAskPriceTicks) ...
const mintPair    = ...mintPair(new BN(qty)) ...
const redeemPair  = ...redeemPair(new BN(qty)) ...
const cancelOrder = ...cancelOrder(sideArg, new BN(sequence.toString())) ...
return { buyYes, sellYes, buyNo, sellNo, mintPair, redeemPair, cancelOrder, ready: ... };
```

The cranker (`match_orders`) is NOT a button. It runs automatically every ~400 ms from the automation service at `meridian-automation.onrender.com`. After any aggressive `place_order` you wait roughly one Solana slot for the cross to land. You can verify by refreshing the order book table on the trade page; the depth at the crossed price level will drop.

### Action sequence (covers US-7, US-3, US-5, US-4, US-6, US-9)

The sequence below is ordered so the position constraint (US-10, "you cannot hold Yes and No simultaneously from trading, except transiently") never blocks the next step. Read the "Why this order" column if you want to permute it.

| Beat | Actor | UI path | On-chain call | Expected on-chain effect | Why this order |
|---|---|---|---|---|---|
| B.1 — **Mint Pair** (US-7) | Account 2 | Trade panel → Mint Pair → qty 1 → Sign | `mint_pair(1)` | Account 2 USDC -$1.00, Yes +1, No +1. Vault +$1.00. | Account 2 starts with 0/0, so this is unconstrained. After this, Buy Yes and Buy No are both disabled (holds both sides), but Sell Yes and Sell No are both enabled. |
| B.2 — **Sell Yes** (US-5) | Account 2 | Trade panel → Sell Yes → qty 1 → Limit price 45¢ → Sign | At place_order time: 1 Yes leaves Account 2's ATA into `yes_escrow`. ~400 ms later the cranker calls `match_orders`, which crosses the new ask against Account 1's resting Bid @ 45¢. | Account 2 Yes -1, USDC +$0.45 (USDC paid out of `usdc_escrow`, which held Account 1's bid funds since A.1). Account 1's Yes ATA +1 (the Yes from `yes_escrow` flows to the bidder). Bid depth at 45¢ → 1. | Account 2 still holds 1 No after this; Buy Yes stays disabled, Buy No now enabled, Sell Yes disabled, Sell No enabled. |
| B.3 — **Sell No** (US-6) | Account 2 | Trade panel → Sell No → qty 1 → Limit ceiling 55¢ → Sign | `sell_no(1, max_ask_price_ticks=55)` in one atomic tx: (1) Account 2 pays Account 1's USDC ATA $0.55 (the ask price), (2) `yes_escrow` releases 1 Yes to Account 2 transiently (that Yes came from Account 1's resting Ask in A.1), (3) Account 2's 1 Yes + 1 No are burned, (4) the vault releases $1.00 USDC to Account 2. The Yes does NOT return to Account 1, it is burned. | Account 2 No -1, USDC net delta +$0.45 (−$0.55 + $1.00). Account 1 USDC +$0.55. Ask depth at 55¢ → 1. Total Yes supply -1 (burned). | Account 2 now holds 0/0. All four trade buttons enabled again. |
| B.4 — **Buy Yes** (US-3) | Account 2 | Trade panel → Buy Yes → qty 1 → Limit price 55¢ → Sign | At place_order time: Account 2's $0.55 USDC moves into `usdc_escrow`. ~400 ms later the cranker crosses the new bid against Account 1's resting Ask @ 55¢. Fill price = 55¢ (Account 1's ask rested first, so the older order sets the price; no refund owed). | Account 2 USDC -$0.55 (already paid at place_order), Yes +1 (from `yes_escrow`). Account 1 USDC ATA +$0.55. Ask depth at 55¢ → 0 (started at 2 in A.1, B.3 consumed 1, this consumes the last 1; the level is removed from the book). | Account 2 now holds 1 Yes / 0 No. Buy No is disabled, Buy Yes / Sell Yes / Mint Pair enabled. |
| B.5 — **Cancel order test** (optional, US-3) | Account 2 | Trade panel → place a Buy Yes limit at 40¢ (won't cross because Account 1's bid is 45¢ and there's no ask), then click the red ✕ on the (you) row in the bids table | `place_order(Bid, 40, 1)` then `cancel_order(Bid, sequence)` | USDC -$0.40 then +$0.40 (round trip). Proves cancel works and refunds escrow. | Optional. Skip if recording short. |
| B.6 — **Sell Yes again** to clear Yes (US-5) | Account 2 | Trade panel → Sell Yes → qty 1 → Limit 45¢ → Sign | `place_order(Ask, 45, 1)`; cranker crosses Account 1's remaining Bid @ 45¢ | Account 2 Yes -1, USDC +$0.45. Bid depth at 45¢ → 0 (removed). | Account 2 back to 0/0. Needed so Buy No is enabled in B.7. |
| B.7 — **Re-seed if book is one-sided** (Account 1) | Account 1 | Re-run `node scripts/seed-devnet.mjs` | `place_order(Bid, 45, 2)`, `place_order(Ask, 55, 2)`. May also re-mint another 5 pairs. | Restores Bid 45 / Ask 55 depth so B.8 has liquidity. | After B.6 both sides are likely empty; Buy No needs a resting bid. |
| B.8 — **Buy No** (US-4, the architectural centerpiece) | Account 2 | Trade panel → Buy No → qty 1 → ceiling derived from best bid → Sign (one popup) | `buy_no(1, min_bid_price_ticks=45)` atomic | Account 2 USDC -$0.55, No +1. Account 1 Yes +1 (the freshly-minted Yes lands directly in Account 1's Yes ATA, not in escrow). Vault +$1.00. Bid depth at 45¢ → 1. No orphan Yes anywhere. | Account 2 now holds 0 Yes / 1 No. Buy Yes disabled, Buy No / Sell Yes disabled, Sell No enabled. |
| B.9 — **Hold the No into settlement** (US-9 setup) | Account 2 | Nothing to click. Just leave the 1 No in the wallet. | n/a | Position carried into Phase C. | If you also want the Yes-redeem path on camera, repeat B.4 to also pick up 1 Yes before settling. |

### Mapping the user's described sequence to this runbook

The sequence you sketched ("Account 1 mints + posts ask, Account 2 buys it, Account 2 posts an ask, Account 1 posts a bid, cranker matches") maps onto a subset of the above. Translation:

| Your step | Maps to | Notes |
|---|---|---|
| Account 1 mints a Yes/No pair, posts a Yes ask | A.1 (the seed script does this in one go) | The script also posts a bid; you can comment that line out for a "just the ask" variant. |
| Account 2 buys the resting Yes ask | B.4 (Buy Yes against Account 1's ask) | The cranker runs ~400 ms later and the trade lands. |
| Account 2 posts a Yes ask | B.6 (Sell Yes at the current best bid price) | If you want it to rest without crossing, post at 60¢ instead of 45¢; the cranker will not match until someone bids ≥ 60¢. |
| Account 1 posts a Buy No bid | This is two distinct things; pick one. (a) If you mean a passive Yes bid that Account 2's ask will cross, that's `place_order(Bid, ...)` from Account 1. (b) If you mean the atomic `buy_no` instruction, that's B.8 but called by Account 1 instead of Account 2. | The recording video uses (b) because the one-popup atomicity is the architectural point. |
| Cranker applies | Automatic, every ~400 ms | You don't click anything; just watch the order-book table refresh. |

---

## Phase C. Settlement (US-8 and US-11)

Two paths. Pick one.

### C.1 Automated settlement (the production path)

| Step | Actor | What happens | Verify |
|---|---|---|---|
| C.1.1 | Automation service | At 16:05 ET on a US trading day, the cron in `automation/` calls `settle_market` for every open market, passing the Pyth oracle update for that ticker. Retries every 30 s for up to 15 minutes if the oracle is stale or low-confidence. | Open the Audit page at https://meridian-frontend-f6af.onrender.com/audit. Look at "Last settlement run" — `ok: true` with a recent timestamp and the per-ticker outcome. The market row on /portfolio now shows "Yes won" or "No won". |

If you are recording outside US trading hours and used the 30-second-expiry test market from A.2, the auto-settle cron polls expired markets roughly once per minute and will settle yours within ~60 s of expiry.

### C.2 Admin override (the fallback path, US-11)

The on-chain program enforces a delay before admin override is allowed. From the spec:

```text
// spec.md:165-168
- Given the current time is ≥ 1 hour after market close (≥ 17:00 ET)
- When the admin signs admin_settle(market, manual_close_price)
- Then the market settles with the manual price, the outcome account flags
  is_admin_override: true, and an event log entry records the admin key
  and timestamp
```

For an A.2 short-lived market this delay is configured separately (the `admin_override_delay_secs` field in `Config`). Don't rely on admin override during the recording; it's a safety valve, not a demo path.

---

## Phase D. Redeem (US-9)

After Phase C, the market is settled. Either Yes won (closing price ≥ strike) or No won. The redeem button is now visible on the portfolio page for any settled position.

| Beat | Actor | UI path | On-chain call | Expected effect |
|---|---|---|---|---|
| D.1 | Account 2 | https://meridian-frontend-f6af.onrender.com/portfolio → find the settled row → click Redeem | `redeem(side, qty)` where `side` is the side of the token Account 2 holds | If Account 2's side won: 1 token burned, vault releases $1.00 USDC to Account 2. If Account 2's side lost: token burned, $0 paid, SPL rent returned. |
| D.2 | Account 1 (optional) | Same flow on Account 1's portfolio | `redeem(...)` for whatever Account 1 still holds (likely the offsetting Yes from B.2/B.8 plus leftover minted pairs) | Closes out Account 1's position. |
| D.3 | Both | Reload the portfolio; settled row should now show "Redeemed" and no longer expose the button. The total realized P&L line is the sum of per-position lines, exactly. | `getAccount(yes_ata)` / `getAccount(no_ata)` returns the user's ATAs with zero balance (or closed if `redeem` closed them on zero). | If the aggregate P&L does not match the sum of the lines, that is the US-13 invariant breaking; record the discrepancy and exit. |

---

## Verification checklist (run after the full sequence)

Tick each one before considering the run done. Each line is verifiable on Solana Explorer or in the UI.

- [ ] Six Explorer URLs from `seed-devnet.mjs` all show success.
- [ ] Account 2 saw exactly one wallet popup per click (no double-sign on Buy No or Sell No).
- [ ] The order book on /trade reflected each beat in under one slot (~400 ms after the tx confirmed).
- [ ] After B.8 (Buy No), Account 2's Yes balance is 0 and No balance is +1, and there is no orphan Yes anywhere on chain attributable to Account 2 for this market. The atomic-or-revert invariant holds.
- [ ] Vault USDC at any moment equals `total_pairs_outstanding × $1.00` (the US-7 / US-9 invariant). The Audit page surfaces this.
- [ ] After settlement, the outcome account on the market PDA has `is_settled: true` and a non-zero `closing_price`. The /portfolio page reflects this.
- [ ] After D.1, Account 2's USDC delta over the full session matches the sum of trade deltas computed manually. Floating point should not enter the math; everything is integer USDC base units.

---

## What this runbook deliberately does NOT cover

- **Pause / Unpause (US-12).** Admin-only, no user-facing button outside of the admin page. Test in isolation against a throwaway market if needed.
- **Order book matching across multiple price levels in one transaction.** The architecture is single-maker-or-revert per `buy_no` / `sell_no` call; to sweep multiple levels you submit N transactions. The runbook keeps Account 1's seeded depth at one price level on each side.
- **The morning create-markets cron (US-15).** Runs at 08:00 ET on US trading days; not interactive. Visible on the Audit page as "Last morning run".
- **History page (US-14).** Read-only; nothing to do but click through it after the trades.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Buy No greyed out, tooltip says "No YES bid on the book yet" | Phase A bid was consumed by an earlier Sell Yes; book is one-sided. | Re-run `seed-devnet.mjs` to restore the bid side. |
| Buy No greyed out, tooltip says "Best YES bid is your own order" | Account 1 and Account 2 are the same wallet, or Account 2 placed a bid earlier and forgot to cancel it. | Switch wallets, or cancel your own bid via the red ✕ on the (you) row in the bids table. |
| Buy No fails on chain with `IocPartialFillRejected` | `bids[0]` depth less than your qty, or `bids[0].price` below your floor. | Reduce qty, raise your slippage floor (lower `min_bid_price_ticks`), or re-seed depth via `seed-devnet.mjs`. |
| Sell Yes greyed out, tooltip says "You don't hold any YES tokens to sell" | Account 2 used Buy Yes earlier and the order is still resting (not yet crossed). | Wait one slot for the cranker, or check the bids table; if your bid is at the wrong price level it will never cross. |
| Trade page never loads | Render free tier cold start. | Wait 30 s and refresh. Pre-warm with the curl pair in step 0.4 next time. |
| Settlement not visible on /portfolio after 16:05 ET | Pyth update was stale, oracle retry loop still running. | Check `/audit`; if Slack-alert fired, fall back to admin override C.2. |

---

## Files referenced

- `scripts/seed-devnet.mjs` — Phase A automation.
- `app/src/hooks/useTrade.ts` — frontend wrappers around every trade instruction.
- `app/src/app/trade/[ticker]/[market]/page.tsx` — the trade panel and all four disable-reason strings (the source of truth for which combinations are clickable).
- `programs/meridian/src/instructions/match_orders.rs` — cranker behavior (price-time priority, refund-on-cross, one cross per call).
- `programs/meridian/src/instructions/buy_no.rs` — atomic mint-pair + IOC-sell-Yes.
- `programs/meridian/src/instructions/sell_no.rs` — atomic IOC-buy-Yes + burn-pair.
- `docs/DEMO_RECORDING_SCRIPT.md` — the 90-second submission cut.
- `spec.md` — the 15 user stories that this runbook is the long-form acceptance of.

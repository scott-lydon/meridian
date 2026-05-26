# Meridian — AI Interview Prep

[AI video interview portal](https://portal.gauntletai.com/video-interview) · [mirror](https://gauntlet-portal.web.app/video-interview)

Four questions in five minutes. Each prepared answer is a tight ~150-word spoken block. Acronyms spelled out once per answer; after that the short form. Short sentences mixed with medium. Contractions. No em-dashes. No forced contrasts.

## 60-second elevator pitch

Meridian is binary stock outcome markets on Solana devnet. Each market asks: will an MAG7 ticker close at or above a strike at 16:00 ET? Yes pays one USDC if so. No pays one USDC if it closes below. Yes plus No always equals one dollar. Non-custodial. No KYC. No margin. The whole system is one Anchor program plus a daily automation cron plus a Next.js frontend. Strikes get created every morning at 08:00 ET from Pyth previous closes, traded all day on an in-program order book, settled at 16:05 ET by reading Pyth again. The vault invariant says vault balance equals total pairs outstanding times one dollar, at all times, on chain. Winners redeem indefinitely. Thirteen tests pass on the local validator covering the full lifecycle, the at-strike Yes-wins edge case, the order book escrow path, and the admin override time-delay.

---

## Always-asked questions

### Walk me through the data flow

Daily lifecycle has four phases. Morning. The automation cron at 08:00 ET reads Hermes for each of the seven MAG7 previous closes, computes strikes at plus or minus three, six, and nine percent rounded to the nearest ten dollars, deduplicates because low-priced stocks collapse strikes, and calls create_strike_market admin-signed for each new strike. Day. Users connect a Solana wallet. The connect modal lists Phantom, Solflare, and Coinbase Wallet by name, plus any other Wallet Standard wallet the browser auto-discovers like Backpack. They mint Yes No pairs by depositing one USDC each, and post limit orders to the in-program order book. Each Bid escrows USDC up front; each Ask escrows Yes tokens. Settlement at 16:05 ET. The automation reads Pyth closes again with a fifteen-minute retry window and thirty-second intervals. For each unsettled market it calls admin_settle with the closing price. The program writes the outcome. Redemption opens immediately and stays open indefinitely. Winners burn tokens for one dollar each. The vault drains exactly to zero.

### What would you do differently or with more time

Three things. First, build the matching engine before posting the limit-orders feature. Today place_order escrows and inserts; matches happen via a separate cranker that's deferred to slice 4. Users can post and cancel right now but two crossing orders don't fill yet. That's an honest trade-off, not a hidden bug. Second, finish slice 2 by adding on-chain Pyth verify to settle_market. Right now settlement runs through admin_settle which enforces the one-hour time-delay; the production path should be permissionless anyone-callable settle with on-chain freshness and confidence checks. Third, add property tests for the order book before any matching engine ships, because the conservation invariant on USDC plus Yes is the riskiest thing in the whole codebase and property tests with a thousand random sequences are how you actually catch slab-walk bugs.

### What did you find challenging

Three things. The BPF stack. The Anchor accounts context for redeem and mint pair allocated all the deserialized accounts on the four-kilobyte BPF stack, and we overflowed it before noticing. Fix was Box every Account so each one lives on the heap. The IDL build. Anchor 0.30.1's IDL generator called proc-macro2 source_file which is gated behind a nightly cfg, and our stable Rust build refused to emit the IDL even though the SBF binary was fine. Fix was bump to Anchor 0.31.1 which removes the call. The Solana installer. The platform-tools tar archive downloaded but didn't extract the rust subdirectory, so cargo build-sbf kept failing on a missing rust slash lib path. Fix was a manual tar xjf inside the cache directory.

---

## Rubric pillar answers

### Architecture — How is it built and why

Three layers. The Anchor program owns every piece of on-chain state and is the only thing that can move USDC. The frontend is a thin client that reads program accounts via TanStack Query and submits user-signed transactions. The automation service runs two cron jobs in America New York timezone using croner, plus a slash health endpoint for Render's platform check. Three external dependencies: Pyth for prices, Circle's devnet USDC mint, and the Solana wallet adapter, which is configured with explicit Phantom, Solflare, and Coinbase Wallet adapters plus Wallet Standard auto-discovery for everything else. The order book lives in the program rather than CPI to Phoenix, because Phoenix listing required off-chain coordination per strike, and the atomic Buy No path needs both mint and IOC sell in one program for revert safety. The OrderBook is zero-copy because the 28-kilobyte struct overflowed the BPF stack. Depth is 64 per side to fit Solana's 10K CPI create limit. Every PDA carries a program-version byte for v2 coexistence.

### Scalability — Where does it bend

Three angles. Throughput. Solana's sub-second finality means trades confirm in roughly 400 milliseconds. The in-program book matches at one transaction per match; the cranker can process multiple fills per crank but bounded by the per-transaction compute and account list limits. Storage. Each market account is small; thirty-five to forty-nine markets per day is well under any rent concern. The OrderBook is 7.3 kilobytes; sixty-four-deep per side fits Solana's per-account caps. Parallelism. Each strike is a separate market with separate accounts, so Solana's account-locking model lets every market settle in parallel. The settlement cron submits one transaction per ticker because each ticker's seven strikes lock the same Pyth feed account but write to different Market PDAs.

### Security — What stops the program getting drained

Five mechanisms. The vault invariant. Vault balance equals total pairs outstanding times one dollar, on chain, every step. Mint adds one dollar in. Redeem takes one dollar out. The PDA owning the vault signs only via the program. Admin gating. create_strike_market, admin_settle, pause, unpause all require config.admin as the signer. Anyone else gets Unauthorized. Time-delayed override. admin_settle reads Clock now from the runtime and rejects if now is before market.admin_override_earliest. That field is set at create time to created_at plus 3600. Pause respects redeem. When paused, mint and place_order reject, but redeem keeps working so winners can always claim. Settlement immutability. Once outcome state moves off Pending, no instruction can overwrite it. The outcome account is the indefinite source of truth.

### Testing — How do we know it works

Thirteen tests green on the local validator covering the full lifecycle. Slice one covers initialize, create_strike_market, mint pair, settle_market_manual yes-wins case, redeem yes for three USDC, redeem no for zero USDC, and the vault-drained-after-all-redeems invariant. Slice three covers init_order_book, place_order Bid with USDC escrow, and cancel_order refund. Slice five covers pause flipping config.paused, non-admin pause Unauthorized, and admin_settle being blocked before the one-hour override delay. Each test runs against solana-test-validator started fresh by anchor test. The vault drained assertion is the headline correctness check: after every test sequence the program owns exactly zero USDC. Property tests for order-book conservation are scheduled for slice 3.5 with a thousand random sequences.

---

## Anticipated follow-ups

**Q: How does pause not strand the order book?**
A: Pause blocks mint and place_order. Cancel_order still works because the user is reclaiming their own escrow. Redeem still works because the program needs to honor settled outcomes. So a paused market still lets users cancel resting orders and claim payouts; only new positions are blocked.

**Q: What if Pyth returns a wrong price?**
A: On-chain settle (slice 2) validates publish_time freshness against config.max_staleness_secs (default 300) and conf against config.max_confidence_bps (default 50). Wrong-looking prices reject. The cron retries every 30 seconds for 15 minutes. If still bad, admin can settle manually after the one-hour delay with the override flag recorded on chain.

**Q: Why 64 depth on the order book?**
A: Solana's CPI create-account limit is 10240 bytes. OrderBook at 256-depth was 28800 bytes which exceeded that. 64-depth is 7296 bytes; comfortable margin. Plan.md documents the v1.1 upgrade via a separate larger account for high-volume strikes.

**Q: Why not implement matching now?**
A: place_order does escrow plus insert. Matching requires the maker's accounts in remaining_accounts, which is a different ABI shape. The choice was to ship a working escrow-and-book this week with cancel and refund verified, vs ship a half-broken matcher. The matcher is the next slice.

**Q: How does the frontend handle disconnected wallets?**
A: useMeridian returns a read-only Anchor provider when wallet.publicKey is absent. All page reads work without a wallet. The Buy/Sell buttons disable when no wallet, with the WalletMultiButton in the header serving as the connect path.

---

## Backup bench

### Cost model
On devnet, free. Mainnet bonus would budget: program deploy roughly two SOL one-time; per-market account rent roughly 0.001 SOL each (35-49 per day); cranker SOL float starting at 5 SOL with alert below 1; RPC at Helius free tier sufficient for the demo, Triton paid tier for production volume.

### What did the LLM decide for me
Two non-trivial picks. Picking in-program book over Phoenix; we documented the reason in plan.md decision row 3 and trade-off panel 5.1. Picking Anchor 0.31.1 over 0.30.1 mid-stream; the 0.30.1 IDL bug forced the bump and we documented it in commit `6bed91c`.

### Demo vs production gap
Demo runs on devnet. Production would: deploy to mainnet-beta, swap admin_settle calls for the slice-2 on-chain Pyth settle, add Sentry-level telemetry, paid RPC, multi-region Render, secret-rotation for admin and cranker keypairs.

### Test coverage today
13 instructions, 13 tests passing on the local validator. Property tests pending. Manual test plan with 70+ phases in tests/manual/.

### Dependency justification
Every npm and cargo dep has a justification in plan.md §4. Notable: bytemuck for zero-copy OrderBook, croner over node-cron for sub-100ms drift and timezone-native scheduling, undici over node-fetch for performance on Hermes calls.

---

## Things to NOT say

- "I think" / "I believe" — say the answer directly.
- "Hopefully" — say what we tested.
- "The AI decided" — own decisions. Cite plan.md row numbers and commit hashes.
- "It should work" — say what's verified and what's pending, separately.
- "Demo only" without the mainnet path documented — always pair with the production roadmap.
- "We didn't have time" — say what's deferred and why the trade-off.

---

## Escalation block

If the interviewer presses on the position-constraint UX rule: cite plan.md §5.4. A market maker calling mint_pair holds both Yes and No transiently. Blocking that at the program level would break legit liquidity provisioning. The frontend constraint guides retail; the program permits the transient state.

If they press on the missing matcher: cite tasks.md slice 3.5 (planned). Today's place_order escrows and inserts; cancel_order refunds. Matching is the next sprint. The trade-off was ship a working order book this week vs ship a half-broken matcher; we picked the former and documented it.

If they press on the SBF stack overflow story: cite commit `acf6b0c` (slice 1 verified). The Config struct used to carry a 266-byte pyth_feeds inline array which blew the BPF stack on create_strike_market. Fix moved feeds out of Config and Boxed every Account in the Mint and Redeem contexts. After that 13/13 tests went green.

## Moment-of-truth block (defending LLM decisions)

Commit `6bed91c`: bumped anchor-lang 0.30.1 to 0.31.1 because the 0.30 IDL generator called proc-macro2 source_file which is nightly-only. The bump fixed the IDL build cleanly. Verified in commit `acf6b0c` with 13 tests green.

Commit `3b1840b`: switched OrderBook to zero-copy because the 28KB struct overflowed the BPF stack. Pod-compatible layout requires repr(C), no enum in struct fields. Side encoded as u8 with OrderSide enum at API boundary.

Commit `eddd062`: added pause that does not block redeem because the constitution §2.10 says winners must always be able to claim. The on-chain code has explicit comments at the redeem instruction calling out why it ignores config.paused.

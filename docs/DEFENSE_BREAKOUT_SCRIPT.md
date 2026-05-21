# 5-Minute Architecture Defense — Meridian

Target ~4:30 spoken pace, 30-second buffer.

---

## Spoken script

Meridian is binary stock outcome markets on Solana devnet. Each market asks: will MAG7 ticker close at or above strike at 16:00 ET? Yes pays one USDC if yes. No pays one USDC if it closes below. Yes plus No always equals exactly one dollar.

The whole system is one Anchor program. The program owns five things: a Config singleton, one Market per (day, ticker, strike), Yes and No mints per market, an order book per market, and the USDC vault that holds collateral.

Three external dependencies. Pyth for prices. Circle's devnet USDC mint. Phantom wallets for users. That's it.

Daily lifecycle. At 08:00 ET an automation cron reads previous closes from Pyth Hermes, computes strikes at plus or minus three, six, and nine percent rounded to ten dollars, deduplicates, and creates one market per strike per ticker. During the day users mint Yes No pairs and trade Yes against USDC on the in-program order book. At 16:05 ET a settlement cron reads Pyth closes again, validates staleness and confidence, writes the outcome on chain. Winners redeem any time after that. Indefinitely.

The vault invariant. For every market, the vault balance equals total pairs outstanding times one dollar. Always. Mint deposits one dollar in exchange for one Yes plus one No. Redeem burns one winning token in exchange for one dollar. Losers burn for zero, and the rent on their account returns. After every redeem cycle the vault drains to zero.

The order book. One book per strike. Yes against USDC. Bids sorted descending, asks ascending, FIFO at price. Buying Yes and selling No are the same side of the book. Buying No and selling Yes are the same side. One book, four user actions, two perspectives. Slab depth is 64 per side which fits inside Solana's 10K CPI account-create limit. Zero-copy account layout because the 28K version overflowed the 4K BPF stack.

Why an in-program book and not Phoenix. Phoenix listing required off-chain coordination for each new strike, which broke devnet reproducibility. The atomic Buy No path bundles mint pair and an IOC Yes sell into one instruction; routing that through Phoenix as CPI doubled the failure surface. We accept a less battle-tested matcher in exchange for control. We mitigate with property tests on conservation invariants.

Why Pyth and not Switchboard. Pyth has first-class MAG7 equity feeds with confidence intervals. The pull model lets us post a fresh price at settle time. Switchboard's equity coverage is less mature.

Trade-offs we accept. Devnet only for v1, mainnet is a documented separate review. Pyth dependency means a sustained Hermes outage forces admin override. The position constraint that blocks holding both Yes and No is a UX rule enforced by the frontend, not a program invariant, because a market maker mid-mint legitimately holds both transiently.

The numbers. Thirteen tests green on the local validator. Slice 1 covers the mint-settle-redeem lifecycle, the at-strike Yes-wins case, and the vault-drained invariant. Slice 3 covers order-book init, escrow, and cancel. Slice 5 covers pause, unpause, and the admin-override time-delay enforcement. The Anchor program is 444 KB, IDL is 33 KB. The frontend builds under 251 KB First Load JS on the markets page. The automation service runs a real cron schedule in America New York timezone.

One sentence summary. A non-custodial binary stock outcome market on Solana with on-chain settlement, an in-program order book, and a daily automation cycle that creates and settles every market without human intervention.

---

## Anticipated cross-exam (notes; do not read)

Q. Why one book per strike and not one book per ticker.
A. Each strike is a separate instrument with a different probability surface. Mixing strikes on one book would have different fair values trying to price the same Yes mint, which makes no sense. Per-strike books also keep the slab sizes small enough to fit in the 10K CPI create limit.

Q. What stops the admin from settling early.
A. `admin_settle` reads `Clock::get()?.unix_timestamp` and rejects if `now < market.admin_override_earliest`. That field is set at create_strike_market to `created_at + admin_override_delay_secs` (default 3600). The check is on chain, not in the cron, so even a compromised admin keypair cannot front-run the delay.

Q. What about the position-constraint asymmetry.
A. Frontend blocks Buy Yes when user holds No tokens. Program does not, because a market maker calling mint_pair legitimately holds both for the brief window before they post the limit sell. Documented in code comments at both layers. If a sophisticated user wants both, they can use the CLI.

Q. Why aren't matches happening yet.
A. Slice 3 ships escrow plus insert. Matching is the next cranker. The choice was: ship a working order book that users can post against and cancel from this week, then add the matcher next, vs ship a half-broken matcher today. The trade-off is documented.

Q. Why not Token-2022.
A. No transfer hooks needed in v1. Token-2022 adds CPI overhead on every transfer. Revisit if v2 needs protocol fees or confidential transfers.

Q. What if Pyth gives a bad price.
A. The on-chain settle reads validate `publish_time` (max 5 min stale, configurable) and `conf` (max 50 bps, configurable). Bad prices reject. The automation retries every 30 seconds for 15 minutes. If Pyth is still bad, admin can call `admin_settle` after the 1-hour delay with a manual close price. The override flag is recorded on chain so anyone can audit the path that was taken.

---

## Pre-call checklist (10 min before)

- [ ] HEAD on both remotes matches: `git ls-remote origin main && git ls-remote gitlab main`
- [ ] `anchor test` green (run from repo root)
- [ ] Frontend `pnpm build` green
- [ ] Automation `pnpm tsc --noEmit` green
- [ ] `target/idl/meridian.json` present (defenders may want to look)
- [ ] Have the architecture website open in a tab
- [ ] Have one weak point pre-decided to volunteer if the room is silent: matching engine is the under-tested piece

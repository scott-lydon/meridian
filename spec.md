# Meridian Specification

What we are building and why. User stories with Given/When/Then acceptance. Out-of-scope. Rubric pillar mapping. The 60-second demo.

This file is what `plan.md` optimizes against and what `tasks.md` decomposes into. If the spec is vague, the plan will be wrong. If the plan disagrees with this spec, the spec wins until this file is amended.

---

## Problem statement

Retail participants want to express short-term directional views on individual US stocks without learning options Greeks, without a margin account, and without exposure to unlimited downside. They want the maximum gain and maximum loss known at entry, in dollars, in cents.

Meridian is a non-custodial decentralized application on Solana devnet that lets users trade binary outcome contracts on the daily closing prices of MAG7 equities. Each contract pays $1.00 USDC if the underlying stock closes at or above a fixed strike at 4:00 PM ET on the trading day the contract was created, and $0.00 otherwise. The complementary No token pays the inverse. Both tokens are tradable on an on-chain order book until 4:00 PM ET. Settlement is automated via an on-chain oracle read. Winners redeem at any time after settlement; redemption is open indefinitely.

Success is when a user can connect a wallet, fund it with devnet USDC, trade Yes or No tokens on a real strike, see settlement happen automatically within 10 minutes of market close, and redeem their winnings in one transaction. Every step verifiable on-chain. No custody. No KYC. No margin.

## Personas

- **Bullish retail trader.** Wants to express "META will close above $680 today." Clicks Buy Yes. Signs once. Watches the close. Redeems if right.
- **Bearish retail trader.** Wants "META will close below $680 today." Clicks Buy No. One signature (atomic mint-and-sell-Yes). Redeems if right.
- **Market maker.** Mints Yes/No pairs at $1.00 each. Posts limit orders on the order book at $0.55 ask and $0.45 bid (or wherever they read the implied probability). Earns the spread.
- **Admin / automation operator.** Runs the off-chain service. Watches the dashboard. Triggers admin override only when the oracle has failed for 15 minutes past close.

## User stories

Format: `As a <role>, I want <capability>, so that <outcome>.` Each story carries explicit acceptance criteria in Given/When/Then form, and names the rubric pillar it serves.

### US-1: Connect wallet and see balance

**As a** retail trader, **I want** to connect Phantom or Solflare and see my USDC balance, **so that** I know what I have to trade with.

Acceptance:
- Given the user lands on the published URL with no wallet connected
- When the user clicks "Connect Wallet" and approves in the wallet popup
- Then the wallet address appears in the header, the USDC balance is shown in 2-decimal precision, and SOL balance is shown for gas
- And if the balance is below 1 USDC, an unobtrusive prompt offers the devnet USDC faucet link

Rubric: Architecture (non-custodial connection), Security (no key material leaves the wallet).

### US-2: Browse markets

**As a** retail trader, **I want** a grid of the 7 MAG7 stocks showing today's contracts, **so that** I can pick what to trade.

Acceptance:
- Given the user is on the Markets page on a trading day after 09:00 ET
- When the page loads
- Then 7 cards are visible (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA), each showing previous close, current oracle price, number of active strikes today, and the strike nearest the current price
- And clicking any card navigates to the Trade page for that ticker

Rubric: Architecture (data flow), Scalability (efficient on-chain reads).

### US-3: Buy Yes

**As a** bullish trader, **I want** to buy Yes tokens at the current ask, **so that** I take a position on the stock closing above the strike.

Acceptance:
- Given the user is on the Trade page for META > $680 with USDC balance ≥ 1 and no No tokens for this strike
- When the user clicks "Buy Yes", enters a quantity, selects Market, and signs in the wallet
- Then exactly one transaction is sent, USDC decreases by `quantity × best_ask_yes_price`, the Yes token balance for this market increases by `quantity`, and the portfolio reflects the new position with the correct entry price
- And if the user holds No tokens for this strike, the Buy Yes button is disabled with a "Sell No first" prompt that links to a one-click exit

Rubric: Architecture (order book), Testing (4-trade-path coverage).

### US-4: Buy No (atomic)

**As a** bearish trader, **I want** Buy No to be a first-class action that costs me one signature, **so that** the bearish path is as ergonomic as the bullish path.

Acceptance:
- Given the user has USDC ≥ 1 and holds no Yes tokens for this strike
- When the user clicks "Buy No", enters a quantity, selects Market, and signs in the wallet
- Then exactly one wallet popup appears (no second signature for the mint or the sell)
- And the transaction atomically mints a Yes/No pair, sells the Yes at the best bid, and leaves the user with `quantity` No tokens
- And the USDC delta equals `quantity × (1.00 − best_bid_yes_price)` exactly
- And if any leg of the atomic transaction would fail, the whole transaction reverts and no orphan Yes tokens exist

Rubric: Architecture (the atomicity is the whole point), Security (no partial state).

### US-5: Sell Yes

**As a** trader holding Yes tokens, **I want** to exit by clicking Sell Yes, **so that** I realize my position.

Acceptance:
- Given the user holds Yes tokens for this strike
- When the user clicks "Sell Yes", enters quantity, selects Market, signs
- Then the Yes balance decreases by `quantity`, USDC increases by `quantity × best_bid_yes_price`, and the portfolio shows the realized P&L computed against the user's average entry price

Rubric: Testing (4-trade-path coverage).

### US-6: Sell No (atomic)

**As a** trader holding No tokens, **I want** to exit by clicking Sell No without thinking about the buy-Yes mechanic underneath, **so that** the UX matches my mental model.

Acceptance:
- Given the user holds No tokens for this strike
- When the user clicks "Sell No", enters quantity, selects Market, signs once
- Then exactly one wallet popup appears
- And the transaction atomically buys a Yes from the ask side and redeems the resulting Yes+No pair for USDC
- And the No balance decreases by `quantity`, USDC increases by `quantity × (1.00 − best_ask_yes_price)`, and realized P&L is shown

Rubric: Architecture (the buy-Yes-then-redeem-pair atomicity), Testing.

### US-7: Mint pair (market maker)

**As a** market maker, **I want** to deposit USDC and receive equal quantities of Yes and No tokens, **so that** I can quote both sides of the book.

Acceptance:
- Given the user has USDC ≥ N and the market is not paused
- When the user calls Mint Pair with quantity N
- Then USDC decreases by N (in base units), Yes balance increases by N, No balance increases by N, and the vault balance for this market increases by N
- And `vault_balance == total_pairs_outstanding × 1.00 USDC` holds after this operation

Rubric: Architecture (vault accounting), Security (invariant).

### US-8: Settlement

**As a** system, **I want** every contract to settle automatically within 10 minutes of 4:00 PM ET, **so that** users do not wait for redemption.

Acceptance:
- Given the trading day is a US trading day and the time is 16:05 ET
- When the automation service runs the settlement job
- Then for every open contract, `settle_market` is called with the oracle price for that ticker
- And for each settled market, `yes_payout + no_payout == 1.00 USDC` exactly
- And the outcome account on-chain is marked `is_settled = true`, `settled_at` is the unix timestamp, `closing_price` is the value read from the oracle
- And if the oracle returns stale or low-confidence data, the job retries every 30 seconds for up to 15 minutes
- And after 15 minutes of failure, an alert fires to the operator and the contract remains unsettled until admin override

Rubric: Architecture (oracle integration), Scalability (parallelizable across 35 to 49 markets per day), Security (price validation).

### US-9: Redeem

**As a** winner, **I want** to click Redeem and receive my USDC, **so that** I close out the cycle.

Acceptance:
- Given the user holds N winning tokens for a settled market
- When the user clicks Redeem and signs
- Then exactly one wallet popup appears
- And the N tokens are burned, the vault releases `N × 1.00 USDC` to the user's USDC ATA
- And redemption remains available indefinitely; the user can return weeks later and still redeem
- And losers can also click Redeem; the operation succeeds, burns the worthless tokens, returns the SPL rent, and pays $0.00

Rubric: Security (the vault drain math), Testing (the at-strike case).

### US-10: Position constraint (UX)

**As a** trader, **I want** the UI to stop me from holding both Yes and No tokens simultaneously from trading, **so that** I do not accidentally end up in a fully-hedged no-op position.

Acceptance:
- Given the user holds Yes tokens for a strike
- When the user opens the Trade page for that strike
- Then "Buy No" and "Mint Pair" are visibly disabled, with a tooltip explaining "Sell Yes first" and a one-click exit button
- And the symmetric rule applies for No-holders being blocked from Buy Yes
- And during the transient state of a Buy No limit order (holding both Yes and No until the Yes leg fills), the portfolio labels the Yes leg as "Pending sell" and does NOT trip the warning

Rubric: Architecture (UX-vs-program-invariant asymmetry), Testing.

### US-11: Admin override

**As an** operator, **I want** a fallback `admin_settle` that I can invoke when the oracle has failed for over 15 minutes, **so that** users can still redeem.

Acceptance:
- Given the current time is ≥ 1 hour after market close (≥ 17:00 ET) for a still-unsettled market
- When the admin signs `admin_settle(market, manual_close_price)`
- Then the market settles with the manual price, the outcome account flags `is_admin_override: true`, and an event log entry records the admin key and timestamp
- And if `admin_settle` is called before 17:00 ET, the instruction reverts with `AdminOverrideTooEarly` naming both timestamps
- And if a non-admin signs `admin_settle`, the instruction reverts with `Unauthorized`

Rubric: Security (privileged operation), Architecture (failure handling).

### US-12: Pause / Unpause

**As an** admin, **I want** to pause minting and trading in an emergency, **so that** I can investigate without users losing money to a known bug.

Acceptance:
- Given the admin signs `pause`
- When any user attempts `mint_pair` or any order-book entry instruction
- Then the instruction reverts with `ProgramPaused`
- And `redeem` continues to work for any holder (pause must not be a hostage)
- And `unpause` from the admin restores normal operation

Rubric: Security (operational control).

### US-13: Portfolio and P&L

**As a** trader, **I want** a portfolio page that shows my active positions, settled outcomes, and a Redeem button per settled position, **so that** I see my P&L in one place.

Acceptance:
- Given the user has positions across multiple strikes
- When the user navigates to /portfolio
- Then active positions display: strike, side (Yes/No), quantity, average entry price, current mark (mid), unrealized P&L in USDC
- And settled positions display: strike, outcome (Yes won / No won), the closing price, payout per token, total payout, and a Redeem button if not yet redeemed
- And the aggregate P&L (top of page) equals the sum of per-position P&L lines exactly; no off-by-one in the aggregation

Rubric: Architecture (chain state aggregation), Testing.

### US-14: History

**As a** trader, **I want** every transaction I've signed in the last 30 days listed with an explorer link, **so that** I can audit my own activity.

Acceptance:
- Given the user has signed N transactions across the session
- When the user navigates to /history
- Then a chronological list shows: timestamp, action label ("Buy Yes 5 @ $0.62"), tx signature with an explorer hyperlink, and the resulting balance changes

Rubric: Architecture (read-only aggregation), Documentation.

### US-15: Daily lifecycle (automation)

**As an** operator, **I want** the system to run the morning create-markets job and the 4:05 PM settlement job automatically every trading day, **so that** no human intervention is needed during normal operation.

Acceptance:
- Given the date is a US trading day
- When the morning job fires at 08:00 ET
- Then 7 oracle reads happen, strikes are computed at ±3%, ±6%, ±9% rounded to the nearest $10, duplicates removed, and `create_strike_market` is called once per unique strike per ticker
- And on a weekend or NYSE holiday, the job exits early with a log line "not a US trading day"
- And the settlement job fires at 16:05 ET and settles every open market within 10 minutes barring oracle failure
- And both jobs are idempotent; a second invocation on the same day is a no-op

Rubric: Architecture (daily lifecycle), Operability.

## Out of scope (v1)

These are intentionally excluded. Each line carries the reason so future arguments are settled by quoting this file.

- **Mainnet deployment.** PRD: "Never use mainnet or real funds for the core submission." Bonus only.
- **Non-MAG7 tickers.** Adding more underlyings is straightforward but expands the oracle and automation surface. v1 is exactly the 7 named stocks.
- **Multi-day contracts.** PRD defines 0DTE (same-day expiry). Multi-day instruments add expiry-management complexity without changing the architecture.
- **In-program order book matching against external CLOBs.** Decision is made in plan.md to ship a minimal in-program book; cross-CLOB routing is out.
- **Margin or leverage.** PRD: "no margin." Always 1:1 collateral.
- **KYC, AML, or regulatory disclosure UI.** PRD: "no regulatory or compliance claims."
- **Fee revenue.** v1 charges no protocol fee. Fees would change the vault math; revisit in v2.
- **Mobile-first UI.** Responsive layout is required (the trade page must work on a phone) but native mobile apps are out.
- **Token gating, governance, or DAO.** v1 has a single admin keypair. DAO ownership is out.
- **Liquidity mining or rewards.** Out.
- **Cross-chain bridges.** USDC is whatever USDC is on the chosen chain. No bridging.
- **Per-fill cost basis tracking (avg entry price + unrealized P&L on active positions).** US-13's avg-entry-price and unrealized-P&L columns would require an off-chain indexer (Helius webhook on `place_order` / `buy_no` / `sell_no` fills) to attribute fill prices back to the user. v1 ships net redeemable USDC for settled markets (which IS realized P&L) and current-mark (mid = (best_bid + best_ask) / 2 in USDC micros, from `quoteFromBook` in `useOrderBookFor.ts`) for active markets so users see the mark-to-market without per-fill attribution. Mid was chosen over single-sided best-bid because mid is the standard fair-value mark in equity options and degrades to `undefined` (rendered as a blank cell) when the book is one-sided rather than printing a misleading value. Indexer ships in v2.

The defense and the AI interview will be evaluated against four pillars. Every user story above is tagged to the pillar(s) it serves. This table is the line of evidence we cite back to in `docs/AI_INTERVIEW_PREP.md`.

| Pillar | User stories serving it | What we will demonstrate |
|---|---|---|
| Architecture | US-1, US-2, US-3, US-4, US-6, US-7, US-8, US-10, US-11, US-15 | Non-custodial wallet flow, one order book serving four user actions, atomic Buy No mint-and-sell, oracle integration with retries, admin override fallback |
| Scalability | US-2, US-8 | Solana sub-second finality, parallelizable settlement across 35-49 markets per day, efficient on-chain reads via `getProgramAccounts` filters |
| Security | US-1, US-7, US-8, US-9, US-11, US-12 | Vault invariant enforced on-chain, settle outcome immutable, admin override time-locked, pause does not hostage redemption, oracle staleness and confidence validated |
| Testing | US-3, US-4, US-5, US-6, US-9, US-10, US-13 | Property tests for $1.00 invariant (1000 samples), explicit at-strike test, four-trade-path coverage, e2e lifecycle test under 60s |

## 60-second demo script

This is the path the AI interviewer or peer reviewer will be shown. It is the happy path. The whole walkthrough takes about a minute.

1. **Open the deployed URL.** Landing page shows the 7 tickers with live prices. (5s)
2. **Connect Phantom (devnet).** Wallet header shows address and USDC balance funded from the faucet. (5s)
3. **Click into META.** Strike list visible; pick META > $680 (closest to spot). Order book renders both Yes and No perspectives of the same underlying CLOB. (10s)
4. **Buy Yes 10 @ market.** One signature. Portfolio updates: 10 Yes tokens, average entry $0.55, unrealized P&L $0.00 at the mark. (10s)
5. **Switch to a different wallet, Buy No 10 @ market.** One signature. Show that the wallet popup is single and atomic. Portfolio: 10 No tokens, average entry $0.45. (10s)
6. **Fast-forward to 16:05 ET (or use the time-mock toggle for the demo).** Settlement happens automatically. Outcome account shows `is_settled = true`, closing price $688, Yes wins. (10s)
7. **Switch back to wallet 1, click Redeem.** One signature. 10 USDC arrives. (10s)

Total: ~60 seconds. The whole loop is verifiable on a Solana explorer link shown alongside the UI.

## Risks and known limitations

(Mirrors `constitution.md` §9; restated here so spec.md is self-contained.)

- Devnet-only. No real-money behavior.
- Oracle-dependent. A 15-minute oracle outage forces admin override mode.
- Same-day expiry. No multi-day positions.
- Liquidity in the demo is provided by the test wallets; production market-making is out of scope.
- The position constraint is a UX rule. A motivated user with a transaction signer can hold both Yes and No simultaneously by calling the program directly. The constitution documents why this is intentional (market makers need it transiently).

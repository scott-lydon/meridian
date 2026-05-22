# Meridian Tasks

Actionable slices. Each task names which `spec.md` user story it serves, which `plan.md` component it touches, and the done-criteria the qa-adversary can replay. Check the box AND commit the check in the same commit as the code; the diff makes the slice auditable.

`Current slice` = the work the agent picks up next. `Next slice` = the one after. `Backlog` = everything else, ordered by `plan.md` §6 sequencing.

Format: `- [ ] T-<slice>.<n>: <action verb> <noun> | <user-story> | <plan-component> | <done-criteria>`

---

## Current slice: Repo bootstrap

This slice has no PRD user story; it is meta-work to make slice 1 land cleanly.

- [ ] T-0.1: Initialize Anchor workspace at the repo root | meta | program | `anchor init meridian` runs cleanly, `anchor build` produces a `.so` binary
- [ ] T-0.2: Create Next.js workspace at `app/` | meta | frontend | `pnpm create next-app@latest app --typescript --app --tailwind --eslint` succeeds; landing route renders "Hello Meridian"
- [ ] T-0.3: Create automation workspace at `automation/` | meta | automation | `automation/package.json` with `tsx`, `croner`, `@solana/web3.js`, `@coral-xyz/anchor`, `pino` deps; a `pnpm run health` command starts a server that responds 200 at `/health`
- [ ] T-0.4: Set up workspace package manager | meta | repo | pnpm workspaces with three packages (`program`, `app`, `automation`); shared TS config in `tsconfig.base.json`
- [ ] T-0.5: Create `.env.example` at repo root | meta | repo | lists every key the three packages need: `SOLANA_RPC_URL`, `MERIDIAN_PROGRAM_ID`, `USDC_MINT`, `PYTH_FEED_AAPL`...`PYTH_FEED_TSLA`, `ADMIN_KEYPAIR_PATH`, `AUTOMATION_KEYPAIR_PATH`, `CRANKER_KEYPAIR_PATH`, `SLACK_WEBHOOK_URL`
- [ ] T-0.6: Set up GitHub + GitLab dual push | meta | repo | `git remote -v` shows `origin` with two push URLs (per constitution §2.7); `git ls-remote origin main` and `git ls-remote gitlab main` return the same hash after first push
- [ ] T-0.7: Set up CI on GitHub Actions | meta | repo | workflow `.github/workflows/ci.yml` runs `cargo fmt`, `cargo clippy -D warnings`, `anchor test`, `pnpm -r lint`, `pnpm -r tsc --noEmit`, `pnpm -r test`, fails on any non-zero exit
- [ ] T-0.8: Set up pre-commit hooks via `prek` | meta | repo | `prek install` runs the same checks as CI minus `anchor test`; running `prek run --all-files` on a fresh clone passes
- [ ] T-0.9: Copy `meridian-manual-tests.md` into `tests/manual/meridian-acceptance.md` | meta | tests | file present in repo, link in README
- [ ] T-0.10: Write README with one-command setup | meta | repo | a fresh clone followed by `make dev` (or documented equivalent) gets the user a running localnet validator with the program deployed and the frontend serving on localhost:3000

Done criteria for slice 0: `make dev` runs end-to-end on a fresh clone with no human input beyond an `.env` copy. CI green. qa-adversary review passes.

---

## Next slice: Slice 1 — Anchor program scaffold

PRD user stories served: US-7 (Mint pair), US-9 (Redeem happy path).

- [ ] T-1.1: Define `Config` account struct | US-7, US-9 | program / Config | fields: admin, usdc_mint, oracle_feed_per_ticker (Vec of 7), max_staleness_secs, max_confidence_bps, paused (bool), admin_override_delay_secs; `LEN` const documented with arithmetic
- [ ] T-1.2: Implement `initialize_config` instruction | US-7 | program | succeeds on first call, fails with `ConfigAlreadyInitialized` on second; covered by `tests/initialize.ts`
- [ ] T-1.3: Define `Market` account struct | US-7, US-9 | program / Market | fields per plan.md §2.1; seeds documented in `// seeds:` comment
- [ ] T-1.4: Implement `create_strike_market` (admin only) | US-7 | program | initializes `Market`, `OrderBook` (empty slabs), `Vault` (USDC ATA), `YesMint`, `NoMint`; rejects non-admin signer with `Unauthorized`; tested for happy + unauthorized paths
- [ ] T-1.5: Implement `mint_pair` instruction | US-7 | program | user deposits N USDC, receives N Yes + N No; vault balance increases by N exactly; covered by happy path + a property test asserting `vault == total_pairs × 1e6` for N in [1, 10_000]
- [ ] T-1.6: Implement `redeem` instruction (with stub Outcome) | US-9 | program | works for both winning and losing sides; loser path returns rent SOL, pays $0 USDC; winning path transfers exact USDC and closes the user's token ATA when balance hits zero
- [ ] T-1.7: Property test: vault invariant under mixed mint/redeem | US-7, US-9 | tests | `proptest` runs 1000 sequences of mint/redeem with random `n` in [1, 1000]; after each step asserts `vault == sum_of_mints − sum_of_redemptions × 1e6`
- [ ] T-1.8: Update README with the slice 1 demo command | US-7 | repo | `make demo-slice-1` deploys the program to localnet, calls initialize + create + mint + redeem, prints the on-chain log

Done: all checkboxes; CI green; qa-adversary review of slice 1 passes; commit message follows Conventional Commits (`feat(program): scaffold mint and redeem`).

---

## Backlog

Slice 2 — Oracle and settlement (US-8, US-9)

- [ ] T-2.1: Add Pyth dependencies to `program/Cargo.toml` | US-8 | program | `pyth-solana-receiver-sdk` pinned; rebuild succeeds
- [ ] T-2.2: Implement Pyth staleness check helper | US-8 | program | `validate_pyth_freshness(update, now, max_age) -> Result<()>` with explicit error variant `OraclePriceStale { age_secs, max_age_secs }`
- [ ] T-2.3: Implement Pyth confidence check helper | US-8 | program | rejects when `conf * 10_000 / price > max_bps` with error variant `OracleConfidenceTooWide { conf_bps, max_bps }`
- [ ] T-2.4: Implement `settle_market` instruction | US-8 | program | reads Pyth update, validates, compares to strike (at-or-above), writes Outcome; tested for above, at, and below strike
- [ ] T-2.5: Named `at_strike_yes_wins` test | US-8 | tests | test function literally named so; closing price exactly equals strike; asserts Yes wins (per PRD line)
- [ ] T-2.6: Property test for $1.00 invariant | US-8 | tests | 1000 random closing prices around the strike; asserts `yes_payout + no_payout == 1_000_000` (USDC base units) for every sample
- [ ] T-2.7: Implement `admin_settle` with time-delay | US-11 | program | rejects with `AdminOverrideTooEarly { now, earliest }` before `market.created_at + admin_override_delay_secs`; rejects non-admin with `Unauthorized`
- [ ] T-2.8: Implement `pause` / `unpause` | US-12 | program | `pause` flips Config.paused; `mint_pair` and `place_order` reject with `ProgramPaused`; `redeem` continues to work; test covers all three
- [ ] T-2.9: Settlement immutability test | US-8 | tests | after settle with one price, second `settle_market` with a different price reverts with `MarketAlreadySettled`

Slice 3 — In-program order book (US-3, US-5)

- [ ] T-3.1: Define order book slab structures | US-3 | program / OrderBook | bids/asks as fixed-cap arrays; each entry `(price_ticks: u32, qty: u64, sequence: u64, owner: Pubkey)`; LEN constants computed
- [ ] T-3.2: Implement `place_order` (limit + IOC) | US-3, US-5 | program | inserts into slab respecting price-time priority; for IOC, walks the opposite side and reverts if not fully filled
- [ ] T-3.3: Implement `cancel_order` | US-3 | program | only the owner can cancel; gas-refund pattern (return rent if applicable)
- [ ] T-3.4: Implement `match_orders` (cranker) | US-3 | program | permissionless; walks crossing orders, transfers USDC and Yes between maker and taker, emits `Fill` events
- [ ] T-3.5: Property test: USDC + Yes conservation | US-3 | tests | 1000 random order sequences; assert `sum(user_usdc) + vault_usdc` is constant; assert `sum(user_yes) + sum(yes_in_open_orders) == yes_supply`
- [ ] T-3.6: Account-list budget assertion test | US-4 | tests | construct a Buy No tx that fills against 2 makers; assert account list size under 64

Slice 4 — Atomic Buy No and Sell No (US-4, US-6)

- [ ] T-4.1: Implement `buy_no` instruction | US-4 | program | bundles `mint_pair` + IOC `place_order(Sell)` in one function; either both happen or both revert
- [ ] T-4.2: `buy_no` revert test (insufficient liquidity) | US-4 | tests | underfunded book; assert no orphan Yes tokens after revert
- [ ] T-4.3: Implement `sell_no` instruction | US-6 | program | bundles IOC `place_order(Buy)` + `redeem_pair` (internal helper); requires user holds qty No tokens
- [ ] T-4.4: `sell_no` end-to-end test | US-6 | tests | user holds 10 No, sells 10, USDC delta matches `10 × (1 - best_ask_yes)`

Slice 5 — Frontend foundation (US-1, US-2)

- [ ] T-5.1: Next.js app router scaffold | US-1 | frontend | `/`, `/markets`, `/trade/[ticker]/[strike]`, `/portfolio`, `/history` routes exist with placeholder content
- [ ] T-5.2: Wallet adapter provider at root layout | US-1 | frontend | Phantom + Solflare + Backpack adapters; Connect Wallet button renders the adapter's modal
- [ ] T-5.3: USDC balance hook | US-1 | frontend | `useUsdcBalance()` returns balance in branded `UsdcBase = bigint` type; auto-refreshes on `onAccountChange`
- [ ] T-5.4: Anchor client hook | US-2 | frontend | `useMeridian()` returns typed instruction builders from the generated IDL
- [ ] T-5.5: Markets grid | US-2 | frontend | reads all of today's Market accounts via `getProgramAccounts` filtered by `trading_day_unix`; renders 7 cards
- [ ] T-5.6: Zustand store with non-allocating selectors | US-2 | frontend | linter rule asserts selectors do not return `[...x]` or `{...x}` (per boxy-fractions lesson)

Slice 6 — Trade page (US-3 through US-6, US-10)

- [ ] T-6.1: Order book WebSocket subscription | US-3 | frontend | `onAccountChange` for the active market's OrderBook PDA; renders bids and asks in real time
- [ ] T-6.2: Yes/No perspective toggle | US-3 | frontend | one underlying book, two views; No view is a pure transform of Yes
- [ ] T-6.3: Trade panel with four buttons | US-3, US-4, US-5, US-6 | frontend | Buy Yes / Buy No / Sell Yes / Sell No; market or limit; quantity input
- [ ] T-6.4: Atomic Buy No tx builder | US-4 | frontend | one wallet popup; pre-flight balance check; success state updates portfolio
- [ ] T-6.5: Atomic Sell No tx builder | US-6 | frontend | symmetric
- [ ] T-6.6: Position constraint enforcement | US-10 | frontend | disable Buy Yes when No balance > 0; tooltip + "Sell No first" button; symmetric for the reverse
- [ ] T-6.7: Settlement countdown timer | US-3 | frontend | counts down to 16:00 ET in user's local timezone; uses injected clock for testability

Slice 7 — Portfolio and history (US-9 UI, US-13, US-14)

- [ ] T-7.1: Aggregate user positions across all markets | US-13 | frontend | reads user's Yes and No ATAs across all today's markets in a single batched RPC call
- [ ] T-7.2: P&L computation with branded types | US-13 | frontend | unrealized P&L from current mid; realized P&L from history; aggregate matches sum exactly (no off-by-one)
- [ ] T-7.3: Redeem button on settled positions | US-9 | frontend | one wallet popup; works for losers too (rent-return path)
- [ ] T-7.4: History page with explorer links | US-14 | frontend | reads user's tx signatures from RPC, decodes Meridian instructions, renders chronological list with explorer hyperlinks

Slice 8 — Automation service (US-8 automated, US-15)

- [ ] T-8.1: NYSE calendar check | US-15 | automation | `isUsTradingDay(date) -> boolean`; tests cover holidays + weekends
- [ ] T-8.2: Morning job cron | US-15 | automation | `croner` schedule `0 8 * * 1-5` `America/New_York`; calls Pyth Hermes for previous close per ticker; computes strikes; calls `create_strike_market` per unique strike
- [ ] T-8.3: Settlement job cron | US-8, US-15 | automation | `5 16 * * 1-5` `America/New_York`; per-ticker retry every 30s for 15min; Slack webhook on give-up
- [ ] T-8.4: Crank loop | US-3 | automation | every 400ms (one slot), polls active OrderBook PDAs; submits `match_orders` if crossing
- [ ] T-8.5: `/health` endpoint | US-15 | automation | returns `{status, lastMorningRun, lastSettlementRun, crankerStatus}`; Render uses it for the platform's health check
- [ ] T-8.6: Structured logging with `pino` | US-15 | automation | JSON output; per-ticker entries on every job run
- [ ] T-8.7: Idempotency test for morning job | US-15 | tests | invoke twice on same date; second invocation logs "already created" and does not submit any tx

Slice 9 — Devnet deployment

- [ ] T-9.1: Deploy script | devnet | repo | `make deploy-devnet` runs `anchor deploy --provider.cluster devnet` + `initialize_config` + writes program-id to a checked-in `Anchor.toml`
- [ ] T-9.2: Devnet faucet integration in frontend | US-1 | frontend | embedded button hitting Circle's devnet USDC faucet; falls back to a link on rate-limit
- [ ] T-9.3: Run the manual test plan end-to-end on devnet | acceptance | tests | every phase in `tests/manual/meridian-acceptance.md` passes; results checked into `tests/manual/runs/2026-MM-DD-devnet.md`

Slice 10 — Polish and defense docs

- [ ] T-10.1: `ARCHITECTURE.md` | docs | repo | reflects every decision in `plan.md` §4; updated in same commit as any architectural change
- [ ] T-10.2: `website/index.html` | docs | repo | Mermaid topology, decision table, trade-off panels (one per `plan.md` §5 panel), Chart.js cost analysis; Simple Icons logos on every node and every tech-stack card; no edge crossings
- [ ] T-10.3: `docs/DEFENSE_BREAKOUT_SCRIPT.md` | docs | repo | 5-min spoken script per project rules (no meta about format, no forced contrasts, no em-dashes)
- [ ] T-10.4: `docs/AI_INTERVIEW_PREP.md` | docs | repo | 12+ prepared answers sorted by likelihood; interview portal link at top; spoken-prose style; named concrete examples per testing/security mechanism
- [ ] T-10.5: README final pass | docs | repo | one-command setup; demo script; troubleshooting

---

## Hardening backlog (discovered post-slice-launch)

These are not part of the slice 1-10 PRD sequence; they are correctness or robustness gaps surfaced by Vouch or by user investigation that should be fixed before any mainnet pass.

- [ ] T-H.1: On-chain expiry enforcement | hardening | program | `place_order`, `mint_pair`, `buy_no`, `sell_no`, and `match_orders` reject with `MarketExpired { now, expiry_unix }` when `Clock::get()?.unix_timestamp >= market.expiry_unix`. Today the gate is UX-only — the trade page and architecture page both explicitly call this out, but a determined wallet bypassing the UI could still submit those instructions between 16:00 and 16:05 ET. Done when the property test in `tests/program/expiry.rs` proves the rejection on each of the five instructions and the architecture page Step 3 copy can be tightened to "the program rejects."
- [ ] T-H.2: Settle-cron health surfaced on /audit | hardening | automation | `useAutomationHealth` rendering on `app/src/app/audit/page.tsx` exposes `lastSettlementRun.error` and `lastMorningRun.error` when set. The boot-time catch-up landed in `automation/src/index.ts` (commit 53c8f86) and CORS landed in this pass; this task is the UI surface that uses those fields to show "automation healthy" vs "morning cron erroring 6h ago".
- [ ] T-H.3: Off-hours markets-page banner copy review | hardening | frontend | the `before-open`, `after-close`, and `weekend` copy in `app/src/lib/marketSession.ts` was written for the v1 schedule. Revisit when the schedule changes (multi-day markets, futures, etc.) so the copy keeps matching what the cron actually does.

---

## Done definition

A slice is done when:
1. Every checkbox is checked AND the checked state is in the same commit as the code.
2. CI is green.
3. The qa-adversary sub-agent has reviewed the slice diff in a fresh context and returned no blocking findings.
4. The slice's done-criteria (named under each `Done:` line) are demonstrable on a fresh clone.

A slice is NOT done when:
- Any test is skipped or commented out without an issue link.
- Any baseline is added to a static-analysis tool.
- Any `.env*` file other than `.env.example` or `.env.test` is in the diff.
- The qa-adversary has not run.

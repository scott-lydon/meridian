# Meridian — Test Results

Captured on 2026-05-25 against HEAD `86dd12bc08376349a01fbf581364a74f4cabb74b` (identical on `origin` and `gitlab`). Every layer is reproducible by the commands below; no fixtures rely on hidden state.

## Summary

| Layer | Tool | Result |
|---|---|---|
| On-chain pure logic | `cargo test -p meridian --lib` | **67 passed, 0 failed** in 40 ms |
| qa-adversary property + permutation | `pnpm --filter @meridian/tests test` | **32 passed, 3 intentional FAILING regressions** (see note) |
| Automation worker unit tests | `pnpm --filter @meridian/automation test` | **5 passed, 0 failed** |
| On-chain TS integration | `anchor test` (requires `solana-test-validator`) | Not re-run in this report; the existing slice-1 test under `tests/meridian.test.ts` covers initialize → create_strike_market → mint_pair → settle_market_manual → redeem end-to-end |

## Layer 1 — On-chain Rust unit + property tests (67 / 67)

Command:

```bash
cd /path/to/meridian
cargo test -p meridian --lib
```

Last run output:

```
test result: ok. 67 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
```

Coverage by module:

| Source file | Test count | What's exercised |
|---|---|---|
| `programs/meridian/src/math.rs` | 29 | YesWins/NoWins boundary; Pyth `price * 10^(exponent + 6)` scaling for AAPL and META at typical exponents (-2, -8); every checked-overflow path; confidence-bps boundary at 0%, 50 bps, 100%; `proptest` round-trip and monotonicity properties |
| `programs/meridian/src/order_book.rs` | 24 | `OrderSide` round-trip and unknown-byte rejection; `Order::SIZE` = 56 bytes pinning; `usdc_total` overflow + linearity property; bid-descending sort property; ask-ascending sort property; FIFO at same price; capacity rejection; find / remove_at; sequence increments globally across sides; insert-then-find round-trip property |
| `programs/meridian/src/state.rs` | 4 | `Outcome::pending` zero-init invariant; `is_settled` state machine across Pending / YesWins / NoWins; `admin_override` flag orthogonality; `Config::LEN` arithmetic drift detector |
| `programs/meridian/src/constants.rs` | 10 | `PROGRAM_VERSION` nonzero; `TICKER_LEN` covers the longest MAG7 ticker (GOOGL); `MAX_TICKERS` = 7; `USDC_BASE_PER_DOLLAR` = 1_000_000; `PYTH_FEED_ID_LEN` = 32; default oracle thresholds match the constitution; `MARKET_CLOSE_ET_HOUR` = 16; PDA seeds are non-empty, readable ASCII, and pairwise disjoint |

Property tests use `proptest = { workspace = true }`, declared as a `dev-dependency` on the meridian crate.

The `decide_outcome`, `pyth_price_to_micros`, and `pyth_confidence_bps` helpers in `programs/meridian/src/math.rs` were extracted from the inline math previously living in `settle_market.rs`, `admin_settle.rs`, and `settle_market_manual.rs`. The handlers now call the helpers, so the same arithmetic the validator-driven integration test exercises is also covered by these unit tests at validator-free speed.

## Layer 2 — qa-adversary property + permutation tests (32 / 35)

Command:

```bash
cd /path/to/meridian/tests
pnpm test
```

Last run output:

```
Test Files  1 failed (1)
     Tests  3 failed | 32 passed (35)
```

The three failures are the three tests whose names start with `FAILING:`. These are intentional red-tests landed by the qa-adversary sub-agent that pin known regressions until a fix lands. They turn green automatically when the fix is committed:

| Test name | Pinned bug |
|---|---|
| `FAILING: devnet-only copy is NOT shown to admins on mainnet (constitution §2.3 no dishonest UI)` | Admin UI surfaces devnet-only copy on a mainnet cluster |
| `FAILING: mainnet Explorer URL must use '' (mainnet-beta default), not 'mainnet'` | Explorer URL constructed with the wrong cluster query string |
| `FAILING: on-chain MarketAlreadySettled in settle attempt must map to MARKET_ALREADY_SETTLED (409), not SETTLE_FAILED (502)` | Settle-cron error mapping conflates the idempotent case with a generic 502 |

These bugs are open hardening items. They are listed under `tasks.md` follow-ups; the test names point directly at the file and the expected behaviour.

The other 32 tests cover the highest-bug-density pure functions mirrored out of `app/src/hooks/*`: mark-to-market math, Anchor discriminator parsing, base58 round-trip, ticks-to-micros conversion, devnet faucet retry logic.

## Layer 3 — Automation worker unit tests (5 / 5)

Command:

```bash
cd /path/to/meridian/automation
pnpm test
```

Last run output:

```
Test Files  1 passed (1)
     Tests  5 passed (5)
```

Covers `isProductionDailyLadderMarket` — the gate that protects the 16:05 ET production cron's 15-minute Pyth retry window from being pre-empted by the 30-second expiry sweep. The qa-adversary review on 2026-05-24 flagged the original loose check as a blocking regression risk; this suite is the pin.

## Layer 4 — On-chain TypeScript integration (`anchor test`)

Not re-run in this snapshot. Existing test at `tests/meridian.test.ts` walks slice-1 end-to-end against `solana-test-validator` (initialize_config → create_strike_market → mint_pair → settle_market_manual → redeem on both sides). Reproduce locally with `anchor test` from the repo root after the validator is running.

## Reproducing this whole report

```bash
git clone https://github.com/scott-lydon/meridian.git
cd meridian
git checkout 86dd12b
cargo test -p meridian --lib
( cd tests && pnpm install && pnpm test )
( cd automation && pnpm install && pnpm test )
# For layer 4, additionally:
solana-test-validator --reset --quiet &
anchor test --skip-local-validator
```

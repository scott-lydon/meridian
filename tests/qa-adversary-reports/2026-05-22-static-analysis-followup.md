# Adversary Report — 2026-05-22 static-analysis follow-up

> This file supersedes an earlier implementer self-report at the same path.
> This is the fresh-context **qa-adversary** red-team pass over commits
> `1df315f..fb2fc2a`, run per `QA_ADVERSARY.md` + `~/.claude/agents/qa-adversary.md`.

## Adversary report

### What I challenged

Four commits landed on `main` (`1df315f..fb2fc2a`) addressing static-analysis
findings across the polyglot Meridian stack: a Rust Anchor program
(`programs/meridian/`), a Next.js frontend (`app/`), and a Node automation
service (`automation/`). Test frameworks: Vitest + fast-check for the
TypeScript property harness (`tests/qa-adversary.property.test.ts`), Anchor TS
integration tests for on-chain invariants. Base branch: `origin/main`.

The change set:

1. `fb2fc2a` — split `InvalidOrderPrice` into distinct `InvalidOrderSide` +
   `OraclePriceFromFuture` error variants.
2. `0ce8426` — `useUserPositions` + `useConfig` stop swallowing
   non-`AccountNotFound` errors.
3. `367fb7e` — `match_orders` rejects already-settled markets.
4. `9acabda` — the critical fix: `pyth-onchain.ts` was passing `ctx.programId`
   where the `SettleMarket` accounts struct demands the Config PDA.

I treated every fix as guilty until proven correct: tried to bypass the
settled-market guard, hunted for other `config:`-account mis-wirings, checked
whether the new oracle error path admits any input the old code rejected, and
checked whether the hook re-throws can produce infinite retry loops or
unhandled rejections.

### Findings

**No blocking or concerning findings. All four fixes are correct.** Details of
what I verified, and three nits, below.

1. **`match_orders` settled-market guard is sound — no bypass.** *(nit-level
   confirmation, not a finding)* The guard
   (`match_orders.rs:101-104`) is `require!(!ctx.accounts.market.outcome.is_settled(), ...)`
   at the top of `handler`, before the book is loaded. `is_settled()`
   (`state.rs:137-138`) returns `!matches!(state, OutcomeState::Pending)`, so
   both `YesWins`/`NoWins` from `settle_market` *and* from `admin_settle` trip
   it. No TOCTOU: a Solana instruction deserializes its accounts once at entry
   and runs to completion with no interleaving; the only way `market` could be
   settled "between the check and the CPIs" is a *prior* instruction in the
   same tx, which would settle it *before* `match_orders` runs and is then
   caught by this very `require!`. `market` is bound to `order_book` via
   `seeds = [ORDER_BOOK_SEED, market.key().as_ref(), ...]`, so you cannot feed
   a settled market's book under an unsettled market account. The CPIs target
   the SPL token program, which cannot mutate our `Market`. Guard holds.

   Corroborating: `place_order.rs:74-76` already carried the identical
   `is_settled()` + `MarketAlreadySettled` guard, and `cancel_order.rs` has
   *no* such guard (correct — makers must recover escrow post-settle). So
   `367fb7e` closes the last unguarded mutation path and the comment's claim
   "Cancel still works post-settle" is accurate.

2. **The Config PDA fix is correct and complete.** `configPda(ctx.programId)`
   (`anchor.ts:126-131`) derives `[CONFIG_SEED, PROGRAM_VERSION_BYTE]` =
   `["config", [1]]`, byte-identical to the Rust constraint
   `seeds = [CONFIG_SEED, &[PROGRAM_VERSION]]` (`settle_market.rs:19-23`;
   `CONFIG_SEED = b"config"`, `PROGRAM_VERSION = 1u8`, `constants.rs`). I
   grepped every `.accounts({...})` call in `automation/src` for a `config:`
   key: three sites total —
   `pyth-onchain.ts:71` (`configPda(ctx.programId)` ✓),
   `settlement.ts:114` (`configPda(ctx.programId)` ✓),
   `morning.ts:117` (`config: cfg` where `cfg = configPda(ctx.programId)` at
   `morning.ts:59` ✓). **No other mis-wired `config:` account remains.**

3. **`OraclePriceFromFuture` preserves the safety property and admits no new
   path.** Old: `if age < 0 || (age as u64) > max_staleness { reject }`. New:
   `if age < 0 { reject as OraclePriceFromFuture } if (age as u64) > max { reject as OraclePriceStale }`.
   The set of `(age)` values that produce *an error* is bit-identical before
   and after — only the error *variant* differs. Negative age is still
   rejected. `age >= 0` is guaranteed before the `as u64` cast, so no wrap.
   `age == 0` (publish == now) still passes both checks, same as before. This
   is a strict refinement, not a behavior change.

4. **Hook re-throws do not loop or leak — nit only.** Global `QueryClient`
   (`queryClient.ts:8-21`) sets `retry: 1`. `useOrderBookFor` and
   `useUserPositions` set `refetchInterval: 5_000`; `useConfig` sets neither.
   A thrown `Error` from a `queryFn` is awaited and caught by React Query —
   **no unhandled promise rejection**. On a sustained RPC outage the two
   interval hooks re-run the throwing `queryFn` every 5 s (1 retry each), which
   is a paced poll, **not an infinite tight loop**, and is the intended
   "recover when RPC returns" behavior. `useConfig` retries once then rests in
   error state until invalidation/remount. All correct.

   *Nit (concerning-adjacent, by design):* `useUserPositions.queryFn` loops
   over all markets and `await`s `fetchOrderBookSnapshot` per pending market
   (`useUserPositions.ts:148`) with no per-market try/catch. A real (non
   not-found) RPC error on the *Nth* market now throws out of the whole
   `queryFn`, so the entire portfolio renders an error instead of showing the
   already-fetched markets `1..N-1`. Pre-fix, that market silently got
   pair-only valuation and the rest rendered. This is the deliberate
   "surface loudly" trade-off from Constitution §2.4 and the commit message
   endorses it — flagging only so it is a *known* trade-off, not a surprise.

5. **`useOrderBookFor` allowlist regex is fragile to Anchor wording — nit.**
   All three hooks key on `/Account does not exist|could not find account/i`.
   Anchor 0.31's `AccountClient.fetch` throws `Account does not exist or has
   no data <addr>` — the substring `Account does not exist` matches, so it is
   covered today (pinned by a new harness test, below). But this couples the
   "legitimate empty state" decision to an upstream library's *error string*.
   If a future Anchor bump rewords it, every "not initialised yet" market/book
   would start hard-erroring. Recommend (not blocking) classifying on a typed
   cause where Anchor exposes one, or pinning the Anchor version.

### Tests added

`tests/qa-adversary.property.test.ts`, harness grew **20 → 28 tests**, all pass
in ~27 ms:

- **`describe("qa-adversary: Config PDA derivation ...")`** — 3 tests *(present
  in the working tree at the start of this pass; verified, not authored here)*.
  Pins the `b"config"` / `PROGRAM_VERSION=1` seed bytes and source-greps the
  three `automation` `.accounts({})` call sites so a regression to
  `config: ctx.programId` / `config: program.programId` fails the harness.
  Reproduction check: reverting `9acabda` makes the permutation test fail with
  a pointer at `pyth-onchain.ts`; restoring it re-passes. **Catches bug #4.**

- **`describe("qa-adversary: fetch-error classification ...")`** — 5 tests
  *(added by this qa-adversary pass)*. Mirrors the
  `/Account does not exist|could not find account/i` allowlist shared by
  `useOrderBookFor.ts`, `useConfig.ts`, and `useUserPositions.ts` as the pure
  function `classifyFetchError(message) → "empty" | "rethrow"`. Properties:
  any message wrapping a not-found marker → `"empty"`; case-insensitivity;
  **8 concrete real-failure strings (RPC refused, IDL drift, decode error,
  rate-limit, timeout) must classify as `"rethrow"`**; any marker-free string
  → `"rethrow"`; and the exact Anchor 0.31 not-found string → `"empty"`.
  Before `0ce8426` the catch block was `catch { return null }`, i.e.
  `classifyFetchError ≡ () => "empty"` — the four "rethrow" assertions all
  fail against that pre-fix behavior. **This block would have caught bug #2 if
  run before the fix.**

### Mutation escapes

(mutation testing not configured — no `stryker.conf.*` in any workspace; see
Recommendations)

### What I tried that did not break

- Settling a market *between* `match_orders`' `require!` and its CPIs — not
  reachable; single-instruction atomicity forbids interleaving, and a same-tx
  prior `settle_market` is caught by the guard.
- Feeding `match_orders` a settled market's order book under a different,
  unsettled `Market` account — blocked by the `order_book` PDA seed binding.
- A second `config:`-account mis-wiring elsewhere in `automation/` — grepped
  all three `.accounts({})` sites; all use `configPda(...)`.
- `age == 0` and `age` near `i64`/`u64` boundaries in `settle_market` —
  `saturating_sub` + the `age < 0` early return make the `as u64` cast safe;
  accept/reject set unchanged vs. pre-fix.
- Driving the hooks into an infinite React Query retry loop or an unhandled
  rejection — `retry: 1`, interval-paced, promise owned by React Query.
- A "not initialised yet" book/config whose Anchor error string falls outside
  the allowlist (would cause a spurious hard error) — Anchor 0.31's actual
  message contains `Account does not exist`; pinned by a new harness test.
- `OrderSide::from_u8` with a corrupted side byte — now returns
  `InvalidOrderSide`; the only callers pass `0`/`1` or persisted bytes, and
  the discriminator harness check (`KNOWN_METHODS`) is unaffected (no
  instruction added/renamed).

### Recommendations

- **Wire mutation testing** for the harness's mirrored pure functions
  (`markValueUsdcMicros`, `quoteFromBook`, `bs58encode/decode`,
  `classifyFetchError`). Stryker on `tests/` would quantify whether the
  property assertions actually pin behavior. Not blocking.
- **Decouple the empty-state decision from Anchor's error string** (Finding 5)
  — classify on a typed/coded cause if Anchor exposes one, or pin the Anchor
  version so a minor bump cannot reword the message out of the allowlist.
- **`anchor build` / `anchor test` were intentionally skipped** (no local
  validator; per the task brief). The settled-market guard (#1) and the
  oracle-from-future variant (#3) are on-chain logic — property tests +
  `cargo`-level typing cover the reasoning, but the next full CI run with a
  validator should still exercise `tests/meridian.test.ts`. Add a Rust
  failure-path test asserting `match_orders` on a settled market returns
  exactly `MarketAlreadySettled` (per `QA_ADVERSARY.md`'s named-variant rule).

## Pipeline run

```
pnpm -r typecheck                                    ✓ app, automation, tests — all clean
cd tests && vitest run qa-adversary.property.test.ts ✓ 28/28 passed (~27 ms)
pnpm -r lint                                         see notes below — NO regressions from this diff
anchor build / anchor test                           skipped (no local validator; per task brief)
```

Lint detail (only regressions vs. this diff are flagged, per the brief):

- `automation` — 74 pre-existing ESLint errors. `pyth-onchain.ts` specifically:
  **12 errors before `9acabda`, 12 after** (verified by linting the pre-commit
  file content). The fix added a typed `configPda` import that is used, so it
  introduces no new `no-unused-vars`/`no-unsafe-*` errors. **No regression.**
- `app` — `next lint` fails to *load* its config
  (`Failed to load config "next/typescript"`). Pre-existing environment
  breakage; the diff did not touch `app/.eslintrc.json` or its deps. The
  changed hook files are nonetheless covered by `tsc` (typecheck passes).
- `tests` — no ESLint v9 flat config; pre-existing. New harness code covered
  by `tsc`.

## QA verdict

PASS — 28/28 property tests, no typecheck regressions, no lint regressions
attributable to this diff. All four fixes (`1df315f..fb2fc2a`) verified
correct under adversarial review; no blocking or concerning findings; two
documented design trade-offs and one fragility nit recorded above.

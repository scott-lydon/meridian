# QA_ADVERSARY guidance for Meridian

Project-specific overrides for the global qa-adversary sub-agent. The global
prompt lives at `~/.claude/agents/qa-adversary.md` and is language-agnostic;
this file tells the agent what is specific to Meridian.

The polyglot stack is intentional: an Anchor program in Rust on Solana
devnet, a Next.js frontend in TypeScript, an automation service in Node.js.
The harness file below covers the highest-bug-density TypeScript pure
functions; Anchor on-chain invariants are covered by `anchor test`.

---

## Project shape

- **Languages:** Rust (Anchor program, `programs/meridian/`) + TypeScript (frontend `app/`, automation `automation/`, tests `tests/`)
- **Test frameworks:**
  - Anchor TS integration tests (`anchor test`) for on-chain instructions
  - Vitest + fast-check for property/permutation tests (`tests/qa-adversary.property.test.ts`)
- **Test command (full pipeline, from repo root):**
  ```
  pnpm -r typecheck && pnpm -r lint && pnpm --filter @meridian/tests test:adversary && anchor build && anchor test
  ```
- **Test command (fast, no validator, the adversary harness itself):**
  ```
  cd tests && ./node_modules/.bin/vitest run qa-adversary.property.test.ts
  ```
  Runs in well under 1 second. 14 property/permutation tests covering mark-to-market math, base58 codec, tick/micros conversion, and Anchor instruction discriminator integrity. This is the harness; extend it whenever a hook adds a pure function or whenever a real bug is found.
- **Adversary test file (the harness):** `tests/qa-adversary.property.test.ts`
- **Anchor integration tests:** `tests/meridian.test.ts` (run by `anchor test`)
- **Base branch for diff:** `origin/main`

## Bug categories that matter most here

Meridian handles money (devnet USDC) and the constitution lists 14 non-negotiables. The qa-adversary should attack with these priorities, in order:

- **The $1.00 invariant.** `yes_payout + no_payout` must equal exactly `1_000_000` USDC micros for every contract at every lifecycle point. Any redeem path that pays out more than the vault holds, any settle that writes both outcomes as winners, any mint that issues unbalanced pairs.
- **Anchor instruction discriminator drift.** Every on-chain instruction has an 8-byte discriminator `sha256("global:<method_name>")[..8]`. The frontend's `useUserHistory.ts` decodes these to identify transactions. If `lib.rs` adds, renames, or removes an instruction, the `PRODUCTION_DISCRIMINATORS` map in the harness must update in the SAME commit. The harness has a permutation check that fails when the two diverge.
- **base58 encoder/decoder round-trip.** `useUserHistory.ts` ships its own base58 codec (Solana convention) because Anchor's TS client doesn't expose one for raw account-data parsing. Off-by-one on leading-zero bytes already shipped once (fixed in commit `9df53cd fix(app): bs58decode dropped a byte boundary — caught by qa-adversary`). Property: `encode(decode(s)) == s` for every valid base58 string.
- **Tick / micros conversion off-by-one.** Order book prices are integer ticks in `[1, 99]` representing cents; USDC micros are 6-decimal. `ticksToUsdcMicros(t) == t × 10_000` must hold exactly. A `× 10_000n` typo'd as `× 1_000n` would silently misprice every order.
- **Mark-to-market math (`useUserPositions.ts`).** For balanced positions (N Yes + N No), value is exactly `N × $1` regardless of mid. For pure-Yes positions, value is monotone INCREASING in mid. For pure-No, monotone DECREASING. The harness already covers these; any new mark-to-market path needs a new property.
- **PDA seed collisions / wrong seeds.** Account derivations include `version` byte, ticker bytes, trading-day unix, and strike. Two markets on the same ticker same day at different strikes must derive different PDAs. Any change to seed layout requires a migration plan in the commit.
- **Oracle staleness / confidence bypass.** `settle_market` rejects Pyth updates older than `max_staleness_secs` (default 300) and confidence wider than `max_confidence_bps` (default 50 = 0.5%). Both thresholds are in the on-chain `Config` account, not in client code. Any settle path that reads `Clock` without comparing against the price's `publish_time`, or that reads `price` without reading `conf`, is a bug.
- **Atomic Buy/Sell No leg failure.** `buy_no` is mint-pair + IOC sell-Yes in one Anchor instruction. If the sell leg fails for any reason (insufficient liquidity, paused market, slippage), the mint leg must revert too. There must be no orphan Yes/No tokens after a failed `buy_no` tx. Same for `sell_no`.
- **Admin override time-delay bypass.** `admin_settle` must reject with `AdminOverrideTooEarly { now, earliest }` until `market.created_at + admin_override_delay_secs`. Any path that lets admin settle earlier is a bug.
- **Settlement immutability.** Once `settle_market` (or `admin_settle`) writes an `Outcome`, a second settle with a different price must revert with `MarketAlreadySettled`. Never overwrite.
- **Signer / authority checks.** Every instruction that mutates a user's token account must enforce that the user signed. Every admin-only instruction (`initialize_config`, `create_strike_market`, `pause`, `unpause`, `admin_settle`) must check `signer == Config.admin`. Use `#[account(signer)]` + explicit `has_one = admin` constraints, not runtime if-checks.
- **Token decimal mismatches.** USDC is 6 decimals (`1 USDC = 1_000_000` micros). Yes/No tokens are 0 decimals. Multiplying USDC by Yes/No without conversion, or treating either as the other, silently misprices.
- **`bigint` vs `number` coercion in TS hooks.** Any value crossing chain boundaries (lamports, micros, account data) must stay `bigint` until the moment it is rendered. `Number(microsBigInt)` loses precision above 2^53. Convert at the render boundary, not before.
- **Conservation in order book.** `sum(user_usdc) + vault_usdc` is constant across any matching sequence. `sum(user_yes_balances) + sum(yes_in_open_orders) == yes_mint_supply`. Same for No. These properties are not yet in the harness; extend it before/with any order-book change.
- **Position constraint asymmetry.** Per constitution section 2.11: the frontend blocks Buy Yes when the user holds No (and vice versa); the on-chain program does NOT. Any change to either layer must preserve this asymmetry and the documentation comments at both layers must stay in sync.
- **`.env.example` drift.** Any new env var read in `app/`, `automation/`, or `tests/` must appear in `.env.example`. The pre-commit hook should catch this but historically has missed.
- **No stub data in user-facing aggregates.** Per constitution section 2.3: prices, balances, P&L, settlement counts, history rows must come from real on-chain state or real oracle reads. No placeholder `0.001`, no fake row, no fallback "Demo" labels. Zero is acceptable only when zero is what was actually measured.

## Hot files / hot paths

Recent commit churn (`HEAD~15..HEAD`) plus the constitution's named non-negotiables put these at the top of the risk pyramid:

- `tests/qa-adversary.property.test.ts` — the harness itself. If you change a mirrored pure function, change the mirror here in the SAME commit (see the comment block at the top of the file). Forgetting this is the failure mode the harness exists to catch.
- `app/src/hooks/useUserHistory.ts` — base58 + Anchor discriminator + tick conversion. Already had one production bug (`bs58decode` leading-zero handling). Any change here MUST extend the harness with a new property.
- `app/src/hooks/useUserPositions.ts` — mark-to-market math. Asymmetry rules (balanced = $1, pure-Yes monotone-up, pure-No monotone-down). Already mirrored in harness; new positions math needs new mirrors.
- `app/src/hooks/useRedeem.ts` — redeem path on the frontend. $1.00 invariant lives here on the user side; pair the assertion with on-chain assertion in Anchor tests.
- `app/src/hooks/useOrderBookFor.ts` — order book reading + tick math. Conservation invariants not yet in the harness; add when this file changes.
- `app/src/app/portfolio/page.tsx`, `app/src/app/history/page.tsx`, `app/src/app/audit/page.tsx` — user-facing aggregates. Constitution section 2.3 (NO STUB DATA) applies hardest here.
- `programs/meridian/src/lib.rs` — top-level instruction registration. Any new instruction here MUST appear in the harness's `KNOWN_METHODS` list with its discriminator in `PRODUCTION_DISCRIMINATORS`. The permutation check enforces this.
- `programs/meridian/src/instructions/` — every on-chain instruction. Signer/admin checks, $1.00 invariant, oracle freshness, atomicity for `buy_no`/`sell_no`.
- `programs/meridian/src/state.rs` — account layouts. Seed changes are migrations. `LEN` constants must add up.
- `automation/src/jobs/settlement.ts` — production settle cron just had a "crashing every 30s" fix (`7ba76ac fix(automation)`). High churn = high risk.
- `automation/src/jobs/morning.ts` — daily strike creation; Pyth read + math for ±3/6/9% strikes rounded to $10.

## Conventions the agent must respect when writing failing tests

- All new property/permutation tests go in `tests/qa-adversary.property.test.ts`. Don't create a sibling file unless this one exceeds ~50 KB.
- Mirror small pure functions from `app/src/hooks/` into the test file. Rule (from the file's header comment): if production changes, the mirror in this file changes in the SAME commit.
- Use vitest's `describe` + `it`, fast-check's `fc.assert(fc.property(...))`. Match the existing structure: one `describe` block per source-of-truth file, one `it` per invariant.
- Use `bigint` for any USDC micros value. `USDC_ONE_DOLLAR_MICROS = 1_000_000n`.
- Anchor TS integration tests go in `tests/meridian.test.ts`, run via `anchor test` from the repo root.
- Conventional Commits with explicit attribution when a property catches a bug: `fix(<scope>): <description> — caught by qa-adversary`. This pattern is the searchable audit trail.
- Property test seeds: leave fast-check default (no manual `seed:` parameter) so shrinking still works. The "semi-deterministic" property comes from fast-check's deterministic seed-on-failure print, not from manual seeding.
- New Rust failure-path tests must assert the SPECIFIC named error variant fires (e.g., `OraclePriceStale`, `Unauthorized`, `MarketAlreadySettled`), not just "an error happened." Constitution section 3 Rust rules.

## Things to ignore

- Anything under `node_modules/`, `target/`, `.anchor/`, `app/.next/`, `dist/`, `*.tsbuildinfo`. Generated.
- `target/idl/` and `target/types/` — Anchor-generated; the hand-written equivalent in the harness is the authoritative mirror, not the generated types.
- `pnpm-lock.yaml`, `Cargo.lock` — lockfile churn is not a bug surface; the dependency justification lives in `plan.md`.
- `daily-todo-reports/` at the repo root if present (per global rule).
- `vulnerability-reports/` if present (that pattern belongs to the `~/code/adversary` project, not Meridian).

## How to run the QA pipeline end-to-end here

Fast path (matches what CI runs, but locally and in seconds):

```bash
cd /Users/scottlydon/Desktop/Clutter/iOS/meridian

# 1. Type + lint, all workspaces
pnpm -r typecheck
pnpm -r lint

# 2. Property / permutation harness (the qa-adversary suite)
cd tests && ./node_modules/.bin/vitest run qa-adversary.property.test.ts && cd ..

# 3. On-chain Anchor tests (boots a local validator)
anchor build
anchor test
```

When the qa-adversary sub-agent is delegated, it runs step 2 first (cheapest, fastest signal), extends `qa-adversary.property.test.ts` with new failing properties or scenarios derived from the diff, then runs step 3 only if the property pass surfaces a chain-level concern.

## Where to put the actual QA report

Written reports go at `tests/qa-adversary-reports/<UTC-date>-<topic>.md`. Create the folder if missing. Filename convention: `2026-05-21-mark-to-market-skew.md`, etc. The sub-agent prints the same report to chat AND saves the file when invoked with the report-to-disk flag.

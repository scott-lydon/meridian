# Meridian Constitution

The rules. The stack. The non-negotiables. This file is the highest authority in the repo. If `spec.md`, `plan.md`, `tasks.md`, `ARCHITECTURE.md`, the website, or any code disagrees with this file, this file wins. Updates require a separate commit with the reason in the message.

Cite back to the PRD ("Meridian — Binary Stock Outcome Markets on Blockchain") for every rule whose authority is the assignment. Cite back to user-level standards (CUPID, Google Swift Style, the project's BUG_PREVENTION.md) for everything else.

---

## 1. Stack constraints (inherited from PRD)

These come straight from "Technical Requirements" in the PRD and are non-negotiable.

| Layer | Choice | PRD line |
|---|---|---|
| Chain | Solana devnet (required for the submission to pass) | "If using Solana, deployment to Solana devnet is required to pass." |
| Smart contract language | Rust | "Rust (using the Anchor framework on Solana) is preferred." |
| Smart contract framework | Anchor 0.30+ | Same line as above |
| Frontend language | TypeScript | "Frontend: TypeScript and React (Next.js recommended)" |
| Frontend framework | Next.js 14+ App Router | Same |
| Automation language | TypeScript on Node.js 20+ | "Automation service: TypeScript / Node.js" |
| Stable | USDC (devnet mint), 6 decimals | "pays out $1 USDC" |
| Token standard | SPL Token (not Token-2022) | Chain default, justify in plan.md |
| Wallet adapter | @solana/wallet-adapter with Phantom + Solflare + Backpack | "non-custodial decentralized application" |

EVM L2 and HyperLiquid paths are explicitly out of scope for v1. The PRD permits them, but the rest of this constitution and the plan are written assuming Solana. Switching chains requires re-writing this file first.

## 2. Non-negotiables (the lines that cannot be crossed)

These are the rules whose violation invalidates the submission. The qa-adversary checks every one of them on every code change.

1. **The $1.00 invariant.** Yes payout + No payout = exactly 1.00 USDC for every contract at settlement. Always. Enforced on-chain (see PRD "Invariants" section). The redeem instruction MUST NOT pay out more than the vault holds for that market, and the vault balance for a market MUST equal `1.00 × total_pairs_outstanding` at every point in its lifecycle.
2. **No mainnet for the core submission.** PRD: "Never use mainnet or real funds for the core submission." Mainnet deployment is a bonus, gated on a separate review.
3. **No stub data in user-facing aggregates.** Prices, balances, P&L, settlement counts, and any number a real user reads MUST come from real on-chain state or real oracle reads. Zero is acceptable only when zero is what was actually measured. Placeholder values like 0.001 are forbidden anywhere a human will see them.
4. **No catch-log-continue.** Any operation that fails throws an error specific enough to identify the issue and suggest a fix. Errors propagate. Callers decide whether to recover. The frontend renders the error message verbatim in a debug surface (toast or inspector panel) AND a sanitized version in the user-facing UI.
5. **No suppression of nullable warnings.** TypeScript `strict: true`, no `as any`, no `// @ts-ignore`, no `// @ts-expect-error` without a comment naming the upstream bug. Rust: `#![warn(clippy::pedantic, clippy::nursery)]`, no `.unwrap()` outside `tests/` and `examples/`, no `.expect("...")` outside the same.
6. **qa-adversary gate.** After any code change in this repo (anything except docs, the `daily-todo-reports/` folder, or the flashcard TSV), the qa-adversary sub-agent runs in a fresh context BEFORE the task is marked done. Skip rule is the user saying "hold off on QA" or equivalent.
7. **Dual push (GitHub + GitLab) on every commit.** `origin` carries two push URLs (the dual-push trick). One `git push origin <branch>` fans out to both. Verify after every push with `git ls-remote origin main` and `git ls-remote gitlab main` reporting the same hash.
8. **`.env` never committed.** Secrets via environment variables only. `.env.example` is the contract; every key documented there. Pre-commit hook blocks any `.env*` file that is not `.env.example` or `.env.test`.
9. **Settlement outcome is immutable.** Once `settle_market` (or `admin_settle`) writes an outcome, no instruction can overwrite it. The on-chain account is the source of truth indefinitely.
10. **Atomic Buy No.** The user signs ONE transaction. Mint-pair and sell-Yes are bundled in a single Anchor instruction so the transaction either completes both or reverts both. Two-signature flows are forbidden for this path.
11. **Position constraint is a UX rule, not a program invariant.** The frontend blocks Buy Yes when the user holds No (and vice versa). The on-chain program does NOT block this, because a market maker mid-mint legitimately holds both. This asymmetry is documented in code comments at both layers.
12. **Admin override has an enforced time delay.** `admin_settle` cannot fire until at least 1 hour after market close (17:00 ET). Enforced on-chain by comparing `Clock::get()?.unix_timestamp` against the market's `earliest_admin_settle_ts`.
13. **Oracle staleness and confidence checks on every settlement read.** Settle rejects prices older than 5 minutes (configurable in Config). Settle rejects prices whose confidence interval exceeds 0.5% of the price (configurable). Both thresholds live in the on-chain `Config` account, not in client code.
14. **No third-party abstractions without justification.** Every dependency added to `Cargo.toml` or `package.json` is justified in `plan.md`'s decisions table with the alternative considered. PRD: "Avoid unnecessary third-party abstractions; justify all major dependencies."

## 3. Code style

Language-specific style guides apply. The rule of thumb is the equivalent-of-Google-Swift-Style-Guide for each language.

### Rust (Anchor program)

- Edition 2021.
- `#![warn(clippy::pedantic, clippy::nursery, clippy::cargo)]` at the crate root. Warnings are errors in CI.
- No `unwrap`, `expect`, or `panic!` in the `programs/meridian/src/` tree. Use `?` with typed errors via `#[error_code]`.
- Errors are an enum with one variant per failure mode. Each variant carries enough data to diagnose the issue from the on-chain log alone (e.g., `OraclePriceStale { age_secs: u64, max_age_secs: u64 }`). Vague errors are bugs.
- Account structs: `#[account]` macros with explicit `space` constants. No `INIT_SPACE` magic numbers; every account has a `LEN` const that adds up its fields with a comment showing the arithmetic.
- PDAs: deterministic seeds documented in a `// seeds:` comment on each derivation. Seeds always include the program version byte so future migrations are clean.
- Cross-program invocations (CPI): each CPI helper is wrapped in a function whose docstring lists every account it touches and what could go wrong.
- Tests: every public instruction has a happy-path test AND at least one failure-path test that confirms the specific named error variant fires. Invariant tests use `proptest` with at least 100 samples.

### TypeScript (frontend and automation)

- `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `exactOptionalPropertyTypes: true` in every `tsconfig.json`.
- ESLint config: `@typescript-eslint/strict-type-checked` + `@typescript-eslint/stylistic-type-checked` + `react-hooks/recommended` + `@next/eslint-plugin-next`.
- No `any`. No `as` casts except at parse boundaries, and those go through a typed parser (zod or similar) that throws on invalid input.
- Every component, hook, and utility function is in its own file. Default exports are forbidden; named exports only. This makes refactors and ImportFixer behavior predictable.
- React: function components only, no class components. Hooks rules enforced. Custom hooks live in `src/hooks/` and have unit tests.
- State: TanStack Query for server / chain state, Zustand for purely-local UI state. Redux is forbidden in v1. Zustand selectors must NOT allocate new objects or arrays (lessons from boxy-fractions React error #185); use shallow equality or the slice pattern.
- Date and time: `date-fns-tz` for ET conversions. No `new Date()` in business logic; inject a clock for testability (PRD calls out timing precision for settlement).

### Domain language (CUPID)

- **Composable:** every module exports a typed interface that another module can mock. No singletons except the WalletAdapter context (which is itself a React boundary).
- **Unix philosophy:** the Anchor program does minting, settling, redeeming. The CLOB module does matching. The oracle adapter reads prices. Each does one thing.
- **Predictable:** instruction names are imperative present-tense verbs (`mint_pair`, `settle_market`, `redeem`). Account names are nouns (`Market`, `Vault`, `Outcome`). No `Manager`, no `Service`, no `Helper` in module names; pick the actual domain noun.
- **Idiomatic:** Anchor patterns over hand-rolled CPI. Solana cookbook patterns over reinventing. React Query patterns over manual `useEffect`.
- **Domain-based:** code models the PRD's vocabulary. The word `strike` appears in the program, in the frontend, in the automation. The word `contract` (PRD term) is the on-chain term we use, not `position` or `market` colloquially.

### Type augmentation (Swift principle adapted to Rust and TS)

Per the user's preference, prefer adding functions to types over creating utility classes.

- **Rust:** prefer `impl` blocks and extension traits over free functions. `Price::round_to_strike(self, interval: u64) -> Price` rather than `pub fn round_to_strike(p: Price, interval: u64) -> Price`. Use the newtype pattern for `Price`, `StrikePrice`, `UsdcAmount` so the compiler distinguishes them.
- **TypeScript:** branded types (`type Price = number & { __brand: 'Price' }`) at module boundaries; methods on the wrapper class for behavior. Avoid utility-class collections like `PriceUtils`.

## 4. Quality gates

These run in CI on every PR and block merge on failure.

| Gate | Tool | Target |
|---|---|---|
| Rust format | `cargo fmt --check` | clean |
| Rust lint | `cargo clippy --all-targets -- -D warnings` | zero warnings |
| Rust tests | `anchor test` | green |
| Rust property tests | `cargo test --release --test invariants` | 1000 samples |
| TS format | `prettier --check` | clean |
| TS lint | `eslint . --max-warnings 0` | zero warnings |
| TS type-check | `tsc --noEmit` | green |
| TS unit tests | `vitest run` | green |
| Frontend e2e | `playwright test --fail-on-console-error` | green |
| Automation unit tests | `vitest run` in `automation/` | green |
| Conventional commits | `commitlint` on the PR commit list | green |
| Coverage floor | 80% line, 70% branch, on both Rust and TS new code | green |
| Bundle size budget | 300 KB gzipped for the marketing landing route | green |

PR cannot merge with any gate failing. Baselines are forbidden; if a check fails, fix the root cause or document the exemption in `constitution.md` with a deletion date.

## 5. Things the agent must NEVER do

(Each of these has burned a real submission in this user's history. The list grows over time; never shrinks.)

- Never write a unit test that mocks the on-chain program. Use `solana-test-validator` or `BanksClient`; in-memory mocks pass on green and fail in production. This is the same lesson as the database-mock rule (see [memory](file:///Users/scottlydon/Library/Application%20Support/Claude/local-agent-mode-sessions/8b316d93-50d9-45b2-ad34-c54377e89da7/7ab1e9f0-d53d-46d8-8ccc-680a671776b3/spaces/45b13e8d-eb26-4aa6-b04b-c7b137cd1c7c/memory/MEMORY.md)).
- Never allocate inside a Zustand selector. Causes React error #185 infinite loop in production (lesson from boxy-fractions commit 458fb75).
- Never hard-code admin keypair, RPC URL, or oracle feed IDs. Read from `Config` account on-chain or from `.env`.
- Never write to mainnet during the v1 cycle.
- Never check in a `.env*` file other than `.env.example` or `.env.test`.
- Never claim a save succeeded without the one-line `ls -la | grep <file>` size check (per the user's WRITE VERIFICATION rule).
- Never run `git stash --include-untracked` on a server that has bootstrap files (lesson from Hetzner OpenEMR).
- Never commit reasoning, scratchpads, or daily-to-do-reports from the Gauntlet folder; only commit the openemr project (and now meridian).
- Never propose Monday/Tuesday/Wednesday plans or "by Friday" timelines. The user has said scheduling is outside the agent's wheelhouse. Tasks are units of work, not calendar slots.

## 6. Testing requirements (raised above PRD baseline)

The PRD lists tests; this constitution raises the floor.

- **Property tests for the $1.00 invariant.** Not a hand-coded set of cases. `proptest` (Rust) or `fast-check` (TS) with at least 1000 random close prices per run. Asserting `yes_payout + no_payout == 1_000_000` (in USDC base units) for every sample.
- **At-strike test is named explicitly.** Test function name MUST contain `at_strike_yes_wins`. PRD has a specific at-or-above rule that is a notorious off-by-one source.
- **Timing tests use an injected clock.** `solana_program::clock::Clock` is mockable in `solana-program-test`. No real waits.
- **Integration tests exercise the full lifecycle on `solana-test-validator`.** Create → mint → trade → settle → redeem in one test that runs in under 60 seconds.
- **Manual test plan** at `meridian-manual-tests.md` (already drafted, will move into repo) is the acceptance gate for the testnet deployment. Every phase in that plan maps to at least one automated test in this repo.

## 7. Bug/issue prevention checklist (project-local manifestation)

Universal rules live at `~/Documents/Claude/Projects/BUG_PREVENTION.md`. Project-local manifestations:

- [ ] Zustand selectors never allocate new arrays or objects (boxy lesson).
- [ ] React Query keys are stable across renders (factor into a `queryKeys` const).
- [ ] Every error path on the frontend renders the underlying error message in a debug surface AND a user-safe message in the visible UI.
- [ ] `anchor build` is reproducible (verifiable build with `solana-verify`); CI compares the on-chain binary hash to the local build.
- [ ] All PDAs include the program version byte in their seeds.
- [ ] All time-sensitive instructions read time from `Clock::get()` and validate against a Config-stored bound (never against client-supplied timestamps).
- [ ] Every `transfer_checked` (SPL token) call uses the explicit decimals value, never an inferred one.
- [ ] Wallet popups: exactly one signature for Buy Yes, one for Buy No (atomic), one for Sell Yes, one for Sell No, one for Mint Pair, one for Redeem. Never two-signature flows.

## 8. Documentation requirements

- `ARCHITECTURE.md` reflects the live system at all times. Updates land in the same commit as the code change.
- The architecture website at `website/index.html` updates in the same commit as `ARCHITECTURE.md` (per project rules).
- `docs/DEFENSE_BREAKOUT_SCRIPT.md` for the 5-minute Architecture Defense.
- `docs/AI_INTERVIEW_PREP.md` with at least 12 prepared answers, sorted by likelihood (per user's [memory rules](file:///Users/scottlydon/Library/Application%20Support/Claude/local-agent-mode-sessions/8b316d93-50d9-45b2-ad34-c54377e89da7/7ab1e9f0-d53d-46d8-8ccc-680a671776b3/spaces/45b13e8d-eb26-4aa6-b04b-c7b137cd1c7c/memory/feedback_ai_interview_prep.md)).
- Every function whose absence could create a WTF moment carries a docstring naming what it does, what it returns, what it can fail on.

## 9. Risks and limitations

(Per PRD: "Include a short risks/limitations note (no regulatory or compliance claims).")

- This is a testnet demonstration. No real funds. No KYC. No custody. Not financial advice and not a regulated instrument; the PRD explicitly forbids regulatory or compliance claims and so does this constitution.
- Oracle dependence: a sustained oracle outage degrades the system to admin-override mode for settlement. Documented as a known limitation.
- Single-day expiry: contracts expire on the day they are created. No rollover, no multi-day positions.
- Stock market hours only: weekends and US holidays produce no markets. The automation service checks the NYSE calendar before running.
- Devnet liquidity: live trading depth on devnet is whatever the test wallets provide. Real liquidity behavior is out of scope for v1.

## 10. Amendment process

This file changes when the PRD changes, when a non-negotiable is violated and the violation reveals a missing rule, or when a quality gate is added or relaxed. Every amendment commit names the rule changed, the reason, and the prior version. Search history for the original text of any rule before assuming the current version has always been the rule.

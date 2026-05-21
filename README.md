# Meridian

Binary stock outcome markets on Solana devnet. Trade tokens that pay `$1.00 USDC` if a MAG7 stock closes at or above a strike price today, and `$0.00` otherwise. Non-custodial. On-chain order book. Pyth oracle settlement at 16:00 ET. No KYC, no margin, no custody.

> **Status: slice 0 (bootstrap).** The four foundational artifacts and the workspace skeleton are in. Real instructions land in slice 1.

## Spec-driven artifacts

The single source of truth. Downstream docs reference these; if anything diverges, these win.

- [`constitution.md`](./constitution.md) — rules, stack constraints, non-negotiables
- [`spec.md`](./spec.md) — user stories with Given/When/Then acceptance
- [`plan.md`](./plan.md) — architectural plan (topology, decisions, trade-offs)
- [`tasks.md`](./tasks.md) — sliced backlog

## What is a Meridian contract?

A pair of complementary tokens, Yes and No, on a single stock's daily closing price relative to a fixed strike.

- **Yes pays $1.00** if the stock closes at or above the strike at 16:00 ET.
- **No pays $1.00** if it closes below.
- **Invariant:** `Yes payout + No payout = $1.00 USDC`, always, for every contract.

Both tokens trade on one in-program order book per strike. Buy Yes and Sell No are the same side of the book; Buy No and Sell Yes are the other side. One book, four user actions, two perspectives.

## Daily lifecycle

| Time (ET) | Event |
|---|---|
| 08:00 | Automation reads previous close from Pyth, computes strikes at ±3/6/9% rounded to $10, deduplicates |
| 08:30 | `create_strike_market` per unique strike per ticker |
| 09:00 | Markets visible on frontend, minting enabled |
| 09:30 | US market open, live trading on the in-program CLOB |
| 16:00 | US market close |
| 16:05 | Automation reads close from Pyth, calls `settle_market`. Retries every 30s for 15 min on oracle failure |
| 16:05+ | Redemption open. Winners claim USDC; unredeemed tokens remain claimable indefinitely |

## One-command setup

```bash
make install   # pnpm install + cargo fetch
make dev       # local validator + frontend + automation, concurrent
```

`make help` lists every target.

## Repo layout

```
meridian/
├── constitution.md / spec.md / plan.md / tasks.md   four foundational artifacts
├── programs/meridian/                                Anchor program (Rust)
├── app/                                              Next.js frontend (TypeScript)
├── automation/                                       Node.js automation service
├── tests/                                            Anchor TS integration tests
├── migrations/                                       Anchor deploy script
├── scripts/                                          dev/deploy helpers
├── .github/workflows/                                CI
├── Anchor.toml / Cargo.toml / package.json           workspace orchestrators
└── .env.example                                      every key you need
```

## Tech stack

- **Smart contract:** Rust + [Anchor 0.30+](https://www.anchor-lang.com/)
- **Frontend:** [Next.js 14 App Router](https://nextjs.org/) + [TanStack Query](https://tanstack.com/query) + [Zustand](https://github.com/pmndrs/zustand) + [@solana/wallet-adapter](https://github.com/anza-xyz/wallet-adapter)
- **Automation:** Node 20 + [croner](https://github.com/Hexagon/croner) + [pino](https://github.com/pinojs/pino)
- **Oracle:** [Pyth Network](https://pyth.network/) pull model via the Solana receiver SDK
- **Order book:** Minimal in-program CLOB (slab-based, price-time priority)

Justification for every dependency lives in [`plan.md`](./plan.md) §4 decisions table.

## Quality gates (CI enforces all)

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `anchor build` + `anchor test`
- `pnpm -r lint` (eslint, zero warnings)
- `pnpm -r typecheck` (TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`)
- `pnpm -r test` (vitest)
- Conventional Commits

## Dual remote

This repo follows the Gauntlet dual-push pattern. One `git push origin main` fans out to both:

- GitHub: <https://github.com/scott-lydon/meridian>
- GitLab: <https://labs.gauntletai.com/scottlydon/meridian>

## Risks and limitations

- Devnet only. PRD: "Never use mainnet or real funds for the core submission." Mainnet is a documented bonus path, separate review.
- Oracle-dependent. A sustained Pyth outage forces admin override; documented in plan.md §5.2.
- Same-day expiry. No multi-day positions.
- The position constraint (no holding both Yes and No from trading) is a UX rule enforced by the frontend, not a program invariant. See plan.md §5.4 for the reason.

No regulatory or compliance claims. Not financial advice.

## License

[MIT](./LICENSE).

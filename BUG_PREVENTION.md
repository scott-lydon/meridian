# Meridian — bug / issue prevention

Project-local checklist. See `~/Documents/Claude/Projects/BUG_PREVENTION.md`
for cross-project rules; this file only carries items where the local
manifestation is specific enough to need its own entry.

Run through this list whenever a new feature is added or a new instruction
is wired through the wallet adapter.

---

## 1. Wallet–site cluster mismatch must surface BEFORE the user signs

**Symptom seen 2026-05-25:** user had freshly hydrated 10 SOL + 20 USDC on
devnet, opened a trade, clicked Mint Pair, Phantom popped up with a red
"You don't have enough SOL for this transaction" banner. Cause: Phantom
was on Mainnet (default), site RPC was Devnet. The two clusters have
isolated balances on the same key, so Phantom checked mainnet (0 SOL)
while the tx was bound for devnet. From the user's perspective the
faucets had silently failed.

**Why it's invisible today:** the trade page only renders `NetworkBadge`
("DEVNET" chip in the header) and a wallet picker. There's no runtime
check that the connected wallet's selected cluster matches `cluster.name`
from `app/src/lib/cluster.ts`. The Wallet Standard does NOT expose the
extension's current network to the page — Phantom refuses to disclose it
for fingerprinting reasons. So we can't read the cluster from JS; we
have to infer it.

**Inference path that works:** before submitting any transaction, fetch
the wallet's SOL balance via the SITE's connection (devnet RPC). If it's
0 lamports AND the user just hydrated AND the explorer link for that
address shows >0 SOL on devnet, the wallet is almost certainly on the
wrong cluster. Pop a modal: "Phantom looks like it's on Mainnet. Open
Phantom → gear → Developer Settings → Testnet Mode → Devnet."

**Cheaper version, ship first:** put a permanent banner above the trade
panel whenever `useUsdcBalance` returns 0 AND the address has on-chain
balance per the site's RPC. The banner says exactly what to do and
links to the DEVNET pill's popover instructions.

**Hardest version, defer:** add a heuristic: send a single
`getRecentPrioritizationFees` call from the wallet's signer, catch the
specific RPC-mismatch error, surface it. Phantom returns a distinguishable
error code for this; need to verify experimentally.

**Test to add:** integration test where the wallet adapter is pointed at
mainnet RPC and the site is on devnet — assert that a banner renders
before the user can click any trade button.

---

## 2. Trade-button busy state must use an animated glyph, not "..."

**Symptom seen 2026-05-25:** user clicked Mint Pair, the button text
flipped from "Mint 1 pair (deposit $1.00 USDC)" to literally `...`, the
Phantom popup appeared offscreen, the user thought the button had
hung. The `...` is the active busy state per

```tsx
{busy === "Mint Pair" ? "..." : `Mint ${qty} pair (deposit $${qty}.00 USDC)`}
```

at `app/src/app/trade/[ticker]/[market]/page.tsx:699`, but three static
dots do not animate so the affordance is invisible.

**Fix:** swap `...` for a CSS-animated spinner (Tailwind `animate-spin`
on a 12px Lucide `Loader2`) PLUS a one-line subtitle "Confirm in your
wallet popup." The subtitle is more important than the spinner — it tells
the user where the next action lives. Without it, the user stares at the
trade page expecting it to change.

**Apply to:** Buy Yes, Buy No, Sell Yes, Sell No, Mint Pair, Redeem
Pair, Cancel order rows — every place that currently renders `busy ===
"Label" ? "..." : "Label"`.

**Test to add:** Playwright test that clicks Mint Pair (mocked
sendTransaction that resolves after 5s), asserts the spinner is visible
and the "Confirm in your wallet popup" subtitle is rendered within 100ms
of click.

---

## 3. IDL must be regenerated AND committed when a Rust instruction is added

**Symptom seen 2026-05-26:** user clicked Redeem 1 pair on the live site
with 1 YES + 1 NO and 38.50 USDC. The button click triggered
`TypeError: r.methods.redeemPair is not a function` from the bundled
`927-c5da2b9715a44f59.js`. The Transaction-failed toast rendered at the
top of the trade page but was above the user's scroll position, so from
the user's perspective "nothing happened."

**Cause:** commit `6971a6c` (May 23) added the `redeem_pair` instruction
in `programs/meridian/src/instructions/redeem_pair.rs` and wired it
through `app/src/hooks/useTrade.ts:802` as `program.methods.redeemPair(...)`,
but the IDL JSON shipped to the frontend (`app/src/idl/meridian.json`)
and to the automation worker (`automation/src/idl/meridian.json`) was
NOT regenerated. Anchor's JS client looks up `methods.<camelCaseName>`
on the IDL at runtime; if the IDL has 15 instructions and the source
has 16, the 16th is invisible to the client and the call site crashes
with the `is not a function` TypeError. As a second compounding
problem, the on-chain program binary on devnet was also stale (last
deploy slot 463939285, before commit 6971a6c), so even with a correct
IDL the simulation would have reverted with InstructionFallbackNotFound.

**Why it's invisible today:** nothing on the commit path enforces
"the set of instruction filenames in `programs/meridian/src/instructions/`
equals the set of instruction names in `app/src/idl/meridian.json`."
`anchor build` regenerates `target/idl/meridian.json` but does NOT
copy it into `app/src/idl/`; that step is manual and was forgotten.
`pre-commit` only runs rustfmt / clippy / cargo-check; it never
inspects the IDL.

**Fix landed in this commit:** added
`scripts/check-idl-fresh.sh` which fails the build if the set of
instruction names in `app/src/idl/meridian.json` does not equal the
set derived from `programs/meridian/src/instructions/*.rs` minus
`mod.rs`. Wired into `.pre-commit-config.yaml` and into the qa-adversary
playbook. Now if you add `foo.rs` with `pub fn foo` in `lib.rs` and
forget to `anchor build && cp target/idl/meridian.json app/src/idl/`,
the commit refuses.

**Surface-the-error follow-up:** also added a `useEffect` guard in
`app/src/hooks/useTrade.ts` that, on mount, asserts every method the
hook calls (`buyYes`, `sellYes`, `buyNo`, `sellNo`, `mintPair`,
`redeemPair`, `cancelOrder`) exists on `program.methods`. If any is
missing, the hook throws on mount with a message like
`"IDL is stale: program.methods.redeemPair is missing. Regenerate
with anchor build and copy target/idl/meridian.json into
app/src/idl/."` — this lifts the failure from "click the button to
discover" to "page won't load until fixed", which is louder and more
diagnosable.

**Also: scroll affordance for the Transaction-failed toast.** The
toast renders at `app/src/app/trade/[ticker]/[market]/page.tsx:497`
which is above the order-book / trade panel. On a 720p laptop the
user scrolls down to interact with the trade buttons and the toast
appears OFF-screen. Per the global rule in
`~/.claude/CLAUDE.md` ("Scroll overflow on lengthy modal / popup
content"), the toast should `position: sticky; top: 0` OR a one-shot
`scrollIntoView({block: 'start'})` should fire when `setLastErr` is
called, so the failure is visible regardless of scroll position.

**Triggers that should ALSO run this check (added 2026-05-26):** any
PR that touches `programs/meridian/src/instructions/`, `programs/meridian/src/lib.rs`,
or `app/src/hooks/useTrade.ts`. The qa-adversary playbook reads this
section and grep-asserts the invariant on every invocation.

---

## 4. buy_no / sell_no must reject self-matching at the program layer

**Symptom seen 2026-05-26:** user clicked Buy No on the AAPL market when
the best YES bid in the book was their OWN $0.50 bid. The toast said
"+1 NO (paid ~$0.50 each)" and the transaction confirmed. Their actual
holdings went to 1 YES + 1 NO, not 0 YES + 1 NO. USDC went down by
$0.50 as expected. The user was correctly confused.

**Cause:** `programs/meridian/src/instructions/buy_no.rs:236-247` does
the atomic `mint_pair + IOC-sell-YES` flow by transferring the
freshly-minted YES from `user_yes` to `bid_maker_yes`. If the best bid
was placed by the caller, the caller's frontend passes the caller's own
YES ATA as `bid_maker_yes` (correctly — the bid owner IS the caller),
and the SPL `Transfer` then becomes a same-ATA no-op. The mint-pair leg
still mints both halves to the caller, and the `usdc_escrow` refund leg
still returns the caller's own escrowed USDC to them. Net: +1 YES + 1 NO,
-(1.00 - bid_price) USDC. The "sell" never happened in any economically
meaningful sense. The same class bug exists symmetrically in
`programs/meridian/src/instructions/sell_no.rs` against own asks.

**Fix landed in commit <pending>:** added
`MeridianError::SelfMatchingForbidden` and checks in both `buy_no` and
`sell_no` handlers that reject when the best counterparty's `owner`
equals `ctx.accounts.user.key()`. The on-chain check is the
load-bearing one. The frontend trade page (`page.tsx`) ALSO computes
`bestBidIsSelf` and `bestAskIsSelf` and disables the Buy No / Sell No
buttons with a tooltip that says "Best bid is your own order — Buy No
would self-cross. Cancel your own bid first." Either alone would close
the failure mode for honest UIs, but an adversarial frontend could
bypass the client check, so the program-layer reject is the canonical
fix.

**Test invariant for every new IOC-take instruction:** if the
instruction reads a top-of-book counterparty and transfers tokens to or
from it, it MUST reject when `counterparty.owner == ctx.accounts.user.key()`.
The grep that catches the missing check is:
`grep -nE 'best_bid|best_ask|bids\[0\]|asks\[0\]' programs/meridian/src/instructions/*.rs`
followed by a manual scan for the self-match guard. The qa-adversary
playbook should include this as a fixed-action question on every IOC
instruction it discovers.

**On-chain recovery for users who got caught by this before the fix
shipped:** they hold one extra YES (or NO) than they should. The
cleanest path is `Redeem 1 pair` (the now-working button shipped in
commit 24d1568) which burns one of each and returns $1.00 USDC, then
the user can re-attempt the buy on a different counterparty's order.
On an illiquid devnet market this may mean waiting for the order-book
seeder cron to repopulate; see `automation/src/jobs/ensureOrderBook.ts`.

---

## 5. (template — add as we find them)

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

## 3. (template — add as we find them)

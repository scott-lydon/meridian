"use client";

import Link from "next/link";

import { useMarkets } from "@/hooks/useMarkets";
import {
  hasAnyPresence,
  presenceFor,
  useMarketsUserPresence,
  type UserPresence,
} from "@/hooks/useMarketsUserPresence";
import { formatUsdc } from "@/lib/usdc";
import {
  isTradeable,
  marketUiState,
  marketUiStateLabel,
  marketUiStatePillClasses,
  sessionPhase,
  sessionPhaseBannerCopy,
} from "@/lib/marketSession";
import { useAfterHoursMode } from "@/lib/afterHoursMode";

// Force runtime rendering — the page depends on the wallet adapter and
// Anchor client, which pull Node-only modules at module-init time.
// Next's build-time prerender path can't load them.
export const dynamic = "force-dynamic";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

export default function MarketsPage() {
  const { data, isLoading, error } = useMarkets();
  // Per-market YES/NO/open-order presence for the connected wallet. One
  // hook serves the whole grid; each card looks up its own market by
  // pubkey. Returns an empty map when wallet disconnected, so the badge
  // path below renders nothing without extra guards.
  // See useMarketsUserPresence.ts for the 2-RPC batching strategy that
  // makes this affordable on the public devnet rate limit.
  const presence = useMarketsUserPresence();
  // After-hours toggle (header) bypasses the wall-clock UI gates so the
  // user can test mint/buy/sell against past-expiry markets. The on-chain
  // program already permits these transactions; only the product's
  // wall-clock rules are relaxed. AfterHoursBanner shows a persistent
  // amber strip while the bypass is active so it cannot be forgotten.
  const [afterHoursMode] = useAfterHoursMode();
  const phase = sessionPhase();
  const banner = afterHoursMode ? null : sessionPhaseBannerCopy(phase);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">Markets</h1>
      <p className="mb-6 text-muted">
        Today's binary outcome contracts. Each strike resolves on the underlying stock's 16:00 ET
        closing price (Pyth on-chain feed).
      </p>

      {banner && (
        <div
          className={
            banner.tone === "warn"
              ? "mb-6 rounded-2xl border border-accent/40 bg-accent/10 p-4"
              : "mb-6 rounded-2xl border border-panel bg-panel/40 p-4"
          }
          role="status"
        >
          <p className="mb-1 text-sm font-semibold">{banner.title}</p>
          <p className="text-xs text-muted">{banner.body}</p>
        </div>
      )}

      {isLoading && <p className="text-muted">Loading on-chain markets...</p>}
      {error && (
        <p className="rounded border border-no bg-no/10 p-4 text-no">
          Error reading markets: {(error as Error).message}
        </p>
      )}

      {/* If presence fetch errored, surface it inline (small, muted) — the
          badges silently no-op otherwise and the user has no way to know
          the indicator is broken vs they just have no position. */}
      {presence.isError && (
        <p className="mb-3 rounded border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs text-yellow-200">
          Could not load your per-market positions: {(presence.error as Error)?.message ?? "unknown error"}.
          The strike list below is still accurate; only the &quot;you have positions here&quot; badges are
          hidden until this refreshes.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MAG7.map((ticker) => {
          const tickerMarkets = (data ?? []).filter((m) => m.ticker === ticker);
          // Distinguish "still loading the initial on-chain fetch" from
          // "loaded successfully and this ticker truly has zero markets
          // today". Before this fix, both states rendered the same "No
          // markets yet today." copy per card, which the Vouch depth-2 run
          // on 2026-05-22 correctly flagged: a screenshot snapped during
          // the 2-5s initial-RPC window read seven misleading empty cards
          // even though devnet had 45 markets. Per-card skeleton during
          // isLoading also preserves the page layout so the user does not
          // see a layout shift the moment data lands.
          const isInitialFetch = isLoading || data === undefined;
          return (
            <div key={ticker} className="rounded-2xl border border-panel bg-panel/40 p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-xl font-semibold">{ticker}</h2>
                <span className="text-xs uppercase tracking-wider text-muted">
                  {isInitialFetch
                    ? "loading"
                    : `${tickerMarkets.length} strike${tickerMarkets.length === 1 ? "" : "s"}`}
                </span>
              </div>
              {isInitialFetch ? (
                <p className="text-sm text-muted">Loading on-chain strikes...</p>
              ) : tickerMarkets.length === 0 ? (
                <p className="text-sm text-muted">No markets yet today.</p>
              ) : (
                <ul className="space-y-2">
                  {tickerMarkets
                    .sort((a, b) => Number(a.strikeUsd - b.strikeUsd))
                    .map((m) => {
                      const state = marketUiState(m);
                      // When after-hours mode is ON, every non-settled
                      // market is clickable+tradeable. The settled states
                      // (won-yes / won-no) stay non-tradeable regardless
                      // because the program ITSELF blocks trades on
                      // settled markets (MarketAlreadySettled error) —
                      // the toggle cannot bypass that, nor would we want
                      // it to.
                      const isOpenOnChain = state !== "won-yes" && state !== "won-no";
                      const clickable = afterHoursMode
                        ? isOpenOnChain
                        : isTradeable(state);
                      // Per-market presence lookup. Returns the
                      // empty-zeros sentinel when the wallet is
                      // disconnected or the user has nothing on this
                      // market, so `hasAnyPresence` is the single gate
                      // that decides whether to render the badge.
                      const myPresence = presenceFor(presence.data, m.pubkey);
                      const showBadge = hasAnyPresence(myPresence);
                      // Non-tradeable rows still link to the trade page so a
                      // user can read the settled outcome, but the visual
                      // affordance dims and the pill colour signals why the
                      // bid panel will be inactive.
                      return (
                        <li key={m.pubkey}>
                          <Link
                            href={`/trade/${m.ticker}/${m.pubkey}`}
                            className={
                              clickable
                                ? "flex items-center justify-between rounded-lg px-3 py-2 font-mono text-sm hover:bg-bg/50"
                                : "flex items-center justify-between rounded-lg px-3 py-2 font-mono text-sm text-muted hover:bg-bg/30"
                            }
                            title={
                              clickable
                                ? undefined
                                : state === "awaiting-settle"
                                  ? "Past 16:00 ET expiry. Cannot place new bets; settlement is pending."
                                  : "Settled. View final outcome and (if you hold) redeem from /portfolio."
                            }
                          >
                            <span>&gt; {formatUsdc(m.strikeUsd)}</span>
                            <span className="flex items-center gap-2">
                              {showBadge && <UserPresenceBadge presence={myPresence} />}
                              <span className={marketUiStatePillClasses(state)}>
                                {marketUiStateLabel(state)}
                              </span>
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}

/**
 * Small per-strike badge: "you have YES / NO / open orders on this market."
 *
 * Rendered inside the strike row, BEFORE the existing state pill (awaiting
 * settle / yes won / no won / open). Keeps the row visually balanced —
 * the badge is left-of-pill instead of replacing it. The badge stays
 * compact: one chip per non-zero dimension (YES tokens, NO tokens, open
 * bids, open asks), separated by hairline `·` dots. Numbers larger than
 * 999 are clamped to `999+` so the badge never wraps and breaks the row.
 *
 * Why not a single "you" dot: the user needs to know WHAT they have on
 * this market without clicking through. The most common signal on a
 * binary-outcome market is "I have N YES" or "I have N NO"; collapsing
 * those into a single anonymous dot would force a navigate-to-trade-page
 * to find out which side. That defeats the point of the indicator.
 *
 * Accessibility: each chip has a `title` so a screen reader (or a
 * mouse-hover) reads the full sentence. The aria-label on the wrapper
 * narrates the same thing at the badge level.
 */
function UserPresenceBadge({ presence }: { presence: UserPresence }) {
  function clamp(n: number | bigint): string {
    const v = typeof n === "bigint" ? Number(n) : n;
    return v > 999 ? "999+" : v.toString();
  }
  const parts: { key: string; label: string; cls: string; title: string }[] = [];
  if (presence.yes > 0n) {
    parts.push({
      key: "yes",
      label: `YES ${clamp(presence.yes)}`,
      cls: "text-yes",
      title: `You hold ${presence.yes.toString()} YES tokens on this market.`,
    });
  }
  if (presence.no > 0n) {
    parts.push({
      key: "no",
      label: `NO ${clamp(presence.no)}`,
      cls: "text-no",
      title: `You hold ${presence.no.toString()} NO tokens on this market.`,
    });
  }
  if (presence.openBids > 0) {
    parts.push({
      key: "bids",
      label: `${clamp(presence.openBids)} bid${presence.openBids === 1 ? "" : "s"}`,
      cls: "text-accent",
      title: `You have ${presence.openBids} resting bid${presence.openBids === 1 ? "" : "s"} on this market's YES book. Cancel from the trade page to reclaim your escrowed USDC.`,
    });
  }
  if (presence.openAsks > 0) {
    parts.push({
      key: "asks",
      label: `${clamp(presence.openAsks)} ask${presence.openAsks === 1 ? "" : "s"}`,
      cls: "text-accent",
      title: `You have ${presence.openAsks} resting ask${presence.openAsks === 1 ? "" : "s"} on this market's YES book. Cancel from the trade page to reclaim your escrowed YES tokens.`,
    });
  }
  if (parts.length === 0) return null;
  const ariaLabel = parts.map((p) => p.label).join(", ");
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
      aria-label={`Your presence on this market: ${ariaLabel}`}
      title="Click through to the trade page to see your full position and any open orders."
    >
      {parts.map((p, i) => (
        <span key={p.key} className={p.cls} title={p.title}>
          {i > 0 && <span className="mr-1 text-muted">·</span>}
          {p.label}
        </span>
      ))}
    </span>
  );
}

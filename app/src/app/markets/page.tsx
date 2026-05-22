"use client";

import Link from "next/link";

import { useMarkets } from "@/hooks/useMarkets";
import { formatUsdc } from "@/lib/usdc";
import {
  isTradeable,
  marketUiState,
  marketUiStateLabel,
  marketUiStatePillClasses,
  sessionPhase,
  sessionPhaseBannerCopy,
} from "@/lib/marketSession";

// Force runtime rendering — the page depends on the wallet adapter and
// Anchor client, which pull Node-only modules at module-init time.
// Next's build-time prerender path can't load them.
export const dynamic = "force-dynamic";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

export default function MarketsPage() {
  const { data, isLoading, error } = useMarkets();
  const phase = sessionPhase();
  const banner = sessionPhaseBannerCopy(phase);

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
                      const clickable = isTradeable(state);
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
                            <span className={marketUiStatePillClasses(state)}>
                              {marketUiStateLabel(state)}
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

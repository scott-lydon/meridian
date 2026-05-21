"use client";

import Link from "next/link";

import { useMarkets } from "@/hooks/useMarkets";
import { formatUsdc } from "@/lib/usdc";

// Force runtime rendering — the page depends on the wallet adapter and
// Anchor client, which pull Node-only modules at module-init time.
// Next's build-time prerender path can't load them.
export const dynamic = "force-dynamic";

const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] as const;

export default function MarketsPage() {
  const { data, isLoading, error } = useMarkets();

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">Markets</h1>
      <p className="mb-8 text-muted">
        Today's binary outcome contracts. Each strike resolves on the underlying stock's 16:00 ET
        closing price.
      </p>

      {isLoading && <p className="text-muted">Loading on-chain markets...</p>}
      {error && (
        <p className="rounded border border-no bg-no/10 p-4 text-no">
          Error reading markets: {(error as Error).message}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MAG7.map((ticker) => {
          const tickerMarkets = (data ?? []).filter((m) => m.ticker === ticker);
          return (
            <div key={ticker} className="rounded-2xl border border-panel bg-panel/40 p-5">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-xl font-semibold">{ticker}</h2>
                <span className="text-xs uppercase tracking-wider text-muted">
                  {tickerMarkets.length} strike{tickerMarkets.length === 1 ? "" : "s"}
                </span>
              </div>
              {tickerMarkets.length === 0 ? (
                <p className="text-sm text-muted">No markets yet today.</p>
              ) : (
                <ul className="space-y-2">
                  {tickerMarkets
                    .sort((a, b) => Number(a.strikeUsd - b.strikeUsd))
                    .map((m) => (
                      <li key={m.pubkey}>
                        <Link
                          href={`/trade/${m.ticker}/${m.pubkey}`}
                          className="flex items-center justify-between rounded-lg px-3 py-2 font-mono text-sm hover:bg-bg/50"
                        >
                          <span>&gt; {formatUsdc(m.strikeUsd)}</span>
                          <span className="text-xs text-muted">
                            {m.outcome === "Pending"
                              ? "live"
                              : m.outcome === "YesWins"
                                ? "Yes won"
                                : "No won"}
                          </span>
                        </Link>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}

"use client";

import { useWallet } from "@solana/wallet-adapter-react";

import { useMarkets } from "@/hooks/useMarkets";
import { formatUsdc } from "@/lib/usdc";

export const dynamic = "force-dynamic";

export default function PortfolioPage() {
  const { publicKey } = useWallet();
  const { data: markets, isLoading } = useMarkets();

  if (!publicKey) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="mb-3 text-3xl font-bold">Portfolio</h1>
        <p className="text-muted">Connect a wallet to see your positions and settled payouts.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-bold">Portfolio</h1>
      <p className="mb-8 text-muted">Active positions and settled redeems for {publicKey.toBase58().slice(0, 8)}...</p>

      {isLoading && <p className="text-muted">Loading positions...</p>}

      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Settled markets</h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5">
          {markets?.filter((m) => m.outcome !== "Pending").length === 0 ? (
            <p className="text-sm text-muted">No settled markets yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="pb-2">Ticker</th>
                  <th className="pb-2">Strike</th>
                  <th className="pb-2">Close</th>
                  <th className="pb-2">Outcome</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {markets
                  ?.filter((m) => m.outcome !== "Pending")
                  .map((m) => (
                    <tr key={m.pubkey} className="border-t border-panel/50">
                      <td className="py-2">{m.ticker}</td>
                      <td className="py-2">{formatUsdc(m.strikeUsd)}</td>
                      <td className="py-2">{formatUsdc(m.closingPriceUsd)}</td>
                      <td className="py-2">
                        <span
                          className={
                            m.outcome === "YesWins"
                              ? "rounded-full bg-yes/20 px-2 py-0.5 text-yes"
                              : "rounded-full bg-no/20 px-2 py-0.5 text-no"
                          }
                        >
                          {m.outcome === "YesWins" ? "Yes" : "No"}
                          {m.adminOverride ? " (admin)" : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

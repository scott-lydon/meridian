"use client";

// Portfolio page (US-13).
// Shape:
//   - Banner: aggregate redeemable USDC across all settled positions +
//     mark-to-market value across all active positions.
//   - Active table: ticker, strike, side balances, current mark from the
//     order book mid, mark-to-market value of the position.
//   - Settled table: outcome, payout per token ($1.00 for winners, $0.00
//     for losers), held qty per side, total payout, Redeem / Burn buttons.
//
// Avg entry price + unrealized P&L on active positions require per-fill
// cost-basis attribution (Helius webhook indexer); deferred to v2 per
// spec.md out-of-scope list.

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";

import { useUserPositions, totalsFor } from "@/hooks/useUserPositions";
import { useRedeem } from "@/hooks/useRedeem";
import { formatUsdc, usdcFromBase } from "@/lib/usdc";

export const dynamic = "force-dynamic";

function explorerTx(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function fmtMicros(micros: bigint | undefined): string {
  if (micros === undefined) return "—";
  return formatUsdc(usdcFromBase(micros));
}

export default function PortfolioPage() {
  const { publicKey } = useWallet();
  const positions = useUserPositions();
  const redeem = useRedeem();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [lastErr, setLastErr] = useState<string | null>(null);

  async function doRedeem(marketPk: string, side: "yes" | "no", qty: bigint, label: string) {
    setBusy(label);
    setLastErr(null);
    setLastSig(null);
    try {
      const sig = await redeem(marketPk, side, qty);
      setLastSig(sig);
      void queryClient.invalidateQueries({ queryKey: ["user-positions"] });
    } catch (e) {
      // Surface as a user-visible error block; do NOT swallow.
      setLastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!publicKey) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="mb-3 text-3xl font-bold">Portfolio</h1>
        <p className="text-muted">Connect a wallet to see your positions and settled payouts.</p>
      </main>
    );
  }

  const data = positions.data ?? [];
  const active = data.filter((p) => p.market.outcome === "Pending");
  const settled = data.filter((p) => p.market.outcome !== "Pending");
  const totals = totalsFor(data);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-bold">Portfolio</h1>
      <p className="mb-6 text-muted">
        Live positions for <span className="font-mono">{publicKey.toBase58().slice(0, 8)}…</span>. Refreshes every 5s.
      </p>

      {/* Aggregate banner — top of page per US-13 acceptance. */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-panel bg-panel/40 p-5">
          <p className="text-xs uppercase tracking-wider text-muted">Redeemable now (settled)</p>
          <p className="mt-1 font-mono text-2xl text-yes">{fmtMicros(totals.realizedRedeemableMicros)}</p>
          <p className="text-xs text-muted">
            Sum of every winning settled position. Click Redeem on each row below to claim.
          </p>
        </div>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5">
          <p className="text-xs uppercase tracking-wider text-muted">Mark-to-market (active)</p>
          <p className="mt-1 font-mono text-2xl text-accent">{fmtMicros(totals.activeMarkValueMicros)}</p>
          <p className="text-xs text-muted">
            Sum of qty × mid-price across active positions. Avg-entry-price tracking ships in v2 (needs off-chain indexer).
          </p>
        </div>
      </div>

      {positions.isLoading && <p className="text-muted">Loading positions...</p>}

      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Active positions</h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5">
          {active.length === 0 && (
            <p className="text-sm text-muted">
              No active positions. Visit{" "}
              <Link href="/markets" className="text-accent underline">
                Markets
              </Link>{" "}
              to open one.
            </p>
          )}
          {active.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="pb-2">Ticker</th>
                  <th className="pb-2">Strike</th>
                  <th className="pb-2 text-right">Yes</th>
                  <th className="pb-2 text-right">No</th>
                  <th className="pb-2 text-right">Mid</th>
                  <th className="pb-2 text-right">Mark value</th>
                  <th className="pb-2">Settles</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {active.map((p) => (
                  <tr key={p.market.pubkey} className="border-t border-panel/50">
                    <td className="py-2">
                      <Link className="text-accent" href={`/trade/${p.market.ticker}/${p.market.pubkey}`}>
                        {p.market.ticker}
                      </Link>
                    </td>
                    <td className="py-2">{formatUsdc(p.market.strikeUsd)}</td>
                    <td className="py-2 text-right text-yes">{p.yesBalance.toString()}</td>
                    <td className="py-2 text-right text-no">{p.noBalance.toString()}</td>
                    <td className="py-2 text-right text-muted" title="Mid = (best bid + best ask) / 2 on the on-chain book">
                      {p.quote?.midUsdcMicros !== undefined ? fmtMicros(p.quote.midUsdcMicros) : "—"}
                    </td>
                    <td className="py-2 text-right text-accent">{fmtMicros(p.markValueUsdcMicros)}</td>
                    <td className="py-2 text-xs text-muted">
                      {new Date(p.market.expiryUnix * 1000).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Settled — redeem here</h2>
        <div className="rounded-2xl border border-panel bg-panel/40 p-5">
          {settled.length === 0 && (
            <p className="text-sm text-muted">No settled positions yet.</p>
          )}
          {settled.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="pb-2">Ticker</th>
                  <th className="pb-2">Strike</th>
                  <th className="pb-2">Close</th>
                  <th className="pb-2">Outcome</th>
                  <th className="pb-2 text-right">Yes / No held</th>
                  <th className="pb-2 text-right">Payout / token</th>
                  <th className="pb-2 text-right">Total payout</th>
                  <th className="pb-2">Action</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {settled.map((p) => {
                  const yesWins = p.market.outcome === "YesWins";
                  const winningSide: "yes" | "no" = yesWins ? "yes" : "no";
                  const winningQty = yesWins ? p.yesBalance : p.noBalance;
                  const losingSide: "yes" | "no" = yesWins ? "no" : "yes";
                  const losingQty = yesWins ? p.noBalance : p.yesBalance;
                  return (
                    <tr key={p.market.pubkey} className="border-t border-panel/50">
                      <td className="py-2">{p.market.ticker}</td>
                      <td className="py-2">{formatUsdc(p.market.strikeUsd)}</td>
                      <td className="py-2">{formatUsdc(p.market.closingPriceUsd)}</td>
                      <td className="py-2">
                        <span className={yesWins ? "text-yes" : "text-no"}>
                          {yesWins ? "Yes" : "No"}
                          {p.market.adminOverride ? " (admin)" : ""}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        <span className="text-yes">{p.yesBalance.toString()}</span>
                        {" / "}
                        <span className="text-no">{p.noBalance.toString()}</span>
                      </td>
                      <td className="py-2 text-right text-xs">
                        <span className={yesWins ? "text-yes" : "text-muted"}>Yes $1.00</span>
                        {" / "}
                        <span className={yesWins ? "text-muted" : "text-no"}>No {yesWins ? "$0.00" : "$1.00"}</span>
                      </td>
                      <td className="py-2 text-right">
                        {p.redeemableUsdcMicros !== undefined
                          ? formatUsdc(usdcFromBase(p.redeemableUsdcMicros))
                          : "—"}
                      </td>
                      <td className="py-2 space-x-2">
                        {winningQty > 0n && (
                          <button
                            disabled={busy !== null}
                            onClick={() =>
                              doRedeem(
                                p.market.pubkey,
                                winningSide,
                                winningQty,
                                `Redeem ${winningSide} ${p.market.ticker}`,
                              )
                            }
                            className="rounded bg-yes/20 px-3 py-1 text-xs font-semibold text-yes hover:bg-yes/30 disabled:opacity-40"
                          >
                            Redeem {winningSide.toUpperCase()} → {formatUsdc(usdcFromBase(winningQty * 1_000_000n))}
                          </button>
                        )}
                        {losingQty > 0n && (
                          <button
                            disabled={busy !== null}
                            onClick={() =>
                              doRedeem(
                                p.market.pubkey,
                                losingSide,
                                losingQty,
                                `Burn losing ${losingSide} ${p.market.ticker}`,
                              )
                            }
                            className="rounded bg-panel px-3 py-1 text-xs text-muted hover:bg-bg disabled:opacity-40"
                            title="Burns the losing tokens for $0 — reclaims the ATA rent."
                          >
                            Burn {losingSide.toUpperCase()} ({losingQty.toString()})
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {(lastSig || lastErr) && (
            <div className="mt-4 text-xs">
              {lastSig && (
                <p className="text-muted">
                  ✓ tx:{" "}
                  <a className="text-accent" href={explorerTx(lastSig)} target="_blank" rel="noreferrer">
                    {lastSig.slice(0, 10)}…{lastSig.slice(-6)}
                  </a>
                </p>
              )}
              {lastErr && (
                <p className="break-words rounded border border-no/40 bg-no/10 p-2 text-no">
                  {lastErr}
                </p>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

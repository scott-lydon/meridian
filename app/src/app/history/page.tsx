"use client";

// US-14: connected user's own Meridian-program transactions for the last 30
// days, with the human action label, the resulting USDC balance change, and
// one click to Solana Explorer for the full audit trail.

import { useWallet } from "@solana/wallet-adapter-react";
import { looksRateLimited, useUserHistory, type UserTx } from "@/hooks/useUserHistory";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/cluster";
import { formatUsdc, usdcFromBase } from "@/lib/usdc";

export const dynamic = "force-dynamic";

function fmtTime(unix: number | null) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString();
}

function labelColor(label: string) {
  if (label.startsWith("Redeem")) return "text-yes";
  if (label.startsWith("Buy ")) return "text-accent";
  if (label.startsWith("Sell ")) return "text-no";
  if (label.startsWith("Mint pair")) return "text-accent";
  if (label.startsWith("Cancel")) return "text-muted";
  if (label.startsWith("Settle") || label.startsWith("Pause") || label.startsWith("Unpause") || label.includes("admin")) {
    return "text-accentHover";
  }
  return "text-muted";
}

function fmtDelta(deltaMicros: bigint | undefined): { text: string; cls: string } {
  if (deltaMicros === undefined || deltaMicros === 0n) return { text: "—", cls: "text-muted" };
  const sign = deltaMicros > 0n ? "+" : "-";
  const abs = deltaMicros > 0n ? deltaMicros : -deltaMicros;
  return {
    text: `${sign}${formatUsdc(usdcFromBase(abs))}`,
    cls: deltaMicros > 0n ? "text-yes" : "text-no",
  };
}

export default function HistoryPage() {
  const { publicKey } = useWallet();
  // 30-record window (was 50) cuts the per-refresh RPC volume by ~40% on
  // the public devnet endpoint. Combined with the in-hook
  // signature-decode cache, this is the front-end's leg of the
  // rate-limit fix; the rear leg (Helius / Triton / QuickNode dedicated
  // endpoint via NEXT_PUBLIC_SOLANA_RPC_URL) is the only path to fully
  // eliminate the throttle.
  const history = useUserHistory(30, 30);
  const errorMessage = history.error
    ? (history.error as Error)?.message ?? String(history.error)
    : null;
  // Detect the specific "Too many requests" path so the UI can frame the
  // failure correctly ("the public RPC throttled us") instead of leaving
  // the user staring at an unactionable red banner. The retry button
  // calls history.refetch() — by then the rate-limit window has usually
  // cleared.
  const rateLimited = errorMessage !== null && looksRateLimited(history.error);

  if (!publicKey) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="mb-3 text-3xl font-bold">History</h1>
        <p className="text-muted">Connect a wallet to see your transaction history.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-bold">History</h1>
      <p className="mb-8 text-muted">
        Your Meridian program transactions for{" "}
        <span className="font-mono">{publicKey.toBase58().slice(0, 8)}…</span> over the last 30 days. Refreshes every 20s.
      </p>

      <div className="rounded-2xl border border-panel bg-panel/40 p-5">
        {history.isLoading && <p className="text-muted">Loading recent transactions…</p>}
        {history.isError && rateLimited && (
          <div className="rounded border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-100">
            <p className="font-semibold">Public devnet RPC throttled us.</p>
            <p className="mt-1 text-yellow-100/90">
              <span className="font-mono">api.devnet.solana.com</span> caps requests per IP, and the
              call to load history hit that cap. This is a rate-limit, not a real failure — the data
              is fine, the RPC just refused to send it for a few seconds.
            </p>
            <p className="mt-1 text-yellow-100/90">
              The page auto-retries with backoff, but you can also manually retry now. For a
              permanent fix, switch{" "}
              <span className="font-mono">NEXT_PUBLIC_SOLANA_RPC_URL</span> to a dedicated endpoint
              (Helius, Triton, QuickNode — all have free-tier devnet plans).
            </p>
            <button
              type="button"
              onClick={() => void history.refetch()}
              className="mt-2 rounded-lg border border-yellow-500/50 bg-yellow-500/20 px-3 py-1 text-xs font-semibold text-yellow-100 hover:bg-yellow-500/30"
              disabled={history.isFetching}
            >
              {history.isFetching ? "Retrying…" : "Retry now"}
            </button>
          </div>
        )}
        {history.isError && !rateLimited && (
          <div className="rounded border border-no/40 bg-no/10 p-3 text-no">
            <p>Could not load history: {errorMessage}</p>
            <button
              type="button"
              onClick={() => void history.refetch()}
              className="mt-2 rounded-lg border border-no/50 bg-no/20 px-3 py-1 text-xs font-semibold text-no hover:bg-no/30"
              disabled={history.isFetching}
            >
              {history.isFetching ? "Retrying…" : "Retry"}
            </button>
          </div>
        )}
        {!history.isLoading && (history.data?.length ?? 0) === 0 && (
          <p className="text-sm text-muted">
            No transactions yet. Trade or redeem on a market and your activity will appear here within seconds.
          </p>
        )}
        {(history.data?.length ?? 0) > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="px-3 pb-2">When</th>
                <th className="px-3 pb-2">Action</th>
                <th className="px-3 pb-2 text-right">USDC change</th>
                <th className="px-3 pb-2 text-center">Status</th>
                <th className="px-3 pb-2">Signature</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {history.data!.map((t: UserTx) => {
                const d = fmtDelta(t.usdcDeltaMicros);
                return (
                  <tr key={t.signature} className="border-t border-panel/50 align-top">
                    <td className="px-3 py-2 text-xs text-muted">{fmtTime(t.blockTime)}</td>
                    <td className={`px-3 py-2 ${labelColor(t.label)}`} title={`method=${t.method} | slot=${t.slot}`}>
                      {t.label}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${d.cls}`}>{d.text}</td>
                    <td className="px-3 py-2 text-center">
                      {t.success ? (
                        <span className="inline-block rounded-full border border-yes/40 bg-yes/10 px-2 py-0.5 text-[10px] font-sans uppercase tracking-wider text-yes">
                          ok
                        </span>
                      ) : (
                        <span
                          className="inline-block rounded-full border border-no/40 bg-no/10 px-2 py-0.5 text-[10px] font-sans uppercase tracking-wider text-no"
                          title={t.errLog ?? "tx error"}
                        >
                          failed
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <a
                        className="text-accent"
                        href={explorerTxUrl(t.signature)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t.signature.slice(0, 10)}…{t.signature.slice(-6)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-4 text-xs text-muted">
        Full audit on{" "}
        <a
          className="text-accent underline"
          href={explorerAddressUrl(publicKey.toBase58())}
          target="_blank"
          rel="noreferrer"
        >
          Solana Explorer →
        </a>
      </p>
    </main>
  );
}

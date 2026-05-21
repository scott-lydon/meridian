"use client";

// US-14: connected user's own Meridian-program transactions, freshest first,
// with one click to Solana Explorer for the full audit trail.

import { useWallet } from "@solana/wallet-adapter-react";
import { useUserHistory, type UserTx } from "@/hooks/useUserHistory";

export const dynamic = "force-dynamic";

function explorerTx(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function fmtTime(unix: number | null) {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString();
}

function methodColor(method: string) {
  if (method.startsWith("redeem")) return "text-yes";
  if (method.startsWith("place_order") || method.startsWith("buy_") || method.startsWith("sell_")) return "text-accent";
  if (method.startsWith("settle_") || method.startsWith("admin_") || method.startsWith("pause")) return "text-accentHover";
  return "text-muted";
}

export default function HistoryPage() {
  const { publicKey } = useWallet();
  const history = useUserHistory(50);

  if (!publicKey) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-center">
        <h1 className="mb-3 text-3xl font-bold">History</h1>
        <p className="text-muted">Connect a wallet to see your transaction history.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-bold">History</h1>
      <p className="mb-8 text-muted">
        Your Meridian program transactions for{" "}
        <span className="font-mono">{publicKey.toBase58().slice(0, 8)}…</span>. Refreshes every 8s.
      </p>

      <div className="rounded-2xl border border-panel bg-panel/40 p-5">
        {history.isLoading && <p className="text-muted">Loading recent transactions…</p>}
        {history.isError && (
          <p className="rounded border border-no/40 bg-no/10 p-3 text-no">
            Could not load history: {(history.error as Error)?.message ?? String(history.error)}
          </p>
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
                <th className="pb-2">When</th>
                <th className="pb-2">Method</th>
                <th className="pb-2">Status</th>
                <th className="pb-2">Slot</th>
                <th className="pb-2">Signature</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {history.data!.map((t: UserTx) => (
                <tr key={t.signature} className="border-t border-panel/50 align-top">
                  <td className="py-2 text-xs text-muted">{fmtTime(t.blockTime)}</td>
                  <td className={`py-2 ${methodColor(t.method)}`}>{t.method}</td>
                  <td className="py-2">
                    {t.success ? (
                      <span className="text-yes">ok</span>
                    ) : (
                      <span className="text-no" title={t.errLog ?? "tx error"}>
                        failed
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-muted">{t.slot}</td>
                  <td className="py-2">
                    <a
                      className="text-accent"
                      href={explorerTx(t.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t.signature.slice(0, 10)}…{t.signature.slice(-6)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="mt-4 text-xs text-muted">
        Full audit on{" "}
        <a
          className="text-accent underline"
          href={`https://explorer.solana.com/address/${publicKey.toBase58()}?cluster=devnet`}
          target="_blank"
          rel="noreferrer"
        >
          Solana Explorer →
        </a>
      </p>
    </main>
  );
}

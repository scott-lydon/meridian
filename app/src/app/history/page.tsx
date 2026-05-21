"use client";

import { useWallet } from "@solana/wallet-adapter-react";

export default function HistoryPage() {
  const { publicKey } = useWallet();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="mb-2 text-3xl font-bold">History</h1>
      <p className="mb-8 text-muted">
        {publicKey
          ? `Recent transactions for ${publicKey.toBase58().slice(0, 8)}...`
          : "Connect wallet to view your transaction history."}
      </p>
      <div className="rounded-2xl border border-panel bg-panel/40 p-8 text-center text-muted">
        Transaction history rendering arrives with slice 8. Use the{" "}
        <a
          className="text-accent underline"
          href="https://explorer.solana.com/?cluster=devnet"
          target="_blank"
          rel="noreferrer"
        >
          Solana Explorer
        </a>{" "}
        for now.
      </div>
    </main>
  );
}

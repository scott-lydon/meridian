"use client";

// useSolBalance — return the connected wallet's lamports balance via the
// SITE's RPC endpoint (not the wallet extension's). This is the key
// distinction that makes the hook useful for cluster-mismatch detection:
//
//   - The wallet extension (Phantom, Solflare, etc.) holds its OWN view of
//     the wallet's balance, scoped to whichever cluster the user picked
//     inside the extension (Mainnet by default for Phantom).
//   - The site's `useConnection()` is bound to `cluster.rpcUrl` which is
//     the cluster the SITE expects (devnet for Meridian today).
//   - When the two clusters disagree, the wallet shows N SOL but the site
//     RPC reports 0. That's the cluster-mismatch signature; the Solana
//     Wallet Standard does NOT let us read the wallet's selected cluster
//     directly (Phantom blocks that as a fingerprinting vector), so this
//     indirect signal is the best heuristic we have.
//
// Subscribes via WS so the balance updates without a refresh, matching
// the pattern in `useUsdcBalance.ts`. Returns lamports as a `bigint` to
// avoid the 2^53 precision-loss footgun on long-running wallets, even
// though devnet balances in practice fit comfortably in a `number`.

import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { queryKeys, queryClient } from "@/lib/queryClient";

export interface SolBalance {
  /** Raw lamports as a bigint. 1 SOL = 1_000_000_000 lamports. */
  lamports: bigint;
  /** UI-friendly SOL value (lamports / 1e9). For display only. */
  ui: number;
}

export function useSolBalance(owner: string | undefined) {
  const { connection } = useConnection();

  // WS subscription on the wallet account itself. Any lamports change
  // (airdrop, fee-paying tx, transfer) triggers an invalidation. We do
  // NOT poll because polling burns devnet RPC quota and the WS path is
  // already covering the cases we care about.
  useEffect(() => {
    if (!owner) return;
    const pk = new PublicKey(owner);
    const subId = connection.onAccountChange(pk, () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.solBalance(owner) });
    });
    return () => {
      // Per @solana/web3.js: removeAccountChangeListener is fire-and-forget;
      // we still discard the returned promise explicitly to silence
      // floating-promise lint and match useUsdcBalance.
      void connection.removeAccountChangeListener(subId);
    };
  }, [connection, owner]);

  return useQuery<SolBalance>({
    queryKey: owner ? queryKeys.solBalance(owner) : ["sol-balance", "disconnected"],
    enabled: !!owner,
    queryFn: async () => {
      if (!owner) {
        // Defensive: enabled gate above should make this unreachable.
        // Throwing with a specific cause beats returning a wrong default.
        throw new Error(
          "useSolBalance.queryFn: owner is undefined despite enabled gate. " +
            "This is a hook-wiring bug; check the caller passes the connected publicKey base58.",
        );
      }
      const pk = new PublicKey(owner);
      const lamports = await connection.getBalance(pk, "confirmed");
      const lamportsBig = BigInt(lamports);
      return {
        lamports: lamportsBig,
        ui: Number(lamportsBig) / 1e9,
      };
    },
  });
}

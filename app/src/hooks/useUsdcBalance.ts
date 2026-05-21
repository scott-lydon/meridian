"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { cluster } from "@/lib/cluster";
import { queryKeys, queryClient } from "@/lib/queryClient";
import { usdcFromBase, type UsdcBase } from "@/lib/usdc";

/**
 * Returns the user's USDC balance as a branded `UsdcBase`.
 * Subscribes via WS so the balance updates without a refresh.
 */
export function useUsdcBalance(owner: string | undefined) {
  const { connection } = useConnection();

  // WS subscription to the user's USDC ATA. Triggers cache invalidation on any
  // account-data change.
  useEffect(() => {
    if (!owner) return;
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(cluster.usdcMint),
      new PublicKey(owner),
    );
    const subId = connection.onAccountChange(ata, () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.usdcBalance(owner) });
    });
    return () => {
      // Per @solana/web3.js: removeAccountChangeListener is fire-and-forget.
      void connection.removeAccountChangeListener(subId);
    };
  }, [connection, owner]);

  return useQuery<UsdcBase>({
    queryKey: owner ? queryKeys.usdcBalance(owner) : ["usdc-balance", "disconnected"],
    enabled: !!owner,
    queryFn: async () => {
      if (!owner) throw new Error("useUsdcBalance: owner required");
      const ata = getAssociatedTokenAddressSync(
        new PublicKey(cluster.usdcMint),
        new PublicKey(owner),
      );
      try {
        const account = await getAccount(connection, ata);
        return usdcFromBase(account.amount);
      } catch (err) {
        // ATA does not exist yet -> balance is zero. Any other error rethrows so
        // the UI can surface it.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes("could not find account")) {
          return usdcFromBase(0n);
        }
        throw err;
      }
    },
  });
}

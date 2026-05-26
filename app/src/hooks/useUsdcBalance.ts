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
 *
 * Refresh strategy is BELT-AND-SUSPENDERS:
 *   1. WebSocket account subscription on the USDC ATA — instant push on
 *      every on-chain change, when it works.
 *   2. Polling refetchInterval — fallback layer that catches every WS miss.
 *      Public devnet WS (wss://api.devnet.solana.com) reliably drops events
 *      under load, which is the root cause of the "header shows $20 forever
 *      until I click somewhere" bug reported 2026-05-25 — the user's actual
 *      on-chain balance had been $16 for hours but the WS never fired and
 *      nothing else invalidated the cache until a window-focus event from
 *      clicking the DEVNET pill. Polling guarantees the pill is never more
 *      than ~5s stale even when the WS is completely silent.
 *   3. refetchOnWindowFocus (inherited from the global queryClient) —
 *      catches tab-switch / app-switch / extension-popup cases that the
 *      polling timer pauses for.
 *
 * WTF heads-up: the ATA-creation race. If the wallet connects BEFORE the
 * USDC ATA exists on-chain (very common; a brand-new wallet does not have
 * the ATA until either the faucet drop or the first `mint_pair` creates
 * it), the WS subscription registers against an address Solana has never
 * seen. The subscription stays valid and fires once the account is
 * created, but in practice public-RPC WS often misses that first event
 * too. The polling layer handles that case transparently.
 */
export function useUsdcBalance(owner: string | undefined) {
  const { connection } = useConnection();

  // WS subscription to the user's USDC ATA. Triggers cache invalidation on any
  // account-data change. Best-effort layer (see strategy comment above).
  useEffect(() => {
    if (!owner) return;
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(cluster.usdcMint),
      new PublicKey(owner),
    );
    let subId: number | null = null;
    try {
      subId = connection.onAccountChange(ata, () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.usdcBalance(owner) });
      });
    } catch (err) {
      // WS endpoint refused / WS pool exhausted / unsupported on this RPC.
      // Polling layer (refetchInterval below) keeps the balance honest, so
      // we log and continue rather than throwing — the user's pill still
      // updates within ~5s even with the WS dead.
      // eslint-disable-next-line no-console
      console.warn(
        `useUsdcBalance: WS subscribe failed for ATA ${ata.toBase58()} (polling will still keep balance fresh): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return () => {
      if (subId !== null) {
        // Per @solana/web3.js: removeAccountChangeListener is fire-and-forget.
        void connection.removeAccountChangeListener(subId);
      }
    };
  }, [connection, owner]);

  return useQuery<UsdcBase>({
    queryKey: owner ? queryKeys.usdcBalance(owner) : ["usdc-balance", "disconnected"],
    enabled: !!owner,
    // 5s polling matches useUserPositions and is one slot beyond the
    // ~400ms Solana slot time, so the worst case is "balance pill is one
    // confirmed-slot behind". No throttle / debounce / smoothing — the
    // user-facing pill must always be ON-CHAIN TRUTH, never a smoothed
    // approximation.
    refetchInterval: 5_000,
    // Don't burn devnet RPC budget while the tab is in the background;
    // refetchOnWindowFocus will catch us up the moment the user returns.
    refetchIntervalInBackground: false,
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

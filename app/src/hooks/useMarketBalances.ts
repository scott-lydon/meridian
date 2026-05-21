"use client";

// Read the connected user's Yes and No token balances for one market.
// Used by the trade page to enforce the position constraint (PRD §Position
// Constraints): a user cannot Buy Yes if they already hold No, and vice
// versa. UX-level only — the on-chain program allows mid-mint transients
// for market makers.

import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveMarketAddresses } from "@/hooks/useTrade";
import { useMeridian } from "@/hooks/useMeridian";

export interface MarketBalances {
  yes: bigint;
  no: bigint;
}

export function useMarketBalances(marketPubkey: string | undefined) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { program } = useMeridian();
  return useQuery<MarketBalances>({
    queryKey: ["market-balances", marketPubkey ?? "?", publicKey?.toBase58() ?? "?"],
    enabled: !!marketPubkey && !!publicKey,
    queryFn: async () => {
      if (!marketPubkey || !publicKey) return { yes: 0n, no: 0n };
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const yesAta = getAssociatedTokenAddressSync(addrs.yesMint, publicKey);
      const noAta = getAssociatedTokenAddressSync(addrs.noMint, publicKey);
      let yes = 0n;
      let no = 0n;
      try {
        yes = (await getAccount(connection, yesAta)).amount;
      } catch {
        /* ATA not yet created -> balance is zero */
      }
      try {
        no = (await getAccount(connection, noAta)).amount;
      } catch {
        /* same */
      }
      return { yes, no };
    },
    refetchInterval: 3_000,
  });
}

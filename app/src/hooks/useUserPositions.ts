"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets, type MarketView } from "@/hooks/useMarkets";
import { deriveMarketAddresses } from "@/hooks/useTrade";

export interface PositionView {
  market: MarketView;
  yesBalance: bigint;
  noBalance: bigint;
  /**
   * On a settled market: how much USDC the user is owed if they redeem.
   * On a pending market: undefined.
   */
  redeemableUsdcMicros?: bigint;
}

export function useUserPositions() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { program } = useMeridian();
  const markets = useMarkets();

  return useQuery<PositionView[]>({
    queryKey: ["user-positions", publicKey?.toBase58() ?? "?", markets.data?.length ?? 0],
    enabled: !!publicKey && !!markets.data,
    queryFn: async () => {
      if (!publicKey || !markets.data) return [];
      const result: PositionView[] = [];
      for (const m of markets.data) {
        const addrs = deriveMarketAddresses(program.programId, new PublicKey(m.pubkey));
        const yesAta = getAssociatedTokenAddressSync(addrs.yesMint, publicKey);
        const noAta = getAssociatedTokenAddressSync(addrs.noMint, publicKey);
        let yes = 0n;
        let no = 0n;
        try {
          yes = (await getAccount(connection, yesAta)).amount;
        } catch {
          /* ATA not yet present */
        }
        try {
          no = (await getAccount(connection, noAta)).amount;
        } catch {
          /* same */
        }
        if (yes === 0n && no === 0n) continue;

        // Only attach `redeemableUsdcMicros` when the market is settled — with
        // exactOptionalPropertyTypes: true, the property must be omitted (not
        // set to `undefined`) when there is no value.
        const base = { market: m, yesBalance: yes, noBalance: no };
        if (m.outcome === "YesWins") {
          result.push({ ...base, redeemableUsdcMicros: yes * 1_000_000n });
        } else if (m.outcome === "NoWins") {
          result.push({ ...base, redeemableUsdcMicros: no * 1_000_000n });
        } else {
          result.push(base);
        }
      }
      return result;
    },
    refetchInterval: 5_000,
  });
}

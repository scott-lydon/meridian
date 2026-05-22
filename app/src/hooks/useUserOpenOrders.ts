"use client";

// useUserOpenOrders — connected wallet's resting bids/asks across all markets.
// This is the missing dimension of US-13: the Portfolio page previously only
// showed Yes/No token balances. A user with USDC sitting in book escrow (a
// resting bid) or Yes tokens in book escrow (a resting ask) had no visibility
// into that committed capital and no way to cancel.

import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets, type MarketView } from "@/hooks/useMarkets";
import { usdcFromBase, type UsdcBase } from "@/lib/usdc";

export interface OpenOrderView {
  market: MarketView;
  side: "bid" | "ask";
  priceTicks: number;
  /** USDC price (priceTicks × $0.01). */
  priceUsd: UsdcBase;
  qty: bigint;
  sequence: bigint;
}

export function useUserOpenOrders() {
  useConnection();
  const { publicKey } = useWallet();
  const { program } = useMeridian();
  const markets = useMarkets();

  return useQuery<OpenOrderView[]>({
    queryKey: ["user-open-orders", publicKey?.toBase58() ?? "?", markets.data?.length ?? 0],
    enabled: !!publicKey && !!markets.data,
    queryFn: async () => {
      if (!publicKey || !markets.data) return [];
      const userPk58 = publicKey.toBase58();
      const out: OpenOrderView[] = [];
      for (const m of markets.data) {
        if (m.outcome !== "Pending") continue; // settled markets have no live book
        const [bookPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("book"), new PublicKey(m.pubkey).toBuffer(), Buffer.from([1])],
          program.programId,
        );
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw: any = await (program.account as any).orderBook.fetch(bookPda);
          const collect = (
            arr: unknown[],
            len: number,
            side: "bid" | "ask",
          ): void => {
            for (const o of arr.slice(0, len)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const oo: any = o;
              const owner: PublicKey = oo.owner;
              if (owner.toBase58() !== userPk58) continue;
              const priceTicks = Number(oo.priceTicks);
              out.push({
                market: m,
                side,
                priceTicks,
                priceUsd: usdcFromBase(BigInt(priceTicks) * 10_000n),
                qty: BigInt(oo.qty.toString()),
                sequence: BigInt(oo.sequence.toString()),
              });
            }
          };
          collect(raw.bids, raw.bidsLen, "bid");
          collect(raw.asks, raw.asksLen, "ask");
        } catch {
          // Book account not initialised for this market; nothing to read.
        }
      }
      return out;
    },
    refetchInterval: 5_000,
  });
}

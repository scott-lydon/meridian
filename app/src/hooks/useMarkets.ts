"use client";

import { useQuery } from "@tanstack/react-query";
import type { PublicKey } from "@solana/web3.js";

import { useMeridian } from "@/hooks/useMeridian";
import { queryKeys } from "@/lib/queryClient";
import { tickerFromBytes } from "@/lib/anchor";
import { usdcFromBase, type UsdcBase } from "@/lib/usdc";

export interface MarketView {
  pubkey: string;
  ticker: string;
  strikeUsd: UsdcBase;
  tradingDayUnix: number;
  expiryUnix: number;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  outcome: "Pending" | "YesWins" | "NoWins";
  closingPriceUsd: UsdcBase;
  settledAt: number;
  adminOverride: boolean;
}

/** Fetches every Market account this program knows about. */
export function useMarkets() {
  const { program } = useMeridian();
  return useQuery<MarketView[]>({
    queryKey: queryKeys.markets(0),
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raws: any[] = await (program.account as any).market.all();
      return raws.map((r) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a: any = r.account;
        // WTF heads-up: Anchor serializes a Rust enum into JS as a single-key
        // object with an empty payload, e.g. `OutcomeState::YesWins` arrives
        // as `{ yesWins: {} }`. Taking the only key recovers the variant name.
        const outcomeState = Object.keys(a.outcome.state)[0] ?? "pending";
        const outcome =
          outcomeState === "yesWins" ? "YesWins" : outcomeState === "noWins" ? "NoWins" : "Pending";
        return {
          pubkey: (r.publicKey as PublicKey).toBase58(),
          ticker: tickerFromBytes(a.ticker),
          strikeUsd: usdcFromBase(BigInt(a.strikeUsdMicros.toString())),
          tradingDayUnix: Number(a.tradingDayUnix.toString()),
          expiryUnix: Number(a.expiryUnix.toString()),
          yesMint: a.yesMint,
          noMint: a.noMint,
          vault: a.vault,
          outcome,
          closingPriceUsd: usdcFromBase(BigInt(a.outcome.closingPriceMicros.toString())),
          settledAt: Number(a.outcome.settledAtUnix.toString()),
          adminOverride: Boolean(a.outcome.adminOverride),
        } satisfies MarketView;
      });
    },
  });
}

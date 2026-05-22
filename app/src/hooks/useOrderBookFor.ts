"use client";

// Single source of truth for reading an on-chain order book.
// Both /trade and /portfolio consume this; the trade page used to have
// a local copy. Pulling it into a shared hook means the mid/mark price
// computation on /portfolio matches what the trader saw on /trade.

import { useQuery } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";

import { useMeridian } from "@/hooks/useMeridian";
import { usdcFromBase } from "@/lib/usdc";

export interface OrderView {
  owner: string;
  priceTicks: number;
  /** USDC price in dollars (priceTicks * 0.01). */
  priceUsd: bigint;
  qty: bigint;
  sequence: bigint;
}

export interface BookView {
  bids: OrderView[];
  asks: OrderView[];
}

/** Order-book best-bid / best-ask / mid in USDC dollars (× 1e6). */
export interface BookQuote {
  bestBidUsdcMicros?: bigint;
  bestAskUsdcMicros?: bigint;
  midUsdcMicros?: bigint;
}

export function quoteFromBook(book: BookView | null | undefined): BookQuote {
  if (!book) return {};
  const bestBidTicks = book.bids[0]?.priceTicks;
  const bestAskTicks = book.asks[0]?.priceTicks;
  // priceTicks * 10_000 = USDC micros (priceTicks is in 0.01 increments, USDC has 6 decimals).
  const bestBid = bestBidTicks != null ? BigInt(bestBidTicks) * 10_000n : undefined;
  const bestAsk = bestAskTicks != null ? BigInt(bestAskTicks) * 10_000n : undefined;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2n : undefined;
  const quote: BookQuote = {};
  if (bestBid !== undefined) quote.bestBidUsdcMicros = bestBid;
  if (bestAsk !== undefined) quote.bestAskUsdcMicros = bestAsk;
  if (mid !== undefined) quote.midUsdcMicros = mid;
  return quote;
}

export function useOrderBookFor(marketPubkey: string | undefined) {
  const { program } = useMeridian();
  return useQuery<BookView | null>({
    queryKey: ["order-book", marketPubkey ?? "?"],
    enabled: !!marketPubkey,
    queryFn: async () => {
      if (!marketPubkey) return null;
      const [bookPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("book"), new PublicKey(marketPubkey).toBuffer(), Buffer.from([1])],
        program.programId,
      );
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw: any = await (program.account as any).orderBook.fetch(bookPda);
        const orders = (arr: unknown[], len: number): OrderView[] =>
          arr.slice(0, len).map((o) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const oo: any = o;
            return {
              owner: (oo.owner as PublicKey).toBase58(),
              priceTicks: Number(oo.priceTicks),
              priceUsd: usdcFromBase(BigInt(oo.priceTicks) * 10_000n),
              qty: BigInt(oo.qty.toString()),
              sequence: BigInt(oo.sequence.toString()),
            };
          });
        return {
          bids: orders(raw.bids, raw.bidsLen),
          asks: orders(raw.asks, raw.asksLen),
        };
      } catch (err) {
        // ONLY "account does not exist" is a legitimate empty state — anything
        // else (RPC outage, decode error, IDL drift) is a real bug we must
        // surface, not silently swallow.  Constitution §2.4: no catch-log-continue.
        const msg = err instanceof Error ? err.message : String(err);
        if (/Account does not exist|could not find account/i.test(msg)) {
          return null;
        }
        // Re-throw with enough context to debug from the React Query devtools.
        throw new Error(
          `useOrderBookFor: failed to load order book for market ${marketPubkey} (book PDA ${bookPda.toBase58()}): ${msg}`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    },
    refetchInterval: 5_000,
  });
}

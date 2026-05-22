"use client";

// useUserPositions — connected wallet's Yes/No balances per market with
// derived columns the Portfolio page needs:
//   - For ACTIVE (pending) markets: current mark from the order book
//     (mid of best bid / best ask), used as the mark-to-market price.
//   - For SETTLED markets: redeemable USDC micros (the realized payout).
//
// Avg entry price + unrealized P&L on active positions are intentionally
// not computed here. They require per-fill cost-basis attribution which
// is impractical without an off-chain indexer (Helius webhook on
// place_order / buy_no / sell_no fills). spec.md's out-of-scope list
// documents the deferral and the v2 plan.

import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets, type MarketView } from "@/hooks/useMarkets";
import { deriveMarketAddresses } from "@/hooks/useTrade";
import { quoteFromBook, type BookQuote, type BookView, type OrderView } from "@/hooks/useOrderBookFor";
import { usdcFromBase } from "@/lib/usdc";

export interface PositionView {
  market: MarketView;
  yesBalance: bigint;
  noBalance: bigint;
  /** On a settled market: how much USDC the user receives on Redeem. Omitted on Pending. */
  redeemableUsdcMicros?: bigint;
  /** On a pending market: order-book quote (best bid / best ask / mid). Omitted on settled. */
  quote?: BookQuote;
  /**
   * On a pending market: mark-to-market value of the user's net position in USDC micros.
   *   yes_balance * mid_price + no_balance * (1.00 - mid_price)
   * On a settled market: omitted (use redeemableUsdcMicros).
   */
  markValueUsdcMicros?: bigint;
}

export interface PortfolioTotals {
  /** Sum of redeemableUsdcMicros across all settled positions (realized payout). */
  realizedRedeemableMicros: bigint;
  /** Sum of markValueUsdcMicros across all active positions (mark-to-market). */
  activeMarkValueMicros: bigint;
}

export function totalsFor(positions: PositionView[]): PortfolioTotals {
  let realized = 0n;
  let mark = 0n;
  for (const p of positions) {
    if (p.redeemableUsdcMicros !== undefined) realized += p.redeemableUsdcMicros;
    if (p.markValueUsdcMicros !== undefined) mark += p.markValueUsdcMicros;
  }
  return { realizedRedeemableMicros: realized, activeMarkValueMicros: mark };
}

const USDC_ONE_DOLLAR_MICROS = 1_000_000n;

function fetchOrderBookSnapshot(
  program: ReturnType<typeof useMeridian>["program"],
  marketPubkey: PublicKey,
): Promise<BookView | null> {
  const [bookPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("book"), marketPubkey.toBuffer(), Buffer.from([1])],
    program.programId,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (program.account as any).orderBook
    .fetch(bookPda)
    .then((raw: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rr = raw as any;
      const orders = (arr: unknown[], len: number): OrderView[] =>
        arr.slice(0, len).map((o) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const oo = o as any;
          return {
            owner: (oo.owner as PublicKey).toBase58(),
            priceTicks: Number(oo.priceTicks),
            priceUsd: usdcFromBase(BigInt(oo.priceTicks) * 10_000n),
            qty: BigInt(oo.qty.toString()),
            sequence: BigInt(oo.sequence.toString()),
          };
        });
      return { bids: orders(rr.bids, rr.bidsLen), asks: orders(rr.asks, rr.asksLen) };
    })
    .catch(() => null);
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
        const marketPk = new PublicKey(m.pubkey);
        const addrs = deriveMarketAddresses(program.programId, marketPk);
        const yesAta = getAssociatedTokenAddressSync(addrs.yesMint, publicKey);
        const noAta = getAssociatedTokenAddressSync(addrs.noMint, publicKey);
        let yes = 0n;
        let no = 0n;
        try {
          yes = (await getAccount(connection, yesAta)).amount;
        } catch {
          // ATA not yet present → balance is zero (NOT an error to surface).
        }
        try {
          no = (await getAccount(connection, noAta)).amount;
        } catch {
          // same as above.
        }
        if (yes === 0n && no === 0n) continue;

        const base: PositionView = { market: m, yesBalance: yes, noBalance: no };
        if (m.outcome === "YesWins") {
          result.push({ ...base, redeemableUsdcMicros: yes * USDC_ONE_DOLLAR_MICROS });
          continue;
        }
        if (m.outcome === "NoWins") {
          result.push({ ...base, redeemableUsdcMicros: no * USDC_ONE_DOLLAR_MICROS });
          continue;
        }
        // Pending — derive mark from the order book.
        const book = await fetchOrderBookSnapshot(program, marketPk);
        const quote = quoteFromBook(book);
        const enriched: PositionView = { ...base };
        if (quote.bestBidUsdcMicros !== undefined || quote.bestAskUsdcMicros !== undefined) {
          enriched.quote = quote;
        }
        // Mark-to-market math:
        //   Pair invariant: Yes + No = $1 always (per the PRD's vault rules).
        //   So a balanced position of min(yes, no) pairs is worth EXACTLY $1
        //   per pair regardless of mid. The remaining unbalanced tokens need
        //   the mid-price to be valued. If we don't have mid for the unbalanced
        //   remainder, we leave the markValue as just the pair component
        //   (better than reporting $0 just because the book is empty).
        const pairs = yes < no ? yes : no;
        const yesExcess = yes - pairs;
        const noExcess = no - pairs;
        const pairValue = pairs * USDC_ONE_DOLLAR_MICROS;
        if (quote.midUsdcMicros !== undefined) {
          // Have a mid — value the excess tokens at probability.
          const excessYesValue = yesExcess * quote.midUsdcMicros;
          const excessNoValue = noExcess * (USDC_ONE_DOLLAR_MICROS - quote.midUsdcMicros);
          enriched.markValueUsdcMicros = pairValue + excessYesValue + excessNoValue;
        } else if (pairs > 0n) {
          // No mid available, but the pair component is exact regardless.
          enriched.markValueUsdcMicros = pairValue;
        }
        // (If pairs === 0n AND no mid, markValue is left undefined — we genuinely don't know.)
        result.push(enriched);
      }
      return result;
    },
    refetchInterval: 5_000,
  });
}

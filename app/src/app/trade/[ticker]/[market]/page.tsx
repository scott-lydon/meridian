"use client";

import { use } from "react";
import { PublicKey } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";

import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets } from "@/hooks/useMarkets";
import { formatUsdc, type UsdcBase, usdcFromBase } from "@/lib/usdc";
import { queryKeys } from "@/lib/queryClient";

interface OrderView {
  owner: string;
  priceUsd: UsdcBase;
  qty: bigint;
  sequence: bigint;
}

interface BookView {
  bids: OrderView[];
  asks: OrderView[];
}

function useOrderBookFor(marketPubkey: string) {
  const { program } = useMeridian();
  return useQuery<BookView | null>({
    queryKey: queryKeys.orderBook(marketPubkey),
    queryFn: async () => {
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
              priceUsd: usdcFromBase(BigInt(oo.priceTicks) * 10_000n),
              qty: BigInt(oo.qty.toString()),
              sequence: BigInt(oo.sequence.toString()),
            };
          });
        return {
          bids: orders(raw.bids, raw.bidsLen),
          asks: orders(raw.asks, raw.asksLen),
        };
      } catch {
        // Book not yet initialized for this market.
        return null;
      }
    },
    refetchInterval: 2_000,
  });
}

export default function TradePage({
  params,
}: {
  params: Promise<{ ticker: string; market: string }>;
}) {
  const { ticker, market } = use(params);
  const { data: markets } = useMarkets();
  const { data: book, isLoading: bookLoading } = useOrderBookFor(market);

  const m = markets?.find((x) => x.pubkey === market);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold">{ticker}</h1>
          {m && (
            <p className="text-muted">
              Strike <span className="font-mono">{formatUsdc(m.strikeUsd)}</span> ·{" "}
              {m.outcome === "Pending" ? "live" : m.outcome}
            </p>
          )}
        </div>
        {m && (
          <p className="font-mono text-xs text-muted" title={market}>
            {market.slice(0, 6)}...{market.slice(-4)}
          </p>
        )}
      </header>

      <section className="mb-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="col-span-2 rounded-2xl border border-panel bg-panel/40 p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">
            Order book (Yes/USDC)
          </h2>
          {bookLoading && <p className="text-muted">Loading book...</p>}
          {!bookLoading && !book && (
            <p className="text-sm text-muted">
              Order book not yet initialized for this market. Admin calls{" "}
              <code className="rounded bg-bg/50 px-1 font-mono">init_order_book</code> first.
            </p>
          )}
          {book && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <h3 className="mb-2 text-xs uppercase text-yes">Bids</h3>
                {book.bids.length === 0 ? (
                  <p className="text-sm text-muted">No bids.</p>
                ) : (
                  <ul className="space-y-1 font-mono text-sm">
                    {book.bids.slice(0, 10).map((b, i) => (
                      <li key={i} className="flex justify-between">
                        <span className="text-yes">{formatUsdc(b.priceUsd)}</span>
                        <span className="text-muted">{b.qty.toString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-xs uppercase text-no">Asks</h3>
                {book.asks.length === 0 ? (
                  <p className="text-sm text-muted">No asks.</p>
                ) : (
                  <ul className="space-y-1 font-mono text-sm">
                    {book.asks.slice(0, 10).map((a, i) => (
                      <li key={i} className="flex justify-between">
                        <span className="text-no">{formatUsdc(a.priceUsd)}</span>
                        <span className="text-muted">{a.qty.toString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-panel bg-panel/40 p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">Trade</h2>
          <div className="grid grid-cols-2 gap-2">
            <button className="rounded-lg bg-yes/20 px-3 py-2 font-semibold text-yes hover:bg-yes/30">
              Buy Yes
            </button>
            <button className="rounded-lg bg-no/20 px-3 py-2 font-semibold text-no hover:bg-no/30">
              Buy No
            </button>
            <button className="rounded-lg bg-panel px-3 py-2 text-muted hover:bg-bg">
              Sell Yes
            </button>
            <button className="rounded-lg bg-panel px-3 py-2 text-muted hover:bg-bg">
              Sell No
            </button>
          </div>
          <p className="mt-4 text-xs text-muted">
            Trade execution lands in slice 7. Today's binary outcome: pay $X now, win $1.00 if {ticker}{" "}
            closes at or above {m ? formatUsdc(m.strikeUsd) : "the strike"} at 16:00 ET.
          </p>
        </div>
      </section>
    </main>
  );
}

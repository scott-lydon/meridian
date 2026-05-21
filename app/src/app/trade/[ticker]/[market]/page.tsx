"use client";

import { use, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";

import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets } from "@/hooks/useMarkets";
import { useTrade } from "@/hooks/useTrade";
import { formatUsdc, type UsdcBase, usdcFromBase } from "@/lib/usdc";
import { queryKeys } from "@/lib/queryClient";

export const dynamic = "force-dynamic";

interface OrderView {
  owner: string;
  priceUsd: UsdcBase;
  priceTicks: number;
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
      } catch {
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
  const { publicKey } = useWallet();
  const trade = useTrade(market);
  const queryClient = useQueryClient();

  const [qty, setQty] = useState(1);
  const [priceTicks, setPriceTicks] = useState(50);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [lastErr, setLastErr] = useState<string | null>(null);

  const m = markets?.find((x) => x.pubkey === market);

  function explorerTx(sig: string) {
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }

  async function run(label: string, fn: () => Promise<string>) {
    if (!publicKey) {
      setLastErr("Connect a wallet first.");
      return;
    }
    setBusy(label);
    setLastErr(null);
    setLastSig(null);
    try {
      const sig = await fn();
      setLastSig(sig);
      // Refresh book + balances
      void queryClient.invalidateQueries({ queryKey: queryKeys.orderBook(market) });
    } catch (e) {
      setLastErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const bestBid = book?.bids[0];
  const bestAsk = book?.asks[0];

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
              Order book not yet initialized for this market.
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
                    {book.bids.slice(0, 10).map((b) => (
                      <li key={`${b.owner}-${b.sequence}`} className="flex justify-between">
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
                    {book.asks.slice(0, 10).map((a) => (
                      <li key={`${a.owner}-${a.sequence}`} className="flex justify-between">
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

          {!publicKey && (
            <p className="mb-3 text-sm text-yellow-300">Connect your wallet to trade.</p>
          )}

          <label className="mb-2 block text-xs text-muted">Quantity (Yes tokens)</label>
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
            className="mb-3 w-full rounded-lg border border-panel bg-bg/40 px-3 py-2 font-mono text-sm"
          />

          <label className="mb-2 block text-xs text-muted">Limit price (¢, 1–99) for Buy/Sell Yes</label>
          <input
            type="number"
            min={1}
            max={99}
            value={priceTicks}
            onChange={(e) => setPriceTicks(Math.min(99, Math.max(1, Number(e.target.value))))}
            className="mb-3 w-full rounded-lg border border-panel bg-bg/40 px-3 py-2 font-mono text-sm"
          />

          <div className="grid grid-cols-2 gap-2">
            <button
              disabled={!trade.ready || busy !== null}
              onClick={() => run("Buy Yes", () => trade.buyYes(priceTicks, qty))}
              className="rounded-lg bg-yes/20 px-3 py-2 font-semibold text-yes hover:bg-yes/30 disabled:opacity-40"
            >
              {busy === "Buy Yes" ? "..." : "Buy Yes"}
            </button>
            <button
              disabled={!trade.ready || busy !== null || !bestBid}
              onClick={() =>
                run("Buy No", () =>
                  trade.buyNo(qty, bestBid!.priceTicks, new PublicKey(bestBid!.owner)),
                )
              }
              className="rounded-lg bg-no/20 px-3 py-2 font-semibold text-no hover:bg-no/30 disabled:opacity-40"
              title={bestBid ? `Will fill against bid @ ${formatUsdc(bestBid.priceUsd)}` : "No bid available"}
            >
              {busy === "Buy No" ? "..." : "Buy No"}
            </button>
            <button
              disabled={!trade.ready || busy !== null}
              onClick={() => run("Sell Yes", () => trade.sellYes(priceTicks, qty))}
              className="rounded-lg bg-panel px-3 py-2 text-muted hover:bg-bg disabled:opacity-40"
            >
              {busy === "Sell Yes" ? "..." : "Sell Yes"}
            </button>
            <button
              disabled={!trade.ready || busy !== null || !bestAsk}
              onClick={() =>
                run("Sell No", () =>
                  trade.sellNo(qty, bestAsk!.priceTicks, new PublicKey(bestAsk!.owner)),
                )
              }
              className="rounded-lg bg-panel px-3 py-2 text-muted hover:bg-bg disabled:opacity-40"
              title={bestAsk ? `Will fill against ask @ ${formatUsdc(bestAsk.priceUsd)}` : "No ask available"}
            >
              {busy === "Sell No" ? "..." : "Sell No"}
            </button>
          </div>

          <button
            disabled={!trade.ready || busy !== null}
            onClick={() => run("Mint Pair", () => trade.mintPair(qty))}
            className="mt-3 w-full rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            {busy === "Mint Pair" ? "..." : `Mint ${qty} pair (deposit $${qty}.00 USDC)`}
          </button>

          {lastSig && (
            <p className="mt-4 break-words text-xs text-muted">
              ✓ tx:{" "}
              <a className="text-accent" href={explorerTx(lastSig)} target="_blank" rel="noreferrer">
                {lastSig.slice(0, 10)}…{lastSig.slice(-6)}
              </a>
            </p>
          )}
          {lastErr && (
            <p className="mt-4 break-words rounded border border-no/40 bg-no/10 p-2 text-xs text-no">
              {lastErr}
            </p>
          )}
        </div>
      </section>

      <section className="mb-10 rounded-2xl border border-panel bg-panel/40 p-5 text-xs text-muted">
        <p className="mb-2 font-semibold uppercase tracking-wider">How each button works</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <span className="text-yes">Buy Yes</span>: places a limit Bid at <code>{priceTicks}¢</code> for <code>{qty}</code> Yes tokens. USDC moves into the book's escrow.
          </li>
          <li>
            <span className="text-no">Buy No</span>: atomic mint-pair + IOC sell of the Yes at the best bid (<code>{bestBid?.priceTicks ?? "—"}¢</code>). One signature.
          </li>
          <li>
            <span className="text-muted">Sell Yes</span>: places a limit Ask at <code>{priceTicks}¢</code>. Yes tokens move into escrow.
          </li>
          <li>
            <span className="text-muted">Sell No</span>: atomic IOC buy of Yes at the best ask (<code>{bestAsk?.priceTicks ?? "—"}¢</code>) + pair redemption. One signature.
          </li>
          <li>
            <span className="text-accent">Mint Pair</span>: deposit <code>{qty} USDC</code>, get <code>{qty} Yes</code> + <code>{qty} No</code>. Use this to seed liquidity.
          </li>
        </ul>
      </section>
    </main>
  );
}

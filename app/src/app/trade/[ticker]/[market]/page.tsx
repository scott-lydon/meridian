"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";

import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets } from "@/hooks/useMarkets";
import { useTrade } from "@/hooks/useTrade";
import { useMarketBalances } from "@/hooks/useMarketBalances";
import { formatUsdc, type UsdcBase, usdcFromBase } from "@/lib/usdc";
import { queryKeys } from "@/lib/queryClient";

function useCountdown(toUnix: number | undefined): string {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);
  if (!toUnix) return "—";
  const diff = toUnix - now;
  if (diff <= 0) {
    // Expiry has passed but the market is still tagged Pending. This means
    // settlement has not yet run (automation cron + Pyth oracle read) OR
    // admin_settle has not fired. Be explicit so users don't try to trade
    // an expired market expecting it to be live.
    const elapsed = -diff;
    const eh = Math.floor(elapsed / 3600);
    const em = Math.floor((elapsed % 3600) / 60);
    return eh > 0 ? `Expired ${eh}h ${em}m ago — awaiting settle` : `Expired ${em}m ago — awaiting settle`;
  }
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

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
  params: { ticker: string; market: string };
}) {
  const { ticker, market } = params;
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
  const balances = useMarketBalances(market);
  const userYesBal = balances.data?.yes ?? 0n;
  const userNoBal = balances.data?.no ?? 0n;
  const holdsYes = userYesBal > 0n;
  const holdsNo = userNoBal > 0n;
  const countdown = useCountdown(m?.expiryUnix);
  // Trading is closed once expiry passes (even if outcome is still Pending,
  // because the program rejects place_order / buy_no / sell_no / mint_pair
  // past expiry). Compute this once and gate all trade buttons on it so the
  // UI matches on-chain behavior.
  const isExpired = !!m?.expiryUnix && m.expiryUnix * 1000 <= Date.now();

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
        <div className="text-right">
          {m && m.outcome === "Pending" && (
            <div className="rounded-lg border border-panel bg-panel/40 px-3 py-2">
              <p className="text-xs uppercase tracking-wider text-muted">Settles in</p>
              <p className="font-mono text-lg">{countdown}</p>
            </div>
          )}
          {m && (
            <p className="mt-1 font-mono text-xs text-muted" title={market}>
              {market.slice(0, 6)}...{market.slice(-4)}
            </p>
          )}
        </div>
      </header>

      {/* Tx success / failure toast — prominent at top so users don't miss it.
          Dismissable; auto-clears 12s after the most recent change via the
          useEffect on lastSig/lastErr below. */}
      {(lastSig || lastErr) && (
        <div className="mb-6 flex items-start justify-between gap-4 rounded-2xl border border-accent/60 bg-accent/15 p-4">
          {lastSig && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-xl text-yes">✓</span>
              <div>
                <p className="font-semibold text-text">Transaction confirmed</p>
                <p className="text-xs text-muted">
                  <a className="text-accent underline" href={explorerTx(lastSig)} target="_blank" rel="noreferrer">
                    View on Solana Explorer →
                  </a>
                  <span className="ml-2 font-mono">{lastSig.slice(0, 10)}…{lastSig.slice(-6)}</span>
                </p>
              </div>
            </div>
          )}
          {lastErr && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-xl text-no">!</span>
              <div>
                <p className="font-semibold text-no">Transaction failed</p>
                <p className="break-words text-xs text-no/80">{lastErr}</p>
              </div>
            </div>
          )}
          <button
            onClick={() => { setLastSig(null); setLastErr(null); }}
            className="rounded p-1 text-muted hover:bg-panel hover:text-text"
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Payoff display (PRD §Key UI Elements) */}
      {m && m.outcome === "Pending" && (
        <section className="mb-6 rounded-2xl border border-accent/40 bg-accent/10 p-4 text-sm">
          <p className="text-muted">
            <span className="font-semibold text-text">For each Yes token: </span>
            you pay <span className="font-mono">$X</span> (the ask). You win{" "}
            <span className="font-mono">$1.00</span> if <span className="font-semibold">{ticker}</span>{" "}
            closes at or above <span className="font-mono">{formatUsdc(m.strikeUsd)}</span> at 16:00 ET today.
            Otherwise the token pays <span className="font-mono">$0.00</span>.
          </p>
          <p className="mt-1 text-muted">
            <span className="font-semibold text-text">For each No token: </span>
            you pay <span className="font-mono">$1.00 − Yes price</span>. You win{" "}
            <span className="font-mono">$1.00</span> if <span className="font-semibold">{ticker}</span>{" "}
            closes <span className="font-semibold">below</span>{" "}
            <span className="font-mono">{formatUsdc(m.strikeUsd)}</span>.
          </p>
        </section>
      )}

      {/* Position summary */}
      {publicKey && (
        <section className="mb-6 flex gap-3 text-sm">
          <span className="rounded-full bg-yes/20 px-3 py-1 text-yes">
            Yes: <span className="font-mono">{userYesBal.toString()}</span>
          </span>
          <span className="rounded-full bg-no/20 px-3 py-1 text-no">
            No: <span className="font-mono">{userNoBal.toString()}</span>
          </span>
          {(holdsYes || holdsNo) && (
            <span className="rounded-full bg-yellow-500/20 px-3 py-1 text-yellow-300">
              Position constraint: cannot Buy {holdsYes ? "No" : "Yes"} until you exit current position
            </span>
          )}
        </section>
      )}

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
                    {book.bids.slice(0, 10).map((b) => {
                      const mine = !!publicKey && b.owner === publicKey.toBase58();
                      return (
                        <li key={`${b.owner}-${b.sequence}`} className="flex items-center justify-between gap-2">
                          <span className={mine ? "text-yes font-semibold" : "text-yes"}>
                            {formatUsdc(b.priceUsd)}
                            {mine && <span className="ml-1 text-[10px] text-accent">(you)</span>}
                          </span>
                          <span className="text-muted">{b.qty.toString()}</span>
                          {mine && (
                            <button
                              disabled={busy !== null}
                              onClick={() => run("Cancel bid", () => trade.cancelOrder("bid", b.sequence))}
                              className="rounded bg-no/20 px-2 py-0.5 text-[10px] text-no hover:bg-no/30 disabled:opacity-40"
                              title="Cancel this bid and reclaim escrowed USDC"
                            >
                              ✕
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-xs uppercase text-no">Asks</h3>
                {book.asks.length === 0 ? (
                  <p className="text-sm text-muted">No asks.</p>
                ) : (
                  <ul className="space-y-1 font-mono text-sm">
                    {book.asks.slice(0, 10).map((a) => {
                      const mine = !!publicKey && a.owner === publicKey.toBase58();
                      return (
                        <li key={`${a.owner}-${a.sequence}`} className="flex items-center justify-between gap-2">
                          <span className={mine ? "text-no font-semibold" : "text-no"}>
                            {formatUsdc(a.priceUsd)}
                            {mine && <span className="ml-1 text-[10px] text-accent">(you)</span>}
                          </span>
                          <span className="text-muted">{a.qty.toString()}</span>
                          {mine && (
                            <button
                              disabled={busy !== null}
                              onClick={() => run("Cancel ask", () => trade.cancelOrder("ask", a.sequence))}
                              className="rounded bg-no/20 px-2 py-0.5 text-[10px] text-no hover:bg-no/30 disabled:opacity-40"
                              title="Cancel this ask and reclaim escrowed Yes tokens"
                            >
                              ✕
                            </button>
                          )}
                        </li>
                      );
                    })}
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

          {isExpired && (
            <div className="mb-3 rounded-lg border border-no/40 bg-no/10 p-3 text-xs text-no">
              <strong>Trading closed.</strong> This market expired and is awaiting settlement.
              You cannot place new orders or mint pairs. Once the automation crons run or admin_settle is
              called, the outcome will be set and you&apos;ll be able to <a className="underline" href="/portfolio">redeem any winning tokens</a>.
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              disabled={!trade.ready || busy !== null || holdsNo || isExpired}
              onClick={() => run("Buy Yes", () => trade.buyYes(priceTicks, qty))}
              className="rounded-lg bg-yes/20 px-3 py-2 font-semibold text-yes hover:bg-yes/30 disabled:opacity-40"
              title={isExpired ? "Market expired" : holdsNo ? "Sell your No position before buying Yes (PRD position constraint)" : ""}
            >
              {busy === "Buy Yes" ? "..." : "Buy Yes"}
            </button>
            <button
              disabled={!trade.ready || busy !== null || !bestBid || holdsYes || isExpired}
              onClick={() =>
                run("Buy No", () =>
                  trade.buyNo(qty, bestBid!.priceTicks, new PublicKey(bestBid!.owner)),
                )
              }
              className="rounded-lg bg-no/20 px-3 py-2 font-semibold text-no hover:bg-no/30 disabled:opacity-40"
              title={
                isExpired
                  ? "Market expired"
                  : holdsYes
                    ? "Sell your Yes position before buying No (PRD position constraint)"
                    : bestBid
                      ? `Will fill against bid @ ${formatUsdc(bestBid.priceUsd)}`
                      : "No bid available"
              }
            >
              {busy === "Buy No" ? "..." : "Buy No"}
            </button>
            <button
              disabled={!trade.ready || busy !== null || !holdsYes || isExpired}
              onClick={() => run("Sell Yes", () => trade.sellYes(priceTicks, qty))}
              className="rounded-lg bg-panel px-3 py-2 text-muted hover:bg-bg disabled:opacity-40"
              title={isExpired ? "Market expired" : !holdsYes ? "Need Yes tokens to sell" : ""}
            >
              {busy === "Sell Yes" ? "..." : "Sell Yes"}
            </button>
            <button
              disabled={!trade.ready || busy !== null || !bestAsk || !holdsNo || isExpired}
              onClick={() =>
                run("Sell No", () =>
                  trade.sellNo(qty, bestAsk!.priceTicks, new PublicKey(bestAsk!.owner)),
                )
              }
              className="rounded-lg bg-panel px-3 py-2 text-muted hover:bg-bg disabled:opacity-40"
              title={
                isExpired
                  ? "Market expired"
                  : !holdsNo
                    ? "Need No tokens to sell"
                    : bestAsk
                      ? `Will fill against ask @ ${formatUsdc(bestAsk.priceUsd)}`
                      : "No ask available"
              }
            >
              {busy === "Sell No" ? "..." : "Sell No"}
            </button>
          </div>

          <button
            disabled={!trade.ready || busy !== null || isExpired}
            onClick={() => run("Mint Pair", () => trade.mintPair(qty))}
            className="mt-3 w-full rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            {busy === "Mint Pair" ? "..." : `Mint ${qty} pair (deposit $${qty}.00 USDC)`}
          </button>

          {/* lastSig + lastErr now render in the prominent top-of-page toast. */}
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

"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";

import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { InfoTip } from "@/components/InfoTip";
import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets } from "@/hooks/useMarkets";
import { useTrade } from "@/hooks/useTrade";
import { useMarketBalances } from "@/hooks/useMarketBalances";
import { formatUsdc, type UsdcBase, usdcFromBase } from "@/lib/usdc";
import { queryKeys } from "@/lib/queryClient";
import { marketUiState } from "@/lib/marketSession";
import { useAfterHoursMode } from "@/lib/afterHoursMode";
import { cluster } from "@/lib/cluster";
import { useAdminMode } from "@/lib/adminMode";
import {
  AutomationApiError,
  postSettleMarket,
  type SettleMarketResult,
} from "@/lib/automationApi";

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
      } catch (err) {
        // Constitution §2.4: no catch-log-continue. Only the literal Anchor
        // "account does not exist" path is a legitimate null (book not yet
        // initialised for this market); every other failure (RPC outage,
        // decode error, IDL drift) must surface so the trade page does not
        // silently show "no liquidity" when the real problem is the network.
        // Mirrors the shared @/hooks/useOrderBookFor allowlist. This local
        // duplicate exists pre-refactor; a follow-up should delete it and
        // import the shared hook instead.
        const msg = err instanceof Error ? err.message : String(err);
        if (/Account does not exist|could not find account/i.test(msg)) {
          return null;
        }
        throw new Error(
          `TradePage.useOrderBookFor: failed to load order book for market ${marketPubkey} (book PDA ${bookPda.toBase58()}): ${msg}`,
          { cause: err instanceof Error ? err : undefined },
        );
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
  // Admin-only force-settle UI state. Kept distinct from the trade
  // `busy` / `lastSig` / `lastErr` triplet because settle is a separate
  // surface (admin server endpoint, not the user's wallet) and mixing
  // them would conflate user-facing trade toasts with admin debug toasts.
  const adminMode = useAdminMode();
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleResult, setSettleResult] = useState<SettleMarketResult | null>(null);
  const [settleErr, setSettleErr] = useState<string | null>(null);
  // Predicted balance delta for the most recent action ("+3 YES, +3 NO,
  // −$3 USDC"). Buttons set this when calling `run` so the confirmation
  // toast can tell the user exactly what changed, instead of forcing them
  // to mentally diff the position pills. Predicted, not measured: the
  // useMarketBalances refetch is ~3s and racy with the toast lifecycle, so
  // we use the known instruction shape + qty. Errors clear it. Refunds
  // (failed IOC, partial fill, etc.) would make a predicted delta wrong —
  // those paths bubble through `lastErr` and the predicted delta is wiped.
  const [lastDelta, setLastDelta] = useState<string | null>(null);

  const m = markets?.find((x) => x.pubkey === market);
  const balances = useMarketBalances(market);
  const userYesBal = balances.data?.yes ?? 0n;
  const userNoBal = balances.data?.no ?? 0n;
  const holdsYes = userYesBal > 0n;
  const holdsNo = userNoBal > 0n;
  const countdown = useCountdown(m?.expiryUnix);
  // Trading is closed once expiry passes. WTF heads-up: this is a UX-only
  // gate today. The on-chain `place_order`, `buy_no`, `sell_no`, and
  // `mint_pair` instructions do NOT currently check `market.expiry_unix`,
  // so a wallet that bypassed the UI could still submit those transactions
  // past expiry. Treat this gate as "what the product wants users to do",
  // not "what the program enforces". Follow-up task tracked in the project
  // tasks.md to add the on-chain check; until then, do not delete this
  // client-side gate. Also drives the settled-aware banner copy below.
  //
  // After-hours testing mode (header toggle) flips this off so the user can
  // exercise the real on-chain trading instructions against past-expiry
  // markets. AfterHoursBanner shows a persistent strip while the bypass is
  // active so the relaxed gate cannot be forgotten.
  const [afterHoursMode] = useAfterHoursMode();
  const expiryHasPassed = !!m?.expiryUnix && m.expiryUnix * 1000 <= Date.now();
  const isExpired = expiryHasPassed && !afterHoursMode;
  const uiState = m ? marketUiState(m) : null;
  const isSettled = uiState === "won-yes" || uiState === "won-no";

  function explorerTx(sig: string) {
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }

  // `delta` is an optional human-readable description of the expected
  // balance change ("+3 YES, +3 NO, −$3 USDC"). The confirmation toast
  // renders it so the user does not have to mentally diff pills. On
  // failure the delta is wiped because the wallet did not sign / the
  // tx was rejected / a partial-fill refund happened, and we do not
  // want a stale "+3 YES" message lingering.
  async function run(label: string, fn: () => Promise<string>, delta?: string) {
    if (!publicKey) {
      setLastErr("Connect a wallet first.");
      return;
    }
    setBusy(label);
    setLastErr(null);
    setLastSig(null);
    setLastDelta(null);
    try {
      const sig = await fn();
      setLastSig(sig);
      if (delta) setLastDelta(delta);
      // Refresh book + balances so the pills tick to the new values on
      // the next React Query interval (3s for balances, 2s for the book).
      void queryClient.invalidateQueries({ queryKey: queryKeys.orderBook(market) });
      void queryClient.invalidateQueries({ queryKey: ["market-balances", market, publicKey.toBase58()] });
    } catch (e) {
      setLastErr(e instanceof Error ? e.message : String(e));
      setLastDelta(null);
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
          {m && uiState && (
            <p className="text-muted">
              Strike <span className="font-mono">{formatUsdc(m.strikeUsd)}</span> ·{" "}
              {uiState === "open"
                ? "live"
                : uiState === "awaiting-settle"
                  ? "awaiting settlement"
                  : uiState === "won-yes"
                    ? "settled — Yes won"
                    : "settled — No won"}
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
                {lastDelta && (
                  // Predicted delta (not measured) — see the comment on
                  // `lastDelta` state. Surfacing it inline is the single
                  // biggest fix to the "I tapped mint pair and nothing
                  // visible changed" complaint, because the pills don't
                  // tick until the next 3s refetch window.
                  <p className="mt-0.5 font-mono text-sm text-yes">{lastDelta}</p>
                )}
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
            onClick={() => { setLastSig(null); setLastErr(null); setLastDelta(null); }}
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

      {/* Position summary.
          WTF heads-up: the pills below show the connected wallet's SPL token
          balances for THIS market — not order-book depth, not bids, not order
          counts. The "Your holdings" label is load-bearing because earlier
          versions just said "Yes: 3" and users reasonably read that as "3 open
          bids" or "3 of something else". Don't drop the label.
          Balances refresh on a 3s React Query interval (useMarketBalances). */}
      {publicKey && (
        <section className="mb-6 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs uppercase tracking-wider text-muted">
              Your holdings in this market:
            </span>
            <span className="rounded-full bg-yes/20 px-3 py-1 text-yes">
              YES tokens owned: <span className="font-mono font-semibold">{userYesBal.toString()}</span>
            </span>
            <span className="rounded-full bg-no/20 px-3 py-1 text-no">
              NO tokens owned: <span className="font-mono font-semibold">{userNoBal.toString()}</span>
            </span>
          </div>
          {/* Surface ALL active gates, not just one. The prior single-line
              constraint only ever named one side (`holdsYes ? "No" : "Yes"`),
              so a user holding BOTH sides saw "cannot Buy No" while Buy Yes
              was also blocked — silently. Listing every active reason is the
              fix. Book-liquidity gates (no bestBid / no bestAsk) belong here
              too because they disable Buy No / Sell No for non-position
              reasons that the user otherwise has no way to discover. */}
          {(holdsYes || holdsNo || !bestBid || !bestAsk || isExpired) && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-200">
              <p className="font-semibold text-yellow-100">Why some buttons are disabled:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {/*
                  Expired-market gate is listed FIRST because it disables
                  every trade button at once (including Mint Pair and
                  Redeem Pair), making it the most load-bearing reason
                  when it fires. Reported 2026-05-25 by a tester who
                  signed in as admin and could not figure out why mint
                  was dim — the constraint box only listed Buy No / Sell
                  No book-liquidity reasons even though every button was
                  disabled by `isExpired`. The branch on `adminMode`
                  surfaces the after-hours-toggle override path only to
                  visitors who actually have access to it; non-admins
                  get the wait-for-tomorrow guidance instead, because
                  the toggle is gated on admin sign-in via
                  `useAfterHoursMode`'s admin AND-gate.
                */}
                {isExpired && (
                  <li>
                    <span className="font-semibold">All trade buttons</span> (Buy Yes, Buy No, Sell Yes, Sell No,
                    Mint Pair, Redeem Pair) are disabled because this market is past its 16:00 ET expiry and is
                    awaiting settlement.{" "}
                    {adminMode ? (
                      <>
                        To bypass for testing, click the <span className="font-mono">🧪 DEV</span> pill in the header
                        and flip <em>Bypass UI expiry gates</em> to ON. The on-chain program accepts these
                        instructions 24/7; only the UI hides them past expiry.
                      </>
                    ) : (
                      <>
                        Visit a market that has not yet expired, or wait for the morning cron at 08:00 ET to create
                        today&apos;s strikes.
                      </>
                    )}
                  </li>
                )}
                {holdsNo && (
                  <li>
                    <span className="font-semibold">Buy Yes</span> is disabled because you already hold NO tokens.
                    Sell your NO position first (or wait for settlement + redeem).
                  </li>
                )}
                {holdsYes && (
                  <li>
                    <span className="font-semibold">Buy No</span> is disabled because you already hold YES tokens.
                    Sell your YES position first (or wait for settlement + redeem).
                  </li>
                )}
                {!bestBid && (
                  <li>
                    <span className="font-semibold">Buy No</span> also needs at least one resting BID on the YES side
                    of the order book (it atomically mints a pair and sells the YES into that bid).
                    Currently the book has no bids.
                  </li>
                )}
                {!bestAsk && (
                  <li>
                    <span className="font-semibold">Sell No</span> needs at least one resting ASK on the YES side
                    of the order book (it atomically buys YES from that ask, then redeems the pair).
                    Currently the book has no asks.
                  </li>
                )}
              </ul>
              {(holdsYes || holdsNo) && (
                <p className="mt-2 text-yellow-200/70">
                  Why the position constraint exists: holding both sides at once is economically a no-op
                  (each YES+NO pair pays exactly $1 at settlement regardless of outcome), so the product blocks
                  you from accidentally minting more.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {/*
        Cluster-mismatch banner. Renders only when the connected wallet
        has 0 lamports on the site's RPC, the single signal we can
        observe without the wallet extension's cooperation. See the WTF
        on `showClusterMismatchBanner` for why this is the only reliable
        heuristic and why we deliberately enumerate both plausible
        causes (genuine zero balance + wrong cluster) instead of
        claiming to know which one is in play. Placed above the
        order-book + trade panel grid so a user about to click a buy
        button sees it in the same scroll position as the buttons.
        Does NOT block the buttons — the on-chain refusal (or the
        Phantom popup's own "not enough SOL") remains authoritative.
      */}
      {showClusterMismatchBanner && (
        <section
          role="alert"
          className="mb-6 rounded-2xl border border-no/50 bg-no/10 p-4 text-sm"
        >
          <p className="font-semibold text-no">
            Your wallet shows 0 SOL on {cluster.name}. Transactions will fail with &quot;not
            enough SOL&quot; until this is resolved.
          </p>
          <p className="mt-2 text-no/90">
            Two possible causes. The site cannot tell which one applies because the Solana
            Wallet Standard does not expose your wallet&apos;s selected cluster.
          </p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-text">
            <li>
              <span className="font-semibold">Your wallet extension is on a different cluster
                (most common after a fresh install).</span>{" "}
              Phantom defaults to Mainnet; Meridian runs on {cluster.name}. Open the
              extension, go to <span className="font-mono">Settings → Developer Settings →
                Testnet Mode ON</span>, then pick <span className="font-mono">{cluster.name}</span>{" "}
              from the network selector. Address stays the same; only the cluster filter
              changes.
            </li>
            <li>
              <span className="font-semibold">Your wallet genuinely has 0 SOL on {cluster.name}.</span>{" "}
              Visit{" "}
              <a
                href="https://faucet.solana.com"
                target="_blank"
                rel="noreferrer"
                className="text-accent underline"
              >
                faucet.solana.com
              </a>
              , paste your wallet address, request 1 SOL. Free, used for transaction fees only.
            </li>
          </ol>
          <p className="mt-2 text-xs text-muted">
            This banner clears automatically once your wallet&apos;s {cluster.name} SOL balance
            goes above zero.
          </p>
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

          {/* Without a wallet, no instruction in this panel can sign — the
              buy/sell/mint handlers all bail on `if (!publicKey) ...`. Render
              a prominent connect CTA in place of the form so the user has
              exactly one obvious next action, instead of grey buttons + a
              small yellow note that ask them to find a separate header
              button. The form re-renders once `publicKey` is set. */}
          {!publicKey && (
            <div className="mb-1 rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm">
              <p className="mb-2 font-semibold text-text">Connect a wallet to mint, buy, or sell</p>
              <p className="mb-3 text-xs text-muted">
                Trading goes directly to the Solana devnet program — every action requires a
                signature. Set your Phantom or Solflare wallet to Devnet, then click below.
                Click the DEVNET pill in the header for click-by-click instructions for your wallet.
              </p>
              <ConnectWalletButton className="h-10 text-sm" />
            </div>
          )}

          {publicKey && (
            <>
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

          {isSettled && m && (
            <div className="mb-3 rounded-lg border border-yes/40 bg-yes/10 p-3 text-xs">
              <p className="mb-1 font-semibold text-text">
                Market settled — {uiState === "won-yes" ? "Yes won" : "No won"}.
              </p>
              <p className="text-muted">
                Closing price{" "}
                <span className="font-mono">{formatUsdc(m.closingPriceUsd)}</span>{" "}
                {uiState === "won-yes" ? "≥" : "<"}{" "}
                <span className="font-mono">{formatUsdc(m.strikeUsd)}</span> (strike). Each{" "}
                {uiState === "won-yes" ? "Yes" : "No"} token pays $1.00; the losing side pays $0.00.{" "}
                <a className="underline text-accent" href="/portfolio">
                  Redeem winning tokens →
                </a>
              </p>
            </div>
          )}
          {isExpired && !isSettled && (
            <div className="mb-3 rounded-lg border border-accent/40 bg-accent/10 p-3 text-xs">
              <p className="mb-1 font-semibold text-text">Trading closed — awaiting settlement.</p>
              <p className="text-muted">
                This market is past its 16:00 ET expiry. The settle cron runs at 16:05 ET and reads
                the on-chain Pyth feed to set the outcome; admin_settle is the fallback if Pyth is
                stale beyond 60 minutes. The 30-second expiry-sweep cron picks up custom (non-daily-
                ladder) markets at any time, including weekends and US market holidays. Existing
                positions are safe and will be redeemable once the outcome is recorded. New orders
                and pair mints are blocked client-side until then (the on-chain program does not yet
                enforce the expiry gate, so a sufficiently determined wallet could bypass this UI —
                tracked in tasks.md).
              </p>
              {/* Admin-only force-settle. Surfaces when the auto-sweep cron is
                  stale (most often: the deployed automation Render service is
                  on an older commit that lacks the expiry-sweep job, or both
                  the Pyth path AND settle_market_manual fallback have been
                  failing since expiry). The on-chain admin keypair lives on
                  the automation server; this button POSTs to its
                  /admin/settle-market endpoint, which signs Pyth-primary then
                  settle_market_manual-fallback the same way the sweep would.
                  Result/error rendered immediately below so the admin can
                  copy the explorer link or read the failure verbatim. */}
              {adminMode && m && m.outcome === "Pending" && (
                <div className="mt-3 border-t border-accent/20 pt-2">
                  <button
                    type="button"
                    disabled={settleBusy}
                    onClick={async () => {
                      setSettleBusy(true);
                      setSettleErr(null);
                      setSettleResult(null);
                      try {
                        const result = await postSettleMarket({ marketPubkey: market });
                        setSettleResult(result);
                        // Trigger an immediate market+balance refetch so the
                        // banner flips from awaiting-settle to settled
                        // without waiting for the React Query interval.
                        // Prefix-match on ["markets"] because the per-day
                        // key is ["markets", tradingDay] and we do not
                        // know the trading-day value here. React Query
                        // matches on prefix when given a partial key.
                        void queryClient.invalidateQueries({
                          queryKey: ["markets"],
                        });
                        void queryClient.invalidateQueries({
                          queryKey: queryKeys.market(market),
                        });
                      } catch (err) {
                        if (err instanceof AutomationApiError) {
                          setSettleErr(
                            `Settle failed [${err.slug} / HTTP ${err.status}]: ${err.message}`,
                          );
                        } else {
                          setSettleErr(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                      } finally {
                        setSettleBusy(false);
                      }
                    }}
                    className="w-full rounded-lg border border-accent/50 bg-accent/20 px-3 py-2 text-xs font-semibold text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
                    title="Calls the automation server's /admin/settle-market endpoint, which signs settle_market (Pyth) or settle_market_manual (fallback) with the on-chain admin keypair."
                  >
                    {settleBusy
                      ? "Settling — posting Pyth price-update + settle ix..."
                      : "Force-settle this market now (admin)"}
                  </button>
                  {settleResult && (
                    <div className="mt-2 rounded-md border border-yes/40 bg-yes/10 p-2 text-[11px]">
                      <p className="font-semibold text-yes">
                        Settled via {settleResult.settledVia === "pyth" ? "Pyth on-chain" : "settle_market_manual (Hermes last-known)"}.
                      </p>
                      <p className="mt-0.5 font-mono text-text">
                        Closing price: ${(Number(settleResult.closingPriceMicros) / 1_000_000).toFixed(6)}
                      </p>
                      <p className="mt-0.5">
                        <a
                          className="text-accent underline"
                          href={`https://explorer.solana.com/tx/${settleResult.sig}?cluster=${cluster.name}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View settle tx on Solana Explorer →
                        </a>
                      </p>
                      <p className="mt-1 text-muted">
                        Reload the page to see the won-yes / won-no banner and the asymmetric Redeem button on /portfolio.
                      </p>
                    </div>
                  )}
                  {settleErr && (
                    <p className="mt-2 break-words rounded-md border border-no/40 bg-no/10 p-2 text-[11px] text-no">
                      {settleErr}
                    </p>
                  )}
                  <p className="mt-1 text-[10px] text-muted">
                    For users: minting a pair (above) deposits $1.00 USDC and gives you 1 YES + 1 NO.
                    To mint, you need devnet USDC — Redeem hint links to{" "}
                    <a
                      className="text-accent underline"
                      href={cluster.faucetUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      the Circle faucet
                    </a>
                    .
                  </p>
                </div>
              )}
            </div>
          )}
          {/* Trade buttons.
              WTF heads-up on the disabled styling: every button gets BOTH
              opacity-40 AND a forced color override (`disabled:bg-panel/40
              disabled:text-muted disabled:border-panel`). Earlier styling
              kept the colored background/text under `disabled:opacity-40`
              alone, so a 40%-dimmed-but-still-green Buy Yes button looked
              identical to an enabled-but-pale Buy Yes button. The full
              color stripping makes "you cannot click this" unambiguous at
              a glance, without needing to hover for the title attribute.
              `cursor-not-allowed` reinforces the affordance.
              Reasons live in the constraints box above the form, NOT only
              in hover tooltips — so a user on a touch device still sees
              the why.
              Each button is wrapped in a `relative` div so its InfoTip
              icon can absolutely position into the button's top-right
              corner. The InfoTip popover explains the on-chain mechanism
              (especially important for Buy No / Sell No, which look like
              symmetric NO orders but actually mint or burn a pair under
              the hood). Top-row buttons get side="top" (popover above)
              and bottom-row get side="bottom" (popover below) so the
              popover never overlaps the other row of buttons. */}
          <div className="grid grid-cols-2 gap-2">
            <div className="relative">
              <button
                disabled={!trade.ready || busy !== null || holdsNo || isExpired}
                onClick={() => run("Buy Yes", () => trade.buyYes(priceTicks, qty), `+${qty} YES (resting bid at ${priceTicks}¢)`)}
                className="w-full rounded-lg bg-yes/20 px-3 py-2 font-semibold text-yes hover:bg-yes/30 disabled:cursor-not-allowed disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
                title={isExpired ? "Market expired" : holdsNo ? "Sell your No position before buying Yes (PRD position constraint)" : ""}
              >
                {busy === "Buy Yes" ? "..." : "Buy Yes"}
              </button>
              <InfoTip
                title="How Buy Yes works"
                side="top"
                className="absolute right-1.5 top-1.5 text-yes"
              >
                <p>
                  Posts a resting limit <strong>BID</strong> on the YES order book at your chosen price (cents).
                  Escrows your USDC into the book&apos;s <code className="text-indigo-300">usdc_escrow</code>.
                </p>
                <p>
                  Fills when a matching ASK appears and the permissionless cranker crosses them via{" "}
                  <code className="text-indigo-300">match_orders</code> (usually within one ~400ms slot).
                  Cancel returns your escrowed USDC any time before fill.
                </p>
                <p className="text-[10px] text-slate-500">
                  v1 has no IOC mode on <code>place_order</code>; immediate-take is achieved by posting at
                  the current best ask and letting the cranker cross.
                </p>
              </InfoTip>
            </div>
            <div className="relative">
              <button
                disabled={!trade.ready || busy !== null || !bestBid || holdsYes || isExpired}
                onClick={() =>
                  run(
                    "Buy No",
                    () => trade.buyNo(qty, bestBid!.priceTicks, new PublicKey(bestBid!.owner)),
                    bestBid ? `+${qty} NO (paid ~$${((100 - bestBid.priceTicks) / 100).toFixed(2)} each)` : `+${qty} NO`,
                  )
                }
                className="w-full rounded-lg bg-no/20 px-3 py-2 font-semibold text-no hover:bg-no/30 disabled:cursor-not-allowed disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
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
              <InfoTip
                title="How Buy No actually works"
                side="top"
                className="absolute right-1.5 top-1.5 text-no"
              >
                <p>
                  <strong>There is no separate NO order book.</strong> Buy No is the atomic{" "}
                  <code className="text-indigo-300">buy_no</code> instruction. In one signed transaction it
                  (1) deposits $1 per token of USDC into the vault, (2) mints a fresh YES+NO pair to your
                  wallet, (3) immediately transfers the freshly-minted YES to the single best resting
                  YES bidder on the book. You keep the NO.
                </p>
                <p>
                  The fill consumes the entire quantity from <code className="text-indigo-300">bids[0]</code>{" "}
                  alone (no slab walk). If depth is insufficient, or the bid price is below your slippage
                  floor (= <span className="font-mono">100 − target_no_price</span>), the entire transaction
                  reverts with <code className="text-indigo-300">IocPartialFillRejected</code> and no tokens move.
                </p>
                <p>
                  Net cost per NO = <span className="font-mono">$1.00 − filled_bid_price</span>. You may pay
                  less than your floor if the resting bid is richer.
                </p>
              </InfoTip>
            </div>
            <div className="relative">
              <button
                disabled={!trade.ready || busy !== null || !holdsYes || isExpired}
                onClick={() => run("Sell Yes", () => trade.sellYes(priceTicks, qty), `−${qty} YES into escrow (limit ask ${priceTicks}¢)`)}
                className="w-full rounded-lg border border-yes/40 bg-panel px-3 py-2 font-semibold text-yes hover:bg-yes/10 disabled:cursor-not-allowed disabled:border-panel disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
                title={isExpired ? "Market expired" : !holdsYes ? "Need Yes tokens to sell" : ""}
              >
                {busy === "Sell Yes" ? "..." : "Sell Yes"}
              </button>
              <InfoTip
                title="How Sell Yes works"
                side="bottom"
                className="absolute right-1.5 top-1.5 text-yes"
              >
                <p>
                  Posts a resting limit <strong>ASK</strong> on the YES order book at your chosen price.
                  Escrows your YES tokens into <code className="text-indigo-300">yes_escrow</code>.
                </p>
                <p>
                  Fills when a matching BID appears and the cranker crosses them via{" "}
                  <code className="text-indigo-300">match_orders</code>. Cancel returns your escrowed YES
                  any time before fill.
                </p>
              </InfoTip>
            </div>
            <div className="relative">
              <button
                disabled={!trade.ready || busy !== null || !bestAsk || !holdsNo || isExpired}
                onClick={() =>
                  run(
                    "Sell No",
                    () => trade.sellNo(qty, bestAsk!.priceTicks, new PublicKey(bestAsk!.owner)),
                    bestAsk ? `−${qty} NO (received ~$${((100 - bestAsk.priceTicks) / 100).toFixed(2)} each)` : `−${qty} NO`,
                  )
                }
                className="w-full rounded-lg border border-no/40 bg-panel px-3 py-2 font-semibold text-no hover:bg-no/10 disabled:cursor-not-allowed disabled:border-panel disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
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
              <InfoTip
                title="How Sell No actually works"
                side="bottom"
                className="absolute right-1.5 top-1.5 text-no"
              >
                <p>
                  <strong>There is no separate NO order book.</strong> Sell No is the atomic{" "}
                  <code className="text-indigo-300">sell_no</code> instruction. In one signed transaction it
                  (1) pays the single best resting YES ASK in USDC, (2) receives that YES from{" "}
                  <code className="text-indigo-300">yes_escrow</code> transiently, (3) burns your YES + NO pair,
                  (4) releases $1 per token from the vault to you.
                </p>
                <p>
                  The fill consumes the entire quantity from <code className="text-indigo-300">asks[0]</code>{" "}
                  alone (no slab walk). If depth is insufficient, or the ask price is above your slippage
                  ceiling (= <span className="font-mono">100 − target_no_proceeds</span>), the entire
                  transaction reverts.
                </p>
                <p>
                  Net proceeds per NO = <span className="font-mono">$1.00 − filled_ask_price</span>. Your
                  existing NO is burned (not transferred to another wallet); the buyer of NO somewhere
                  else on the network would have minted theirs fresh via <code>buy_no</code>.
                </p>
              </InfoTip>
            </div>
          </div>

          <button
            disabled={!trade.ready || busy !== null || isExpired}
            onClick={() => run("Mint Pair", () => trade.mintPair(qty), `+${qty} YES, +${qty} NO, −$${qty}.00 USDC`)}
            className="mt-3 w-full rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:border-panel disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
          >
            {busy === "Mint Pair" ? "..." : `Mint ${qty} pair (deposit $${qty}.00 USDC)`}
          </button>

          {/* Redeem Pair — inverse of Mint Pair. Pre-settlement only.
              Disabled unless the user holds at least `qty` of BOTH YES and
              NO (you cannot burn a pair you do not have both halves of).
              On settled markets the on-chain redeem_pair errors with
              MarketAlreadySettled, so we gate it client-side on isSettled
              too — and direct the user to the asymmetric redeem flow on
              the portfolio page. Without this button the only pre-settle
              exit was "sell into the book", which fails when the book is
              empty (the case that produced the original "$3 stuck"
              complaint). The redeemable pair count is min(YES, NO);
              showing it on the label removes the "wait, how many can I
              redeem" friction. */}
          {(() => {
            const pairBal = userYesBal < userNoBal ? userYesBal : userNoBal;
            const pairBalNum = Number(pairBal);
            const wantsMore = BigInt(qty) > pairBal;
            const redeemDisabled =
              !trade.ready || busy !== null || isExpired || isSettled || pairBal === 0n || wantsMore;
            const settledHint = isSettled
              ? "Market is settled — go to Portfolio and redeem the winning side instead."
              : pairBal === 0n
                ? "You don't hold a YES+NO pair on this market."
                : wantsMore
                  ? `Only ${pairBalNum} pair${pairBalNum === 1 ? "" : "s"} available (limited by the smaller of your YES / NO balance).`
                  : "";
            // "Get more" affordance: surfaced ONLY in the no-pair / want-more
            // cases (settled markets redirect to Portfolio instead). On
            // devnet the path to a redeemable pair is: devnet USDC from the
            // Circle faucet → Mint Pair on this same page. On mainnet there
            // is no faucet — the user has to fund the wallet from an
            // off-ramp / exchange, so we link to a dedicated /onramp page
            // (which today does not exist; pending mainnet bring-up the link
            // surfaces the intent so users have a single discoverable next
            // step instead of guessing). The cluster.name switch keeps the
            // copy honest — never advertise a faucet on a mainnet build.
            const showGetMore = !isSettled && (pairBal === 0n || wantsMore);
            const onDevnet = cluster.name === "devnet";
            const getMoreHref = onDevnet ? cluster.faucetUrl : "/onramp";
            const getMoreLabel = onDevnet
              ? "Get devnet USDC from the faucet, then Mint Pair above →"
              : "Add USDC to your wallet, then Mint Pair above →";
            return (
              <>
                <button
                  disabled={redeemDisabled}
                  onClick={() =>
                    run("Redeem Pair", () => trade.redeemPair(qty), `−${qty} YES, −${qty} NO, +$${qty}.00 USDC`)
                  }
                  className="mt-2 w-full rounded-lg border border-accent/40 bg-panel px-3 py-2 text-sm font-semibold text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:border-panel disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
                  title={settledHint}
                >
                  {busy === "Redeem Pair"
                    ? "..."
                    : `Redeem ${qty} pair → $${qty}.00 USDC (you have ${pairBalNum} redeemable)`}
                </button>
                {showGetMore && (
                  <a
                    href={getMoreHref}
                    target={onDevnet ? "_blank" : undefined}
                    rel={onDevnet ? "noreferrer" : undefined}
                    className="mt-1 block text-right text-[11px] text-accent underline decoration-accent/40 underline-offset-2 hover:text-accentHover"
                    title={
                      onDevnet
                        ? "Opens the Circle devnet USDC faucet in a new tab. Paste your wallet address, request USDC, then come back and Mint Pair."
                        : "Add USDC to your wallet, then Mint Pair to create redeemable pairs."
                    }
                  >
                    {getMoreLabel}
                  </a>
                )}
              </>
            );
          })()}

          {/* lastSig + lastErr now render in the prominent top-of-page toast. */}
            </>
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
          <li>
            <span className="text-accent">Redeem Pair</span>: burn <code>{qty} Yes</code> + <code>{qty} No</code>, recover <code>{qty} USDC</code> from the vault. Inverse of Mint Pair. Pre-settlement only — once the market settles, use the asymmetric Redeem on the Portfolio page (winner pays $1, loser pays $0).
          </li>
        </ul>
      </section>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";

import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { DisabledHint } from "@/components/DisabledHint";
import { InfoTip } from "@/components/InfoTip";
import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets } from "@/hooks/useMarkets";
import { useTrade, deriveMarketAddresses, TradeTxError, type TradeTxHero } from "@/hooks/useTrade";
import { useMarketBalances } from "@/hooks/useMarketBalances";
import { useSolBalance } from "@/hooks/useSolBalance";
import { formatUsdc, type UsdcBase, usdcFromBase } from "@/lib/usdc";
import { queryKeys } from "@/lib/queryClient";
import { marketUiState } from "@/lib/marketSession";
import { useAfterHoursMode } from "@/lib/afterHoursMode";
import { cluster, explorerAddressUrl, explorerTxUrl } from "@/lib/cluster";
import { useAdminMode } from "@/lib/adminMode";
import {
  AutomationApiError,
  postInitOrderBook,
  postSettleMarket,
  type InitOrderBookResult,
  type SettleMarketResult,
} from "@/lib/automationApi";

// Short, deterministic error ID for failure toasts. We want two
// properties from this hash:
//   1. Stable for an identical payload: the same wallet hitting the same
//      revert produces the same short ID, so a user can grep server
//      logs by it without ambiguity.
//   2. Short enough to read aloud / paste into Slack (8 hex chars =
//      32 bits of entropy ≈ 4.3 billion distinct IDs). Collisions are
//      acceptable in a debug context; the FULL error payload is also
//      written to the browser console under the same ID so the
//      operator can disambiguate by reading the console alongside.
// Uses a FNV-1a 32-bit hash because it is purpose-built for short
// strings, requires no dependencies, and produces zero allocations in
// the hot path. SHA-256 from WebCrypto is overkill for an in-memory
// correlation ID and is async, which would force the failure-toast
// render path through a useEffect dance for no gain.
function hashForErrorId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // Bit-shift the FNV prime into the hash; the >>> 0 keeps the
    // result a 32-bit unsigned integer despite JS's signed bitwise
    // semantics.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

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
  const { publicKey, sendTransaction } = useWallet();
  const trade = useTrade(market);
  const queryClient = useQueryClient();

  const [qty, setQty] = useState(1);
  const [priceTicks, setPriceTicks] = useState(50);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [lastErr, setLastErr] = useState<string | null>(null);
  // Short hash of the last error payload (8 hex chars). Surfaced in the
  // failure toast so the user can paste it into Slack / a support
  // request, and we can correlate it with the full error written to
  // window.console. See `hashForErrorId` above for the algorithm.
  const [lastErrId, setLastErrId] = useState<string | null>(null);
  // Program logs captured from a failed simulation (via TradeTxError.logs).
  // Surfaced beneath the toast in a collapsible <details> so the user can
  // copy the on-chain trace into a support request without having to open
  // devtools. Cleared on dismiss and on next action.
  const [lastErrLogs, setLastErrLogs] = useState<readonly string[] | null>(null);
  // Failure-kind discriminator from TradeTxError. Drives the remediation
  // copy in the toast (e.g. "reconnect your wallet" for
  // wallet_session_stale vs "initialize the order book" for
  // simulation_reverted with the specific log signature).
  const [lastErrKind, setLastErrKind] = useState<TradeTxError["kind"] | "unknown" | null>(null);
  // Parsed hero block (headline + detail + optional CTA). Populated when
  // simulateAndSend attaches a recognized Anchor error variant. Drives
  // the new clean toast layout; the raw program logs (lastErrLogs) get
  // hidden inside a collapsible "Technical details" disclosure when
  // a hero is present, since they're redundant for the happy diagnostic
  // case (InsufficientBalance + balance numbers, MarketAlreadySettled,
  // etc.) and only useful when the hero is absent or vague.
  const [lastErrHero, setLastErrHero] = useState<TradeTxHero | null>(null);
  // Toggle for the collapsible technical-details block beneath the toast.
  const [errDetailsExpanded, setErrDetailsExpanded] = useState(false);
  // (Removed 2026-05-26.) Was: const [disabledReasonsExpanded, ...] = useState(false).
  // Drove the open/closed state of the consolidated "Why some buttons
  // are disabled" panel. The panel itself was replaced by per-button
  // DisabledHint lines rendered directly underneath each disabled
  // button, so no consumer remains.
  // Repair-book state. Distinct from the trade `busy` / `lastSig` /
  // `lastErr` triplet because the repair flow targets a different
  // surface (the automation server's /admin/init-order-book endpoint)
  // and conflating its state with trade-tx state would render the toast
  // for the wrong action.
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairResult, setRepairResult] = useState<InitOrderBookResult | null>(null);
  const [repairErr, setRepairErr] = useState<string | null>(null);
  // Step label so the user sees granular progress through the chained
  // repair flow ("Reading admin pubkey → Funding admin → Initializing
  // book"). Empty string means idle. Without this the button looks
  // frozen for ~15-25s while the chained tx + RPC calls happen.
  const [repairStep, setRepairStep] = useState<string>("");
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

  // Cluster-mismatch detection. The wallet extension and the SITE'S RPC
  // each have their own view of "is this wallet funded". Phantom defaults
  // to Mainnet; Meridian's RPC is Devnet. If the user hydrated Devnet via
  // faucet but Phantom is still on Mainnet, the wallet popup will reject
  // every transaction with "You don't have enough SOL" — even though the
  // address has plenty on Devnet — because Phantom checks its own cluster
  // view (0 SOL on Mainnet) when validating. The Wallet Standard does not
  // expose the wallet's selected cluster (Phantom blocks that as a
  // fingerprinting vector), so we infer mismatch from a single signal:
  // the SITE's RPC reports 0 lamports for a connected wallet.
  //
  // Two reasons this signal fires: (a) the user genuinely has 0 SOL on
  // the site's cluster (never airdropped) — covered by the same banner
  // copy below pointing at faucet.solana.com; (b) the wallet is on a
  // different cluster — also covered, pointing at the extension's
  // network switcher. The banner is informational and never blocks
  // the trade buttons; we let the wallet popup remain the authoritative
  // refusal surface so the on-chain check (which we cannot replicate
  // client-side without trusting Phantom's view) stays sovereign.
  const solBalance = useSolBalance(publicKey?.toBase58());
  // showClusterMismatchBanner is true when we are CONFIDENT the user
  // sees 0 SOL on the site's cluster. We do not show it while the query
  // is loading or errored — that would spam the banner on every page
  // load before the RPC responds. `data` only resolves to a SolBalance
  // when getBalance succeeded.
  const showClusterMismatchBanner =
    !!publicKey && solBalance.isSuccess && solBalance.data.lamports === 0n;

  // Derive the user's YES + NO ATAs once per render so the pills can link
  // out to Solana Explorer ("see for yourself" — the on-chain proof that
  // the pill's number is exactly what the chain says). `program` is the
  // typed Anchor client; `market` is the market PDA string from the URL.
  //
  // Why compute it here (vs in useMarketBalances): the ATA is a pure
  // function of (mint, owner). We do NOT want to bolt the URL onto the
  // balance hook's return value because that hook is also used in places
  // (header constraint box) where the explorer link is irrelevant. Keep
  // the URL builder at the call site where it's needed.
  //
  // The deriveMarketAddresses + getAssociatedTokenAddressSync calls are
  // sync and cheap (no RPC); safe to re-do every render.
  const { program } = useMeridian();
  const userTokenAtas =
    publicKey && market
      ? (() => {
          try {
            const addrs = deriveMarketAddresses(program.programId, new PublicKey(market));
            return {
              yesAta: getAssociatedTokenAddressSync(addrs.yesMint, publicKey).toBase58(),
              noAta: getAssociatedTokenAddressSync(addrs.noMint, publicKey).toBase58(),
              yesMint: addrs.yesMint.toBase58(),
              noMint: addrs.noMint.toBase58(),
            };
          } catch {
            // Invalid market PDA string. The page's "market not found" branch
            // below already handles this; don't crash the render here.
            return null;
          }
        })()
      : null;

  // OrderBook PDA, derived once per render. Each bid / ask row links to
  // this account on Solana Explorer so a user can click straight through
  // from the visual book to the raw on-chain account that physically
  // stores the zero-copy order data — the transparency-of-inner-workings
  // rule in CLAUDE.md. Pure function of programId + market, no RPC; safe
  // to re-derive every render. `null` when the market pubkey is invalid;
  // the "market not found" branch upstream already handles that, but we
  // guard anyway so this hook never throws during render.
  const orderBookPda: string | null = market
    ? (() => {
        try {
          return deriveMarketAddresses(program.programId, new PublicKey(market)).orderBook.toBase58();
        } catch {
          return null;
        }
      })()
    : null;

  // `delta` is an optional human-readable description of the expected
  // balance change ("+3 YES, +3 NO, −$3 USDC"). The confirmation toast
  // renders it so the user does not have to mentally diff pills. On
  // failure the delta is wiped because the wallet did not sign / the
  // tx was rejected / a partial-fill refund happened, and we do not
  // want a stale "+3 YES" message lingering.
  async function run(label: string, fn: () => Promise<string>, delta?: string) {
    if (!publicKey) {
      setLastErr("Connect a wallet first.");
      setLastErrId(null);
      setLastErrKind("wallet_session_stale");
      setLastErrLogs(null);
      return;
    }
    setBusy(label);
    setLastErr(null);
    setLastErrId(null);
    setLastErrKind(null);
    setLastErrLogs(null);
    setLastErrHero(null);
    setErrDetailsExpanded(false);
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
      // Capture the FULL error verbatim for the console (so an operator
      // with devtools can grep it), and derive a short 8-hex correlation
      // ID for the on-screen toast. The user-facing message stays
      // human-readable; the long stack/RPC verbatim never collides with
      // the toast layout.
      //
      // Branch on TradeTxError so the toast renders the most useful
      // shape: the typed message + remediation hint for kind, the
      // program logs for simulation_reverted, etc. For untyped errors
      // (anything not from useTrade's simulateAndSend funnel) we fall
      // through to .message.
      const fullText = e instanceof Error ? (e.stack ?? e.message) : String(e);
      const errId = hashForErrorId(`${label}|${publicKey.toBase58()}|${market}|${fullText}`);
      // Use name-based check ALONGSIDE instanceof so a duplicate-module
      // hoisting (pnpm sometimes ships two copies of internal modules)
      // can't make this catch silently lose the typed shape.
      const isTradeTx =
        e instanceof TradeTxError ||
        (e instanceof Error && e.name === "TradeTxError");
      if (isTradeTx) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx = e as any;
        setLastErr(`${label} failed: ${tx.message}`);
        setLastErrKind(tx.kind ?? "unknown");
        setLastErrLogs(Array.isArray(tx.logs) ? tx.logs : null);
        setLastErrHero(tx.hero ?? null);
      } else {
        const shortMessage = e instanceof Error ? e.message : String(e);
        setLastErr(shortMessage);
        setLastErrKind("unknown");
        setLastErrLogs(null);
        setLastErrHero(null);
      }
      setErrDetailsExpanded(false);
      setLastErrId(errId);
      console.error(
        `[meridian trade] action="${label}" errId=${errId} market=${market} wallet=${publicKey.toBase58()}`,
        e,
      );
      setLastDelta(null);
      // Auto-scroll the failure toast into view. The toast renders at
      // the top of the page (above the order book / trade panel); on a
      // short laptop or after the user has scrolled down to interact
      // with the trade buttons, the toast appears OFF-screen and the
      // user sees "nothing happened" instead of "Transaction failed."
      // This was the entire user-reported failure mode for the
      // redeem_pair-IDL-stale bug on 2026-05-26 — the toast WAS firing
      // (`r.methods.redeemPair is not a function`) but the user was
      // scrolled down in the trade panel. `requestAnimationFrame` so
      // the new toast has committed to the DOM before we scroll to it.
      if (typeof window !== "undefined") {
        requestAnimationFrame(() => {
          document.getElementById("trade-failure-toast")?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      }
    } finally {
      setBusy(null);
    }
  }

  const bestBid = book?.bids[0];
  const bestAsk = book?.asks[0];
  // Self-matching guards. buy_no / sell_no are atomic mint-pair + IOC-sell
  // (or IOC-buy + redeem-pair) against the BEST counterparty. If the best
  // counterparty is the caller themselves, the SPL transfers become same-ATA
  // no-ops and the caller ends up holding BOTH halves of a pair when they
  // only wanted ONE side. The on-chain program rejects this since the
  // SelfMatchingForbidden patch on 2026-05-26, but disabling the buttons
  // client-side spares the user a wasted signature and a confusing toast
  // when the issue is plainly visible from the book.
  // `bestBidIsSelf` / `bestAskIsSelf` are `null` when there's no counterparty
  // OR the wallet isn't connected, so the disabled-condition truthy check
  // below stays correct for both states without extra branches.
  const bestBidIsSelf = bestBid && publicKey ? bestBid.owner === publicKey.toBase58() : false;
  const bestAskIsSelf = bestAsk && publicKey ? bestAsk.owner === publicKey.toBase58() : false;
  // Book PDA missing? `useOrderBookFor` returns `null` (distinct from
  // `undefined` while loading) when the account does not exist on
  // chain. In that state EVERY order-book instruction
  // (place_order / buy_no / sell_no / cancel_order) reverts at the
  // `AccountLoader<OrderBook>` constraint. Disable the four trade
  // buttons so the user does not produce another "Simulation failed"
  // toast; the repair affordance above is the path to fix it.
  const bookUninitialized = !bookLoading && book === null;

  // Per-button disabled-reason strings, in priority order matching the
  // disabled={...} prop's short-circuit. SINGLE SOURCE OF TRUTH that
  // drives both the title= hover hint AND the visible DisabledHint
  // underneath each button. Returns null when the button is enabled
  // (or when no recognised reason applies); DisabledHint renders nothing
  // for null/empty reasons. Priority order matters because the FIRST
  // reason hit is the one the user sees; e.g. an expired market should
  // surface "Market expired" before "you already hold NO" because the
  // former is the binding constraint and the latter is irrelevant once
  // trading is closed.
  const isWalletDisconnected = !publicKey;
  const buyYesDisabledReason: string | null = isWalletDisconnected
    ? "Connect a wallet to trade."
    : isExpired
      ? "Market expired (16:00 ET); Buy Yes is hidden until next session."
      : bookUninitialized
        ? "Order book PDA is not initialized on chain. Mint Pair and Redeem Pair still work."
        : holdsNo
          ? "You already hold NO tokens. Sell or redeem your NO position before buying YES (one-side-at-a-time product constraint)."
          : null;
  const buyNoDisabledReason: string | null = isWalletDisconnected
    ? "Connect a wallet to trade."
    : isExpired
      ? "Market expired (16:00 ET); Buy No is hidden until next session."
      : bookUninitialized
        ? "Order book PDA is not initialized on chain."
        : holdsYes
          ? "You already hold YES tokens. Sell or redeem your YES position before buying NO."
          : bestBidIsSelf
            ? "Best YES bid is your own order. Buy No would self-cross; cancel your own bid first (red ✕ on the (you) row)."
            : !bestBid
              ? "No YES bid on the book yet. Buy No needs a resting bid to sell the freshly-minted YES into; it cannot fill against an ask."
              : null;
  const sellYesDisabledReason: string | null = isWalletDisconnected
    ? "Connect a wallet to trade."
    : isExpired
      ? "Market expired; Sell Yes is hidden until next session."
      : bookUninitialized
        ? "Order book PDA is not initialized on chain."
        : !holdsYes
          ? "You don't hold any YES tokens to sell. Use Mint Pair (gets you 1 YES + 1 NO for $1.00) or Buy Yes first."
          : null;
  const sellNoDisabledReason: string | null = isWalletDisconnected
    ? "Connect a wallet to trade."
    : isExpired
      ? "Market expired; Sell No is hidden until next session."
      : bookUninitialized
        ? "Order book PDA is not initialized on chain."
        : !holdsNo
          ? "You don't hold any NO tokens to sell. Use Mint Pair or Buy No first."
          : bestAskIsSelf
            ? "Best YES ask is your own order. Sell No would self-cross; cancel your own ask first."
            : !bestAsk
              ? "No YES ask on the book yet. Sell No needs a resting ask to buy YES from before redeeming the pair."
              : null;
  const mintPairDisabledReason: string | null = isWalletDisconnected
    ? "Connect a wallet to trade."
    : isExpired
      ? "Market expired; Mint Pair is hidden until next session."
      : null;

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

      {/* Tx success toast — accent-tinted, dismissable. */}
      {lastSig && (
        <div className="mb-6 flex items-start justify-between gap-4 rounded-2xl border border-accent/60 bg-accent/15 p-4">
          <div className="flex items-center gap-3 text-sm">
            <span className="text-xl text-yes">✓</span>
            <div>
              <p className="font-semibold text-text">Transaction confirmed</p>
              {lastDelta && (
                <p className="mt-0.5 font-mono text-sm text-yes">{lastDelta}</p>
              )}
              <p className="text-xs text-muted">
                <a className="text-accent underline" href={explorerTxUrl(lastSig)} target="_blank" rel="noreferrer">
                  View on Solana Explorer →
                </a>
                <span className="ml-2 font-mono">{lastSig.slice(0, 10)}…{lastSig.slice(-6)}</span>
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setLastSig(null);
              setLastDelta(null);
            }}
            className="rounded p-1 text-muted hover:bg-panel hover:text-text"
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Tx failure card.
          Solid dark panel background with a thin red border accent — not a
          translucent red fill. Reported 2026-05-26 by the user: the prior
          translucent red blob "looked like crap". This new layout puts the
          parsed hero block (headline + detail + optional CTA) at the top
          and hides the raw err code + program logs inside a collapsible
          "Technical details" disclosure that defaults closed. When the
          parser couldn't produce a hero (older codepaths, network
          errors, etc.) the fallback message renders in place. */}
      {lastErr && (
        <div
          id="trade-failure-toast"
          className="mb-6 overflow-hidden rounded-2xl border-2 border-no/70 bg-panel shadow-lg"
        >
          <div className="flex items-start justify-between gap-4 border-b border-no/30 bg-no/15 px-5 py-4">
            <div className="flex items-start gap-3">
              <span aria-hidden className="text-2xl leading-none text-no">!</span>
              <div className="min-w-0">
                <p className="text-base font-semibold text-text">
                  {lastErrHero?.headline ?? "Transaction failed"}
                </p>
                {lastErrHero?.detail && (
                  <p className="mt-1 text-sm text-text/80">{lastErrHero.detail}</p>
                )}
              </div>
            </div>
            <button
              onClick={() => {
                setLastErr(null);
                setLastErrId(null);
                setLastErrKind(null);
                setLastErrLogs(null);
                setLastErrHero(null);
                setErrDetailsExpanded(false);
              }}
              className="flex-shrink-0 rounded p-1 text-muted hover:bg-panel/80 hover:text-text"
              aria-label="Dismiss"
              title="Dismiss"
            >
              ✕
            </button>
          </div>

          {/* Inline call-to-action (e.g., the devnet USDC faucet link when
              the parser detected InsufficientBalance). Renders right
              below the hero so the user's eye lands on the next action. */}
          {lastErrHero?.cta && (
            <div className="border-b border-no/20 bg-bg/30 px-5 py-3">
              <a
                href={lastErrHero.cta.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accentHover"
              >
                {lastErrHero.cta.label}
              </a>
            </div>
          )}

          {/* When the parser couldn't produce a hero, surface the raw
              fallback message string here (still solid background, no
              translucent red blob) so the user always sees SOMETHING
              human-shaped above the technical details. */}
          {!lastErrHero && (
            <div className="border-b border-no/20 bg-bg/30 px-5 py-3">
              <p className="whitespace-pre-line break-words text-sm text-text/80">{lastErr}</p>
              {lastErrKind === "wallet_session_stale" && (
                <p className="mt-2 text-xs text-muted">
                  <strong>Fix:</strong> click <span className="font-mono">Select Wallet</span> in the
                  header, pick your wallet, approve the popup. If the extension shows a stuck pending
                  request, dismiss it from the extension icon first.
                </p>
              )}
              {lastErrKind === "wallet_send_failed" && (
                <p className="mt-2 text-xs text-muted">
                  <strong>The wallet refused to send the transaction.</strong> Open the wallet extension
                  and approve / dismiss any pending request. Confirm the wallet is on Solana Devnet.
                </p>
              )}
            </div>
          )}

          {/* Collapsed "Technical details" — err id, program logs, copy
              buttons. Defaults closed because the hero already explains
              the problem in plain language for known errors; this block
              is for support requests and devtool grepping. */}
          {(lastErrId || (lastErrLogs && lastErrLogs.length > 0)) && (
            <div className="px-5 py-3">
              <button
                type="button"
                onClick={() => setErrDetailsExpanded((v) => !v)}
                className="flex w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-wider text-muted hover:text-text"
                aria-expanded={errDetailsExpanded}
              >
                <span>Technical details</span>
                <span aria-hidden className={`transition-transform ${errDetailsExpanded ? "rotate-90" : ""}`}>▶</span>
              </button>
              {errDetailsExpanded && (
                <div className="mt-3 space-y-2 text-xs text-muted">
                  {lastErrId && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span>Error ID:</span>
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            void navigator.clipboard?.writeText(lastErrId);
                          } catch {
                            // best effort
                          }
                        }}
                        className="rounded-full border border-panel bg-panel/60 px-2 py-0.5 font-mono text-[10px] text-text hover:bg-panel"
                        title="Click to copy"
                      >
                        {lastErrId} (copy)
                      </button>
                      <span className="text-[10px]">
                        Full error in browser console (Cmd+Option+J / Ctrl+Shift+J), searchable by this
                        ID.
                      </span>
                    </div>
                  )}
                  {lastErrLogs && lastErrLogs.length > 0 && (
                    <details className="rounded border border-panel bg-bg/40 p-2" open>
                      <summary className="cursor-pointer font-semibold text-text">
                        Program logs ({lastErrLogs.length} line{lastErrLogs.length === 1 ? "" : "s"})
                      </summary>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-text/70">
                        {lastErrLogs.join("\n")}
                      </pre>
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            void navigator.clipboard?.writeText(lastErrLogs.join("\n"));
                          } catch {
                            // best effort
                          }
                        }}
                        className="mt-1 rounded border border-panel bg-panel/60 px-2 py-0.5 text-[10px] text-text hover:bg-panel"
                      >
                        Copy logs
                      </button>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Dummy: this branch was the original outer toast that wrapped
          both success and failure. We've split it into two separate
          cards above so each can have its own appropriate styling
          (success keeps the accent tint, failure gets the new clean
          panel). The dead block below is intentionally a no-op to
          minimize git churn until a follow-up commit removes it. */}
      {false && (
        <div className="hidden">
          <button
            onClick={() => {
              setLastSig(null);
              setLastErr(null);
              setLastErrId(null);
              setLastErrKind(null);
              setLastErrLogs(null);
              setLastErrHero(null);
              setErrDetailsExpanded(false);
              setLastDelta(null);
            }}
            className="hidden"
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* The standalone "For each Yes token / For each No token" payoff
          banner that previously lived here was removed on 2026-05-26 in
          favour of moving the same payoff sentence into the Buy Yes and
          Buy No InfoTip popovers (the ⓘ icons on those buttons), so the
          rules now live alongside the mechanism in the same one-click
          tooltip. Reported by the user as "redundant to the info
          buttons under the buy/sell boxes." The InfoTip payoff
          paragraphs are conditional on `m` being non-null, so an
          unsettled / loading market still renders the rest of the
          tooltip without crashing. */}

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
            {/*
              Each pill is a "see for yourself" link to the actual SPL
              token account on Solana Explorer (CLAUDE.md → transparency +
              debug routes). The user can verify the on-chain balance with
              their own eyes instead of trusting Meridian's render. The ↗
              glyph signals external link without taking up much room.
              `userTokenAtas` is null only when there is no connected
              wallet (`publicKey` falsy) or the market PDA could not be
              parsed; both render branches above already gate on those, so
              by here we expect userTokenAtas to exist. The `??` defensive
              fallback to plain text matches the prior render so the page
              never breaks even if the ATA derivation throws.
            */}
            {userTokenAtas ? (
              <a
                href={explorerAddressUrl(userTokenAtas.yesAta)}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex items-center gap-1.5 rounded-full bg-yes/20 px-3 py-1 text-yes transition-colors hover:bg-yes/30 hover:underline"
                title={`Open this YES token account on Solana Explorer (${cluster.name}). The balance you see here is the same number that account holds on-chain.`}
              >
                <span>
                  YES tokens owned:{" "}
                  <span className="font-mono font-semibold">{userYesBal.toString()}</span>
                </span>
                <span aria-hidden className="text-[10px] opacity-70 group-hover:opacity-100">
                  ↗
                </span>
              </a>
            ) : (
              <span className="rounded-full bg-yes/20 px-3 py-1 text-yes">
                YES tokens owned:{" "}
                <span className="font-mono font-semibold">{userYesBal.toString()}</span>
              </span>
            )}
            {userTokenAtas ? (
              <a
                href={explorerAddressUrl(userTokenAtas.noAta)}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex items-center gap-1.5 rounded-full bg-no/20 px-3 py-1 text-no transition-colors hover:bg-no/30 hover:underline"
                title={`Open this NO token account on Solana Explorer (${cluster.name}). The balance you see here is the same number that account holds on-chain.`}
              >
                <span>
                  NO tokens owned:{" "}
                  <span className="font-mono font-semibold">{userNoBal.toString()}</span>
                </span>
                <span aria-hidden className="text-[10px] opacity-70 group-hover:opacity-100">
                  ↗
                </span>
              </a>
            ) : (
              <span className="rounded-full bg-no/20 px-3 py-1 text-no">
                NO tokens owned:{" "}
                <span className="font-mono font-semibold">{userNoBal.toString()}</span>
              </span>
            )}
          </div>
          {/* Companion line that names the on-chain mints so the user can
              also inspect the SUPPLY of YES vs NO across all wallets — that
              is, the open interest of this market. Smaller / muted because
              it is an advanced affordance, not the primary signal. */}
          {userTokenAtas && (userYesBal > 0n || userNoBal > 0n) && (
            <p className="text-[11px] text-muted">
              Mints:{" "}
              <a
                href={explorerAddressUrl(userTokenAtas.yesMint)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent underline decoration-accent/40 hover:text-accentHover"
                title="Open the YES mint on Solana Explorer to see total supply (open interest) and every holder."
              >
                YES mint
              </a>
              {" · "}
              <a
                href={explorerAddressUrl(userTokenAtas.noMint)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent underline decoration-accent/40 hover:text-accentHover"
                title="Open the NO mint on Solana Explorer to see total supply (open interest) and every holder."
              >
                NO mint
              </a>
            </p>
          )}
          {/* Surface ALL active gates, not just one. The prior single-line
              constraint only ever named one side (`holdsYes ? "No" : "Yes"`),
              so a user holding BOTH sides saw "cannot Buy No" while Buy Yes
              was also blocked — silently. Listing every active reason is the
              fix. Book-liquidity gates (no bestBid / no bestAsk) belong here
              too because they disable Buy No / Sell No for non-position
              reasons that the user otherwise has no way to discover.

              Collapsible disclosure (default closed). The user reported
              that always-open mode pushed real content below the fold;
              collapsing lets them peek on demand without losing the
              affordance. The heading row is the toggle; the chevron
              flips to communicate state. State is component-local
              (`disabledReasonsExpanded`) — survives re-renders, resets
              on navigation. */}
          {/* The consolidated "Why some buttons are disabled:" panel that
              previously lived here was removed on 2026-05-26 in favour of
              per-button DisabledHint lines that render directly UNDERNEATH
              each disabled trade button. Single visible exception: the
              market-wide "All trade buttons disabled because the market is
              expired" notice below — it gates EVERY trade button at once,
              so listing it under each one would six-paste the same text;
              keeping a single banner is the readable choice. The
              disabledReasonsExpanded state and its handler are no longer
              referenced and have been dropped.
          */}
          {/*
            Expired-market notice. The only constraint still rendered as a
            standalone banner instead of a per-button DisabledHint, because
            expiry disables EVERY trade button at once and pasting the same
            sentence under all six would be noise. The adminMode branch
            tells trusted visitors how to bypass via the 🧪 DEV pill (the
            on-chain program accepts these instructions 24/7; only the UI
            hides them past expiry). Non-admins get the wait-for-tomorrow
            guidance instead, because the after-hours toggle is gated on
            admin sign-in via useAfterHoursMode's AND-gate.
          */}
          {isExpired && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-200">
              <p>
                <span className="font-semibold">All trade buttons disabled</span> — this market is past its
                16:00 ET expiry and is awaiting settlement.{" "}
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
              </p>
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
          {/* order-book-section-legend: the plain-language explanation
              of what BIDS / ASKS mean on this YES-only book, and how a
              NO is synthesized via mint-pair + IOC-sell. Was inline as
              a four-line block in an earlier iteration; collapsed
              behind this ⓘ on 2026-05-26 per user feedback that the
              trade page had too much always-on explanatory text. */}
          <h2 className="mb-3 flex items-center text-sm font-semibold uppercase tracking-wider text-muted">
            <span>Order book (Yes/USDC)</span>
            <InfoTip
              title="What this book trades"
              side="bottom"
              className="text-muted normal-case tracking-normal"
              ariaLabel="Open the order-book legend"
            >
              <p>
                <span className="font-semibold text-text">This book trades YES tokens only.</span>{" "}
                <span className="text-yes">Bids</span> are wallets offering USD Coin to{" "}
                <span className="text-yes">BUY YES</span>;{" "}
                <span className="text-no">Asks</span> are wallets offering to{" "}
                <span className="text-no">SELL YES</span> for USD Coin. Both sides quote the
                same asset (one YES token); the displayed price is what one YES costs in
                USD Coin, the displayed quantity is YES tokens.
              </p>
              <p>
                Want a <strong>NO</strong> instead? NO has no book of its own. Buying a NO
                mints a fresh YES + NO pair for $1.00 and immediately sells the YES into the
                top <span className="text-yes">Bid</span>; you keep the NO at net cost{" "}
                <span className="font-mono">$1.00 − bid_price</span>. So Buy No requires
                at least one <span className="text-yes">Bid</span> to be present, not an{" "}
                <span className="text-no">Ask</span>.
              </p>
            </InfoTip>
          </h2>
          {bookLoading && <p className="text-muted">Loading book...</p>}
          {!bookLoading && !book && (
            // Pre-init state. Place + buy + sell instructions all fail
            // here with the on-chain "AccountNotInitialized" error from
            // the `seeds = [b"book", ...]` constraint in
            // programs/meridian/src/instructions/place_order.rs, so we
            // call this out plainly AND offer a repair affordance when
            // the admin is signed in (the on-chain init_order_book is
            // address-gated to the admin keypair, which lives on the
            // automation server).
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-100">
              <p className="font-semibold">Order book not yet initialized for this market.</p>
              <p className="mt-1 text-xs text-yellow-200/80">
                Mint Pair / Redeem Pair work without an order book, but Buy Yes, Sell Yes, Buy No, and Sell
                No all require the book account to exist on-chain. Without it, those instructions revert at
                account deserialization and the wallet shows &quot;Simulation failed&quot;.
              </p>
              {adminMode && (
                <div className="mt-3 border-t border-yellow-500/20 pt-3">
                  <button
                    type="button"
                    disabled={repairBusy || !publicKey}
                    onClick={async () => {
                      // Narrow publicKey for the closure so the funding
                      // branch below does not have to re-check null. The
                      // button is `disabled` when publicKey is falsy.
                      const userPk = publicKey;
                      if (!userPk) {
                        setRepairErr("Connect a wallet before clicking this button.");
                        return;
                      }
                      setRepairBusy(true);
                      setRepairErr(null);
                      setRepairResult(null);
                      setRepairStep("Reading admin pubkey from on-chain Config PDA…");
                      try {
                        // ===== Step 1: derive admin pubkey from Config PDA. =====
                        // Config layout: 8-byte Anchor discriminator + Pubkey
                        // (admin) + Pubkey (usdc_mint) + ... ; the admin
                        // field is the first 32 bytes after the discriminator.
                        // Reading from the chain (instead of hardcoding) means
                        // a future admin rotation just works.
                        const [cfgPda] = PublicKey.findProgramAddressSync(
                          [Buffer.from("config"), Buffer.from([1])],
                          program.programId,
                        );
                        const cfgInfo = await program.provider.connection.getAccountInfo(cfgPda);
                        if (!cfgInfo) {
                          throw new Error(
                            `Program config PDA ${cfgPda.toBase58()} does not exist on ${cluster.name}. ` +
                              `Run scripts/init-config.mjs once per program deploy.`,
                          );
                        }
                        const adminPubkey = new PublicKey(cfgInfo.data.subarray(8, 8 + 32));

                        // ===== Step 2: check admin balance. =====
                        // 0.08 SOL covers OrderBook account rent (~0.052) +
                        // two escrow ATAs (~0.004) + tx fees + safety margin.
                        // Same threshold as the automation server's precheck
                        // in automation/src/jobs/ensureOrderBook.ts.
                        const ADMIN_INIT_BOOK_MIN_LAMPORTS = 80_000_000;
                        // 0.1 SOL transfer when funding: leaves headroom for
                        // re-runs on the same admin without re-funding.
                        const FUND_AMOUNT_LAMPORTS = 100_000_000;
                        setRepairStep(`Checking admin balance for ${adminPubkey.toBase58().slice(0, 8)}…`);
                        const adminBal = await program.provider.connection.getBalance(adminPubkey);

                        // ===== Step 3: fund admin from user wallet (only if needed). =====
                        if (adminBal < ADMIN_INIT_BOOK_MIN_LAMPORTS) {
                          if (!sendTransaction) {
                            throw new Error("Wallet adapter does not expose sendTransaction.");
                          }
                          setRepairStep(
                            `Admin has ${(adminBal / 1e9).toFixed(4)} SOL — funding with 0.1 SOL from your wallet…`,
                          );
                          const fundIx = SystemProgram.transfer({
                            fromPubkey: userPk,
                            toPubkey: adminPubkey,
                            lamports: FUND_AMOUNT_LAMPORTS,
                          });
                          const { blockhash } = await program.provider.connection.getLatestBlockhash("confirmed");
                          const fundTx = new Transaction().add(fundIx);
                          fundTx.feePayer = userPk;
                          fundTx.recentBlockhash = blockhash;
                          const fundSig = await sendTransaction(fundTx, program.provider.connection);
                          setRepairStep(`Funding tx ${fundSig.slice(0, 8)}… confirming…`);
                          await program.provider.connection.confirmTransaction(fundSig, "confirmed");
                        }

                        // ===== Step 4: now call the automation server. =====
                        setRepairStep("Calling /admin/init-order-book…");
                        const result = await postInitOrderBook({ marketPubkey: market });
                        setRepairResult(result);
                        setRepairStep("");
                        // Trigger an immediate refetch so the book panel
                        // flips from "not initialized" to the empty-book
                        // grid (bids: 0, asks: 0) the moment the tx
                        // confirms, without waiting for the 2s
                        // React Query interval.
                        void queryClient.invalidateQueries({
                          queryKey: queryKeys.orderBook(market),
                        });
                      } catch (err) {
                        if (err instanceof AutomationApiError) {
                          setRepairErr(
                            `Init order book failed [${err.slug} / HTTP ${err.status}]: ${err.message}`,
                          );
                        } else {
                          setRepairErr(
                            err instanceof Error ? err.message : String(err),
                          );
                        }
                        setRepairStep("");
                      } finally {
                        setRepairBusy(false);
                      }
                    }}
                    className="w-full rounded-lg border border-accent/50 bg-accent/20 px-3 py-2 text-xs font-semibold text-accent hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
                    title="One-click repair. Reads the admin pubkey from on-chain Config, tops up the admin with 0.1 SOL from YOUR connected wallet if its balance is below 0.08 SOL, then calls /admin/init-order-book to allocate the order book PDA. The funding step is the bypass for the devnet faucet rate-limit; the on-chain init is idempotent."
                  >
                    {repairBusy
                      ? repairStep || "Working…"
                      : "Fund admin + initialize order book (one click)"}
                  </button>
                  {repairResult && (
                    <div className="mt-2 rounded-md border border-yes/40 bg-yes/10 p-2 text-[11px]">
                      <p className="font-semibold text-yes">
                        {repairResult.alreadyInitialized
                          ? "Order book was already initialized; no transaction issued."
                          : "Order book initialized."}
                      </p>
                      <p className="mt-0.5 font-mono text-text">book: {repairResult.bookPubkey}</p>
                      {repairResult.sig && (
                        <p className="mt-0.5">
                          <a
                            className="text-accent underline"
                            href={explorerTxUrl(repairResult.sig)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View init_order_book tx on Solana Explorer →
                          </a>
                        </p>
                      )}
                      <p className="mt-1 text-muted">
                        Trade buttons will become active as soon as the book panel refreshes
                        (≤2 seconds).
                      </p>
                    </div>
                  )}
                  {repairErr && (
                    <p className="mt-2 break-words rounded-md border border-no/40 bg-no/10 p-2 text-[11px] text-no">
                      {repairErr}
                    </p>
                  )}
                  <p className="mt-1 text-[10px] text-muted">
                    This calls the automation server&apos;s {`/admin/init-order-book`} endpoint. The admin
                    keypair lives on that server; the browser never signs init_order_book directly.
                  </p>
                </div>
              )}
              {!adminMode && (
                <p className="mt-2 text-[11px] text-yellow-200/70">
                  Initialization requires the admin keypair (server-side). If this market is in the
                  daily ladder it should be auto-initialized by the next morning cron; otherwise contact
                  an operator.
                </p>
              )}
            </div>
          )}
          {book && (
            <>
              {/* The plain-language order-book legend was previously rendered
                  inline as a four-line block above the columns. The
                  2026-05-26 user feedback was that the trade page had too
                  much visible explanatory text. Moved into the InfoTip
                  popover attached to the ORDER BOOK section header
                  (search the file for `order-book-section-legend`), so
                  the legend is one click away rather than always-on. */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <h3 className="mb-1 text-xs uppercase text-yes flex items-baseline gap-2">
                  <span>Bids · buying YES</span>
                  {orderBookPda && (
                    // "See for yourself" link to the entire CLOB account
                    // on Solana Explorer. The OrderBook PDA is a single
                    // ~7,296-byte zero-copy account that physically
                    // stores every bid + ask in the inline `bids[]` /
                    // `asks[]` arrays — clicking through proves the
                    // on-screen book is exactly the on-chain state, not
                    // a backend cache. The maker-specific links below
                    // are complementary: this one is for "show me the
                    // CLOB", those are for "show me the maker".
                    <a
                      href={explorerAddressUrl(orderBookPda)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] font-normal normal-case text-accent underline decoration-accent/40 hover:text-accentHover"
                      title="Open the on-chain OrderBook PDA on Solana Explorer. This single account holds every bid + ask in zero-copy storage; the page renders directly from it."
                    >
                      view full CLOB on-chain ↗
                    </a>
                  )}
                </h3>
                {/* Column sub-header removed 2026-05-26 — the unit hint
                    ("price per YES · qty in YES tokens") now lives inside
                    the order-book section's InfoTip popover. Empty-state
                    copy shortened to a one-line "No bids." since the
                    disabled Buy No button's ⓘ already explains why. */}
                {book.bids.length === 0 ? (
                  <p className="text-sm text-muted">No bids.</p>
                ) : (
                  <ul className="space-y-1 font-mono text-sm">
                    {book.bids.slice(0, 10).map((b) => {
                      const mine = !!publicKey && b.owner === publicKey.toBase58();
                      const rowHref = orderBookPda ? explorerAddressUrl(orderBookPda) : null;
                      return (
                        <li key={`${b.owner}-${b.sequence}`} className="flex items-center justify-between gap-2">
                          {rowHref ? (
                            <a
                              href={rowHref}
                              target="_blank"
                              rel="noreferrer"
                              className={
                                "flex flex-1 items-center justify-between gap-2 rounded px-1 -mx-1 hover:bg-yes/10 " +
                                (mine ? "text-yes font-semibold" : "text-yes")
                              }
                              title={`Open the OrderBook PDA on Solana Explorer. This bid lives inside that account as a zero-copy Order { price_ticks: ${b.priceTicks}, qty: ${b.qty.toString()}, sequence: ${b.sequence.toString()}, owner: ${b.owner} }.`}
                            >
                              <span>
                                {formatUsdc(b.priceUsd)}
                                {mine && <span className="ml-1 text-[10px] text-accent">(you)</span>}
                              </span>
                              <span className="text-muted">{b.qty.toString()}</span>
                              <span aria-hidden className="text-[10px] opacity-50">↗</span>
                            </a>
                          ) : (
                            <span className={mine ? "text-yes font-semibold" : "text-yes"}>
                              {formatUsdc(b.priceUsd)} <span className="text-muted">{b.qty.toString()}</span>
                            </span>
                          )}
                          {!mine && (
                            // Maker-pubkey peek for non-self rows. Lets
                            // the user audit who placed the bid without
                            // leaving the page. For self rows we skip
                            // (you already know it's you) and surface
                            // the Cancel button instead.
                            <a
                              href={explorerAddressUrl(b.owner)}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded bg-yes/10 px-2 py-0.5 font-mono text-[10px] text-yes/80 hover:bg-yes/20 hover:text-yes"
                              title={`Open the maker wallet ${b.owner} on Solana Explorer.`}
                            >
                              maker {b.owner.slice(0, 4)}…{b.owner.slice(-4)} ↗
                            </a>
                          )}
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
                <h3 className="mb-1 text-xs uppercase text-no flex items-baseline gap-2">
                  <span>Asks · selling YES</span>
                  {orderBookPda && (
                    <a
                      href={explorerAddressUrl(orderBookPda)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] font-normal normal-case text-accent underline decoration-accent/40 hover:text-accentHover"
                      title="Open the on-chain OrderBook PDA on Solana Explorer. Same account as the bid-side link; bids[] and asks[] are inline arrays on a single zero-copy account."
                    >
                      view full CLOB on-chain ↗
                    </a>
                  )}
                </h3>
                {/* Column sub-header / verbose empty state both removed
                    on 2026-05-26 — see the matching comment on the Bids
                    side. */}
                {book.asks.length === 0 ? (
                  <p className="text-sm text-muted">No asks.</p>
                ) : (
                  <ul className="space-y-1 font-mono text-sm">
                    {book.asks.slice(0, 10).map((a) => {
                      const mine = !!publicKey && a.owner === publicKey.toBase58();
                      const rowHref = orderBookPda ? explorerAddressUrl(orderBookPda) : null;
                      return (
                        <li key={`${a.owner}-${a.sequence}`} className="flex items-center justify-between gap-2">
                          {rowHref ? (
                            <a
                              href={rowHref}
                              target="_blank"
                              rel="noreferrer"
                              className={
                                "flex flex-1 items-center justify-between gap-2 rounded px-1 -mx-1 hover:bg-no/10 " +
                                (mine ? "text-no font-semibold" : "text-no")
                              }
                              title={`Open the OrderBook PDA on Solana Explorer. This ask lives inside that account as a zero-copy Order { price_ticks: ${a.priceTicks}, qty: ${a.qty.toString()}, sequence: ${a.sequence.toString()}, owner: ${a.owner} }.`}
                            >
                              <span>
                                {formatUsdc(a.priceUsd)}
                                {mine && <span className="ml-1 text-[10px] text-accent">(you)</span>}
                              </span>
                              <span className="text-muted">{a.qty.toString()}</span>
                              <span aria-hidden className="text-[10px] opacity-50">↗</span>
                            </a>
                          ) : (
                            <span className={mine ? "text-no font-semibold" : "text-no"}>
                              {formatUsdc(a.priceUsd)} <span className="text-muted">{a.qty.toString()}</span>
                            </span>
                          )}
                          {!mine && (
                            <a
                              href={explorerAddressUrl(a.owner)}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded bg-no/10 px-2 py-0.5 font-mono text-[10px] text-no/80 hover:bg-no/20 hover:text-no"
                              title={`Open the maker wallet ${a.owner} on Solana Explorer.`}
                            >
                              maker {a.owner.slice(0, 4)}…{a.owner.slice(-4)} ↗
                            </a>
                          )}
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
            </>
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
                signature. Set your wallet (Phantom, Solflare, or Coinbase Wallet — Coinbase
                Wallet has no per-network setting to flip; Meridian's RPC drives the cluster)
                to Devnet if needed, then click below. Click the DEVNET pill in the header for
                click-by-click instructions for your wallet.
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
                          href={explorerTxUrl(settleResult.sig)}
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

              DisabledHint heads-up: each button's reason is computed
              into a per-button const (`buyYesDisabledReason` etc.) and
              rendered as a yellow ⓘ line UNDERNEATH the button via the
              `<DisabledHint reason={...}/>` component. Single source of
              truth: the same reason string drives the `title` hover
              attribute (desktop hover affordance) AND the visible
              DisabledHint line (touch + glance-without-hover
              affordance). When the reason is null/empty the hint
              renders nothing, so enabled buttons get no extra row of
              vertical space. Replaces the prior consolidated "Why some
              buttons are disabled:" panel at the top of the page — the
              user reported on 2026-05-26 that the panel forced them to
              mentally match each reason back to the button it referred
              to, and asked for the reason to live next to the button
              the user is actually looking at.

              Each button is wrapped in a `relative` div so its InfoTip
              icon can absolutely position into the button's top-right
              corner. The InfoTip popover explains the on-chain mechanism
              (especially important for Buy No / Sell No, which look like
              symmetric NO orders but actually mint or burn a pair under
              the hood). Top-row buttons get side="top" (popover above)
              and bottom-row get side="bottom" (popover below) so the
              popover never overlaps the other row of buttons. */}
          {/* Per-button disabled-reason strings are computed at the top
              of this component (search for `buyYesDisabledReason`).
              Reason is null when the button is enabled OR when no
              recognised reason applies; <DisabledHint> renders nothing
              in either case so enabled buttons get no extra row of
              vertical space. Redeem Pair's own gated block already
              prints settled / pair-balance hints directly under the
              button via `settledHint`, so it does not get a
              DisabledHint here. */}
          <div className="grid grid-cols-2 gap-2">
            <div className="relative">
              <button
                disabled={!trade.ready || busy !== null || holdsNo || isExpired || bookUninitialized}
                onClick={() => run("Buy Yes", () => trade.buyYes(priceTicks, qty), `+${qty} YES (resting bid at ${priceTicks}¢)`)}
                className="w-full rounded-lg bg-yes/20 px-3 py-2 font-semibold text-yes hover:bg-yes/30 disabled:cursor-not-allowed disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
                title={
                  isExpired
                    ? "Market expired"
                    : bookUninitialized
                      ? "Order book PDA is not initialized for this market — see the panel on the left. Mint Pair / Redeem Pair still work, but order-book instructions revert until init_order_book has been called."
                      : holdsNo
                        ? "Sell your No position before buying Yes (PRD position constraint)"
                        : ""
                }
              >
                {busy === "Buy Yes" ? "..." : "Buy Yes"}
              </button>
              <InfoTip
                title="How Buy Yes works"
                side="top"
                className="absolute right-1.5 top-1.5 text-yes"
              >
                {m && m.outcome === "Pending" && (
                  <p className="rounded bg-yes/10 px-2 py-1.5 text-text">
                    <strong>Payoff:</strong> each YES token pays{" "}
                    <span className="font-mono">$1.00</span> if{" "}
                    <span className="font-semibold">{ticker}</span> closes at or above{" "}
                    <span className="font-mono">{formatUsdc(m.strikeUsd)}</span> at 16:00 ET today.
                    Otherwise it pays <span className="font-mono">$0.00</span>.
                  </p>
                )}
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
              <DisabledHint reason={buyYesDisabledReason} />
            </div>
            <div className="relative">
              <button
                disabled={!trade.ready || busy !== null || !bestBid || holdsYes || isExpired || bookUninitialized || bestBidIsSelf}
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
                    : bookUninitialized
                      ? "Order book PDA is not initialized for this market — see the panel on the left."
                      : holdsYes
                        ? "Sell your Yes position before buying No (PRD position constraint)"
                        : bestBidIsSelf
                          ? "Best bid is your own order — Buy No would self-cross and leave you with both a YES and a NO. Cancel your own bid first (the red x on the (you) row in the bids table)."
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
                {m && m.outcome === "Pending" && (
                  <p className="rounded bg-no/10 px-2 py-1.5 text-text">
                    <strong>Payoff:</strong> each NO token pays{" "}
                    <span className="font-mono">$1.00</span> if{" "}
                    <span className="font-semibold">{ticker}</span> closes{" "}
                    <span className="font-semibold">below</span>{" "}
                    <span className="font-mono">{formatUsdc(m.strikeUsd)}</span> at 16:00 ET today.
                    Otherwise it pays <span className="font-mono">$0.00</span>.
                  </p>
                )}
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
              <DisabledHint reason={buyNoDisabledReason} />
            </div>
            <div className="relative">
              <button
                disabled={!trade.ready || busy !== null || !holdsYes || isExpired || bookUninitialized}
                onClick={() => run("Sell Yes", () => trade.sellYes(priceTicks, qty), `−${qty} YES into escrow (limit ask ${priceTicks}¢)`)}
                className="w-full rounded-lg border border-yes/40 bg-panel px-3 py-2 font-semibold text-yes hover:bg-yes/10 disabled:cursor-not-allowed disabled:border-panel disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
                title={
                  isExpired
                    ? "Market expired"
                    : bookUninitialized
                      ? "Order book PDA is not initialized for this market — see the panel on the left. The Sell Yes instruction reverts at AccountLoader<OrderBook> deserialization until init_order_book has been called."
                      : !holdsYes
                        ? "Need Yes tokens to sell"
                        : ""
                }
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
              <DisabledHint reason={sellYesDisabledReason} />
            </div>
            <div className="relative">
              <button
                disabled={!trade.ready || busy !== null || !bestAsk || !holdsNo || isExpired || bookUninitialized || bestAskIsSelf}
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
                    : bookUninitialized
                      ? "Order book PDA is not initialized for this market — see the panel on the left."
                      : !holdsNo
                        ? "Need No tokens to sell"
                        : bestAskIsSelf
                          ? "Best ask is your own order — Sell No would self-cross. Cancel your own ask first (the red x on the (you) row in the asks table)."
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
              <DisabledHint reason={sellNoDisabledReason} />
            </div>
          </div>

          <button
            disabled={!trade.ready || busy !== null || isExpired}
            onClick={() => run("Mint Pair", () => trade.mintPair(qty), `+${qty} YES, +${qty} NO, −$${qty}.00 USDC`)}
            className="mt-3 w-full rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-semibold text-accent hover:bg-accent/20 disabled:cursor-not-allowed disabled:border-panel disabled:bg-panel/40 disabled:text-muted disabled:opacity-60"
          >
            {busy === "Mint Pair" ? "..." : `Mint ${qty} pair (deposit $${qty}.00 USDC)`}
          </button>
          <DisabledHint reason={mintPairDisabledReason} />

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

"use client";

// useTrade — handlers for the four trade-panel buttons on /trade/[ticker]/[market].
// Each returns an async fn that builds + signs + sends the right instruction.

import { useCallback } from "react";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";

import { useMeridian } from "@/hooks/useMeridian";
import {
  BOOK_AUTH_SEED,
  NO_MINT_SEED,
  ORDER_BOOK_SEED,
  PROGRAM_VERSION_BYTE,
  VAULT_AUTH_SEED,
  YES_MINT_SEED,
} from "@/lib/anchor";
import { cluster } from "@/lib/cluster";

// Re-export the seeds we need without changing the source-of-truth in anchor.ts.
export {
  BOOK_AUTH_SEED,
  NO_MINT_SEED,
  ORDER_BOOK_SEED,
  PROGRAM_VERSION_BYTE,
  VAULT_AUTH_SEED,
  YES_MINT_SEED,
};

const BN: typeof anchor.BN = anchor.BN;

/**
 * Walk a wallet-adapter error to find the deepest available message + logs.
 *
 * @solana/wallet-adapter-base's `WalletError` exposes `.error` (the underlying
 * cause from the wallet extension or web3.js). `@solana/web3.js`'s
 * `SendTransactionError` exposes `.logs` (the simulation log array). Both
 * surface useful detail that `.message` alone discards. The wallet's
 * `signAndSendTransaction` typically returns either:
 *
 *   - a SendTransactionError with logs (program reverted post-simulation), or
 *   - a plain Error with message="Internal error" and no further detail.
 *
 * For each level of nesting we accumulate the best message and the deepest
 * logs array. We avoid `instanceof` checks because pnpm sometimes hoists
 * two copies of @solana/wallet-adapter-base, and an `instanceof` against
 * one copy fails on errors thrown by the other. Name-based detection is
 * robust to that.
 */
function walkWalletErrorCause(err: unknown): { message: string; logs: readonly string[] | null } {
  let logs: readonly string[] | null = null;
  let messages: string[] = [];
  let cursor: unknown = err;
  let safety = 0;
  while (cursor != null && safety < 8) {
    safety += 1;
    if (cursor instanceof Error) {
      const m = cursor.message?.trim();
      // Skip the literal placeholder "Internal error" string the adapter
      // returns when no detail is available — keep walking to find a
      // better source. Keep it as a fallback only if nothing deeper turns
      // up.
      if (m && !/^internal error\.?$/i.test(m)) messages.push(m);
      // @solana/web3.js SendTransactionError carries .logs (string[]).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maybeLogs = (cursor as any).logs;
      if (Array.isArray(maybeLogs) && maybeLogs.length > 0 && !logs) {
        logs = maybeLogs as readonly string[];
      }
      // The wallet-adapter-base WalletError stashes the original error
      // under `.error`. Native ES `cause` is the modern equivalent. Walk
      // both because the adapter version varies.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inner = (cursor as any).error ?? cursor.cause;
      cursor = inner;
      continue;
    }
    if (typeof cursor === "string") {
      const t = cursor.trim();
      if (t && !/^internal error\.?$/i.test(t)) messages.push(t);
      break;
    }
    break;
  }
  if (messages.length === 0) messages = ["The wallet returned 'Internal error' with no further detail."];
  return { message: messages.join(" -> "), logs };
}

export interface MarketAddresses {
  market: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  vaultAuthority: PublicKey;
  orderBook: PublicKey;
  bookAuthority: PublicKey;
  usdcEscrow: PublicKey;
  yesEscrow: PublicKey;
}

export function deriveMarketAddresses(programId: PublicKey, marketPk: PublicKey): MarketAddresses {
  const market = marketPk;
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [VAULT_AUTH_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    programId,
  );
  const [yesMint] = PublicKey.findProgramAddressSync(
    [YES_MINT_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    programId,
  );
  const [noMint] = PublicKey.findProgramAddressSync(
    [NO_MINT_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    programId,
  );
  const [orderBook] = PublicKey.findProgramAddressSync(
    [ORDER_BOOK_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    programId,
  );
  const [bookAuthority] = PublicKey.findProgramAddressSync(
    [BOOK_AUTH_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    programId,
  );
  const usdcMint = new PublicKey(cluster.usdcMint);
  const vault = getAssociatedTokenAddressSync(usdcMint, vaultAuthority, true);
  const usdcEscrow = getAssociatedTokenAddressSync(usdcMint, bookAuthority, true);
  const yesEscrow = getAssociatedTokenAddressSync(yesMint, bookAuthority, true);
  return { market, yesMint, noMint, vault, vaultAuthority, orderBook, bookAuthority, usdcEscrow, yesEscrow };
}

export interface UserAtas {
  userUsdc: PublicKey;
  userYes: PublicKey;
  userNo: PublicKey;
}

/**
 * Typed error thrown by `simulateAndSend` when a transaction fails ANY of:
 *   - wallet sanity check (adapter says connected but extension dropped session),
 *   - pre-flight on-chain simulation (program reverted),
 *   - the wallet's signAndSend step (popup rejected or wallet returned an error).
 *
 * The `kind` field lets the trade page's `run()` catch render specific
 * remediation copy instead of a generic "transaction failed" string. Every
 * branch carries the underlying cause (`cause`) and, when available, the
 * exact Solana program logs (`logs`) so the user can paste them into a
 * support request or read them in devtools alongside the correlation ID.
 *
 * Why a custom error type instead of throwing the wallet adapter's error
 * verbatim: the wallet adapter coalesces every failure mode into
 * `WalletSendTransactionError("Internal error")`. That string is the entire
 * payload — no logs, no cause, no diagnostics. Users cannot act on it. This
 * wrapper preserves the original error in `.cause` for the console, while
 * the message + kind + logs drive the on-screen toast.
 */
export class TradeTxError extends Error {
  // `underlyingError` instead of `cause` because TypeScript treats `cause`
  // as a parameter-property override of Error.cause and demands the
  // `override` keyword (TS4115). Renaming sidesteps the dance without
  // losing the original error — consumers can walk the chain directly
  // through `.underlyingError`. Browsers also still expose Error.cause
  // via the second `Error` constructor arg below for future tooling.
  constructor(
    public readonly kind:
      | "wallet_session_stale"
      | "simulation_reverted"
      | "wallet_send_failed",
    message: string,
    public readonly logs: readonly string[] | null,
    public readonly underlyingError: unknown,
  ) {
    super(message, underlyingError instanceof Error ? { cause: underlyingError } : undefined);
    this.name = "TradeTxError";
  }
}

export function useTrade(marketPubkey: string | undefined) {
  const { program, provider } = useMeridian();
  const { publicKey, sendTransaction, wallet, connected } = useWallet();

  /**
   * Single funnel for every send in this hook.
   *
   * Order of checks (each one short-circuits with a typed error so the
   * caller can branch on `.kind`):
   *
   *   1. Wallet sanity: `connected` must be true AND `wallet.adapter.publicKey`
   *      must match `publicKey`. Catches the "adapter believes it is
   *      connected but the extension dropped the session" failure mode that
   *      surfaces in the wallet as the unhelpful "Internal error". When this
   *      fires, the user reconnects (Select Wallet -> their wallet); the
   *      banner instructs them precisely.
   *
   *   2. Pre-flight simulation: `connection.simulateTransaction` with
   *      `sigVerify: false` AND `replaceRecentBlockhash: true` so we don't
   *      need the wallet to sign just to learn whether the transaction
   *      reverts. If sim reports `err`, throw `simulation_reverted` with the
   *      program logs. This is where "place_order against an uninitialized
   *      OrderBook PDA" becomes "AccountLoader<OrderBook>: account does not
   *      exist" instead of "Internal error".
   *
   *   3. Wallet send: only reached when sim says the program is happy. Any
   *      failure here means the WALLET rejected (popup closed, user clicked
   *      Reject, wallet on wrong network), not the program. Wrap and rethrow
   *      with `wallet_send_failed`.
   */
  const simulateAndSend = useCallback(
    async (label: string, tx: anchor.web3.Transaction): Promise<string> => {
      // ----- (1) Wallet sanity check. -----
      if (!publicKey) {
        throw new TradeTxError(
          "wallet_session_stale",
          "No wallet is selected. Click 'Select Wallet' in the header, pick your wallet, then retry.",
          null,
          null,
        );
      }
      if (!connected || !wallet) {
        throw new TradeTxError(
          "wallet_session_stale",
          "The wallet adapter shows a public key but is not in the 'connected' state. Click 'Select Wallet' in the header and reconnect.",
          null,
          null,
        );
      }
      const adapterPk = wallet.adapter.publicKey;
      if (!adapterPk || !adapterPk.equals(publicKey)) {
        throw new TradeTxError(
          "wallet_session_stale",
          `Wallet session is stale. The Meridian app sees publicKey ${publicKey.toBase58()} but the wallet extension reports ${
            adapterPk ? adapterPk.toBase58() : "no publicKey"
          }. Open the wallet extension, disconnect Meridian, refresh this page, then reconnect.`,
          null,
          null,
        );
      }

      // ----- (2) Pre-flight simulation. -----
      // We must give the transaction a feePayer and a recentBlockhash for
      // the RPC to accept the simulate call. `replaceRecentBlockhash: true`
      // also tells the RPC to substitute the latest blockhash on its side,
      // so even if the one we put in is stale by the time it reaches the
      // validator the simulation still runs.
      tx.feePayer = publicKey;
      if (!tx.recentBlockhash) {
        const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
      }
      let sim;
      try {
        sim = await provider.connection.simulateTransaction(tx, undefined, true);
      } catch (err) {
        throw new TradeTxError(
          "simulation_reverted",
          `Pre-flight simulation could not be performed for "${label}". The RPC node returned an error before the program ran. Likely cause: the RPC endpoint is unreachable or rejected the request. Try again in a few seconds.`,
          null,
          err,
        );
      }
      if (sim.value.err) {
        const logs = sim.value.logs ?? [];
        // Pull the most useful single-line summary from the logs (the final
        // "Program log:" or "Program returned error:" line is usually it).
        // Falls back to the JSON err if logs are empty.
        const lastLog =
          [...logs].reverse().find((l) => /Program log:|failed|error|insufficient/i.test(l)) ?? null;
        const errSummary =
          typeof sim.value.err === "string"
            ? sim.value.err
            : JSON.stringify(sim.value.err);
        const lines: string[] = [
          `On-chain simulation rejected "${label}".`,
          `Reason: ${errSummary}`,
        ];
        if (lastLog) lines.push(`Last program log: ${lastLog}`);
        if (logs.length > 0) {
          lines.push(`(${logs.length} program log line(s) — see the browser console for the full trace.)`);
        }
        throw new TradeTxError("simulation_reverted", lines.join("\n"), logs, sim.value.err);
      }

      // ----- (3) Actual send. -----
      try {
        return await sendTransaction(tx, provider.connection);
      } catch (err) {
        // The wallet adapter wraps the wallet's response in
        // WalletSendTransactionError / WalletSignTransactionError. Both
        // expose a `.error` property with the underlying cause. We walk
        // that chain to surface the most specific message available.
        const walked = walkWalletErrorCause(err);
        throw new TradeTxError("wallet_send_failed", walked.message, walked.logs, err);
      }
    },
    [publicKey, wallet, connected, provider.connection, sendTransaction],
  );

  // ---- Ensure-ATAs helper. Builds an ix that creates any missing ATA.
  const ensureAtas = useCallback(
    async (addrs: MarketAddresses): Promise<{ atas: UserAtas; createIxs: anchor.web3.TransactionInstruction[] }> => {
      if (!publicKey) throw new Error("wallet not connected");
      const usdcMint = new PublicKey(cluster.usdcMint);
      const userUsdc = getAssociatedTokenAddressSync(usdcMint, publicKey);
      const userYes = getAssociatedTokenAddressSync(addrs.yesMint, publicKey);
      const userNo = getAssociatedTokenAddressSync(addrs.noMint, publicKey);
      const accs = await provider.connection.getMultipleAccountsInfo([userUsdc, userYes, userNo]);
      const createIxs: anchor.web3.TransactionInstruction[] = [];
      if (!accs[0]) createIxs.push(createAssociatedTokenAccountInstruction(publicKey, userUsdc, publicKey, usdcMint));
      if (!accs[1]) createIxs.push(createAssociatedTokenAccountInstruction(publicKey, userYes, publicKey, addrs.yesMint));
      if (!accs[2]) createIxs.push(createAssociatedTokenAccountInstruction(publicKey, userNo, publicKey, addrs.noMint));
      return { atas: { userUsdc, userYes, userNo }, createIxs };
    },
    [publicKey, provider.connection],
  );

  const buyYes = useCallback(
    async (priceTicks: number, qty: number): Promise<string> => {
      if (!publicKey || !marketPubkey) throw new Error("wallet or market missing");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const { atas, createIxs } = await ensureAtas(addrs);
      // place_order(Bid, priceTicks, qty).
      // WTF heads-up: Anchor's JS client encodes a Rust enum argument as a
      // single-key object with an empty payload. `OrderSide::Bid` becomes
      // `{ bid: {} }`, `OrderSide::Ask` becomes `{ ask: {} }`. The same
      // shape appears throughout this file (sellYes, cancelOrder, etc.).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .placeOrder({ bid: {} }, priceTicks, new BN(qty))
        .accounts({
          config: PublicKey.findProgramAddressSync(
            [Buffer.from("config"), Buffer.from([1])],
            program.programId,
          )[0],
          market: addrs.market,
          orderBook: addrs.orderBook,
          usdcEscrow: addrs.usdcEscrow,
          yesEscrow: addrs.yesEscrow,
          userUsdc: atas.userUsdc,
          userYes: atas.userYes,
          yesMint: addrs.yesMint,
          user: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const tx = new anchor.web3.Transaction().add(...createIxs, ix);
      return await simulateAndSend("Buy Yes", tx);
    },
    [program, publicKey, marketPubkey, ensureAtas, simulateAndSend],
  );

  const sellYes = useCallback(
    async (priceTicks: number, qty: number): Promise<string> => {
      if (!publicKey || !marketPubkey) throw new Error("wallet or market missing");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const { atas, createIxs } = await ensureAtas(addrs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .placeOrder({ ask: {} }, priceTicks, new BN(qty))
        .accounts({
          config: PublicKey.findProgramAddressSync([Buffer.from("config"), Buffer.from([1])], program.programId)[0],
          market: addrs.market,
          orderBook: addrs.orderBook,
          usdcEscrow: addrs.usdcEscrow,
          yesEscrow: addrs.yesEscrow,
          userUsdc: atas.userUsdc,
          userYes: atas.userYes,
          yesMint: addrs.yesMint,
          user: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const tx = new anchor.web3.Transaction().add(...createIxs, ix);
      return await simulateAndSend("Sell Yes", tx);
    },
    [program, publicKey, marketPubkey, ensureAtas, simulateAndSend],
  );

  // buy_no requires the bid maker's Yes ATA — caller supplies it.
  const buyNo = useCallback(
    async (qty: number, minBidPriceTicks: number, bidMakerOwner: PublicKey): Promise<string> => {
      if (!publicKey || !marketPubkey) throw new Error("wallet or market missing");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const { atas, createIxs } = await ensureAtas(addrs);
      const bidMakerYes = getAssociatedTokenAddressSync(addrs.yesMint, bidMakerOwner);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .buyNo(new BN(qty), minBidPriceTicks)
        .accounts({
          config: PublicKey.findProgramAddressSync([Buffer.from("config"), Buffer.from([1])], program.programId)[0],
          market: addrs.market,
          vaultAuthority: addrs.vaultAuthority,
          yesMint: addrs.yesMint,
          noMint: addrs.noMint,
          vault: addrs.vault,
          orderBook: addrs.orderBook,
          bookAuthority: addrs.bookAuthority,
          usdcEscrow: addrs.usdcEscrow,
          bidMakerYes,
          userUsdc: atas.userUsdc,
          userYes: atas.userYes,
          userNo: atas.userNo,
          user: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const tx = new anchor.web3.Transaction().add(...createIxs, ix);
      return await simulateAndSend("Buy No", tx);
    },
    [program, publicKey, marketPubkey, ensureAtas, simulateAndSend],
  );

  const sellNo = useCallback(
    async (qty: number, maxAskPriceTicks: number, askMakerOwner: PublicKey): Promise<string> => {
      if (!publicKey || !marketPubkey) throw new Error("wallet or market missing");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const { atas, createIxs } = await ensureAtas(addrs);
      const usdcMint = new PublicKey(cluster.usdcMint);
      const askMakerUsdc = getAssociatedTokenAddressSync(usdcMint, askMakerOwner);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .sellNo(new BN(qty), maxAskPriceTicks)
        .accounts({
          config: PublicKey.findProgramAddressSync([Buffer.from("config"), Buffer.from([1])], program.programId)[0],
          market: addrs.market,
          vaultAuthority: addrs.vaultAuthority,
          yesMint: addrs.yesMint,
          noMint: addrs.noMint,
          vault: addrs.vault,
          orderBook: addrs.orderBook,
          bookAuthority: addrs.bookAuthority,
          yesEscrow: addrs.yesEscrow,
          askMakerUsdc,
          userUsdc: atas.userUsdc,
          userYes: atas.userYes,
          userNo: atas.userNo,
          user: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const tx = new anchor.web3.Transaction().add(...createIxs, ix);
      return await simulateAndSend("Sell No", tx);
    },
    [program, publicKey, marketPubkey, ensureAtas, simulateAndSend],
  );

  // mint_pair — convenience for users who want to provide liquidity.
  const mintPair = useCallback(
    async (qty: number): Promise<string> => {
      if (!publicKey || !marketPubkey) throw new Error("wallet or market missing");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const { atas, createIxs } = await ensureAtas(addrs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .mintPair(new BN(qty))
        .accounts({
          config: PublicKey.findProgramAddressSync([Buffer.from("config"), Buffer.from([1])], program.programId)[0],
          market: addrs.market,
          vaultAuthority: addrs.vaultAuthority,
          yesMint: addrs.yesMint,
          noMint: addrs.noMint,
          vault: addrs.vault,
          userUsdc: atas.userUsdc,
          userYes: atas.userYes,
          userNo: atas.userNo,
          user: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const tx = new anchor.web3.Transaction().add(...createIxs, ix);
      return await simulateAndSend("Mint Pair", tx);
    },
    [program, publicKey, marketPubkey, ensureAtas, simulateAndSend],
  );

  // redeem_pair — burn N Yes + N No from the caller's ATAs, receive N USDC
  // back from the vault. Inverse of mint_pair. Pre-settlement only — once a
  // market settles, the asymmetric `redeem` (one side pays $1, the other $0)
  // is the right call. Solves "I minted on an empty-book market and now my
  // USDC is stuck": this instruction lets the user unwind without book
  // liquidity and without waiting for settlement.
  const redeemPair = useCallback(
    async (qty: number): Promise<string> => {
      if (!publicKey || !marketPubkey) throw new Error("wallet or market missing");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const { atas, createIxs } = await ensureAtas(addrs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .redeemPair(new BN(qty))
        .accounts({
          config: PublicKey.findProgramAddressSync([Buffer.from("config"), Buffer.from([1])], program.programId)[0],
          market: addrs.market,
          vaultAuthority: addrs.vaultAuthority,
          yesMint: addrs.yesMint,
          noMint: addrs.noMint,
          vault: addrs.vault,
          userUsdc: atas.userUsdc,
          userYes: atas.userYes,
          userNo: atas.userNo,
          user: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const tx = new anchor.web3.Transaction().add(...createIxs, ix);
      return await simulateAndSend("Redeem Pair", tx);
    },
    [program, publicKey, marketPubkey, ensureAtas, simulateAndSend],
  );

  // cancel_order(side, sequence) — caller passes the order's side ("Bid" or "Ask")
  // and the on-chain sequence number from the order book row. Refunds escrowed
  // USDC (for bids) or Yes tokens (for asks) back to the user's ATA.
  const cancelOrder = useCallback(
    async (side: "bid" | "ask", sequence: bigint): Promise<string> => {
      if (!publicKey || !marketPubkey) throw new Error("wallet or market missing");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const { atas, createIxs } = await ensureAtas(addrs);
      const sideArg = side === "bid" ? { bid: {} } : { ask: {} };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .cancelOrder(sideArg, new BN(sequence.toString()))
        .accounts({
          config: PublicKey.findProgramAddressSync([Buffer.from("config"), Buffer.from([1])], program.programId)[0],
          market: addrs.market,
          orderBook: addrs.orderBook,
          bookAuthority: addrs.bookAuthority,
          usdcEscrow: addrs.usdcEscrow,
          yesEscrow: addrs.yesEscrow,
          userUsdc: atas.userUsdc,
          userYes: atas.userYes,
          user: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const tx = new anchor.web3.Transaction().add(...createIxs, ix);
      return await simulateAndSend("Cancel Order", tx);
    },
    [program, publicKey, marketPubkey, ensureAtas, simulateAndSend],
  );

  return { buyYes, sellYes, buyNo, sellNo, mintPair, redeemPair, cancelOrder, ready: !!publicKey && !!marketPubkey };
}

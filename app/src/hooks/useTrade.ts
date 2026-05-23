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

export function useTrade(marketPubkey: string | undefined) {
  const { program, provider } = useMeridian();
  const { publicKey, sendTransaction } = useWallet();

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
      return await sendTransaction(tx, provider.connection);
    },
    [program, publicKey, marketPubkey, ensureAtas, sendTransaction, provider.connection],
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
      return await sendTransaction(tx, provider.connection);
    },
    [program, publicKey, marketPubkey, ensureAtas, sendTransaction, provider.connection],
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
      return await sendTransaction(tx, provider.connection);
    },
    [program, publicKey, marketPubkey, ensureAtas, sendTransaction, provider.connection],
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
      return await sendTransaction(tx, provider.connection);
    },
    [program, publicKey, marketPubkey, ensureAtas, sendTransaction, provider.connection],
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
      return await sendTransaction(tx, provider.connection);
    },
    [program, publicKey, marketPubkey, ensureAtas, sendTransaction, provider.connection],
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
      return await sendTransaction(tx, provider.connection);
    },
    [program, publicKey, marketPubkey, ensureAtas, sendTransaction, provider.connection],
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
      return await sendTransaction(tx, provider.connection);
    },
    [program, publicKey, marketPubkey, ensureAtas, sendTransaction, provider.connection],
  );

  return { buyYes, sellYes, buyNo, sellNo, mintPair, redeemPair, cancelOrder, ready: !!publicKey && !!marketPubkey };
}

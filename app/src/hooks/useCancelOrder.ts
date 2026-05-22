"use client";

// useCancelOrder — generic cancel_order signer, market-agnostic (caller passes
// the market pubkey). Used by the Portfolio's Open Orders table where each row
// may be on a different market.

import { useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";

import { useMeridian } from "@/hooks/useMeridian";
import { deriveMarketAddresses } from "@/hooks/useTrade";
import { cluster } from "@/lib/cluster";

const BN = anchor.BN ?? (anchor as unknown as { default: { BN: typeof anchor.BN } }).default.BN;

export function useCancelOrder() {
  const { program, provider } = useMeridian();
  const { publicKey, sendTransaction } = useWallet();

  return useCallback(
    async (marketPubkey: string, side: "bid" | "ask", sequence: bigint): Promise<string> => {
      if (!publicKey) throw new Error("wallet not connected");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const usdcMint = new PublicKey(cluster.usdcMint);
      const userUsdc = getAssociatedTokenAddressSync(usdcMint, publicKey);
      const userYes = getAssociatedTokenAddressSync(addrs.yesMint, publicKey);
      const accs = await provider.connection.getMultipleAccountsInfo([userUsdc, userYes]);
      const pre: anchor.web3.TransactionInstruction[] = [];
      if (!accs[0]) pre.push(createAssociatedTokenAccountInstruction(publicKey, userUsdc, publicKey, usdcMint));
      if (!accs[1]) pre.push(createAssociatedTokenAccountInstruction(publicKey, userYes, publicKey, addrs.yesMint));

      const sideArg = side === "bid" ? { bid: {} } : { ask: {} };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .cancelOrder(sideArg, new BN(sequence.toString()))
        .accounts({
          config: PublicKey.findProgramAddressSync(
            [Buffer.from("config"), Buffer.from([1])],
            program.programId,
          )[0],
          market: addrs.market,
          orderBook: addrs.orderBook,
          bookAuthority: addrs.bookAuthority,
          usdcEscrow: addrs.usdcEscrow,
          yesEscrow: addrs.yesEscrow,
          userUsdc,
          userYes,
          user: publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      const tx = new anchor.web3.Transaction().add(...pre, ix);
      return await sendTransaction(tx, provider.connection);
    },
    [program, provider.connection, publicKey, sendTransaction],
  );
}

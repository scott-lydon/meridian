"use client";

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

const BN = anchor.BN;

export type RedeemSide = "yes" | "no";

export function useRedeem() {
  const { program, provider } = useMeridian();
  const { publicKey, sendTransaction } = useWallet();

  return useCallback(
    async (marketPubkey: string, side: RedeemSide, qty: bigint): Promise<string> => {
      if (!publicKey) throw new Error("wallet not connected");
      const addrs = deriveMarketAddresses(program.programId, new PublicKey(marketPubkey));
      const usdcMint = new PublicKey(cluster.usdcMint);
      const userUsdc = getAssociatedTokenAddressSync(usdcMint, publicKey);
      const userYes = getAssociatedTokenAddressSync(addrs.yesMint, publicKey);
      const userNo = getAssociatedTokenAddressSync(addrs.noMint, publicKey);
      const accs = await provider.connection.getMultipleAccountsInfo([userUsdc, userYes, userNo]);
      const pre: anchor.web3.TransactionInstruction[] = [];
      if (!accs[0]) pre.push(createAssociatedTokenAccountInstruction(publicKey, userUsdc, publicKey, usdcMint));
      if (!accs[1]) pre.push(createAssociatedTokenAccountInstruction(publicKey, userYes, publicKey, addrs.yesMint));
      if (!accs[2]) pre.push(createAssociatedTokenAccountInstruction(publicKey, userNo, publicKey, addrs.noMint));

      const sideArg = side === "yes" ? { yes: {} } : { no: {} };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ix = await (program.methods as any)
        .redeem(sideArg, new BN(qty.toString()))
        .accounts({
          config: PublicKey.findProgramAddressSync(
            [Buffer.from("config"), Buffer.from([1])],
            program.programId,
          )[0],
          market: addrs.market,
          vaultAuthority: addrs.vaultAuthority,
          yesMint: addrs.yesMint,
          noMint: addrs.noMint,
          vault: addrs.vault,
          userUsdc,
          userYes,
          userNo,
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

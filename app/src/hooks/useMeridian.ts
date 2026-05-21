"use client";

// useMeridian — returns the typed Anchor Program client.
//
// When wallet is connected, the provider can sign. When not, returns a
// read-only client that can fetch accounts but not submit transactions.

import { useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";

import { meridianProgram, readOnlyProvider } from "@/lib/anchor";

export function useMeridian() {
  const { connection } = useConnection();
  const wallet = useWallet();

  return useMemo(() => {
    if (wallet.publicKey && wallet.signTransaction && wallet.signAllTransactions) {
      const provider = new anchor.AnchorProvider(
        connection,
        {
          publicKey: wallet.publicKey,
          signTransaction: wallet.signTransaction,
          signAllTransactions: wallet.signAllTransactions,
        } as anchor.Wallet,
        { commitment: "confirmed" },
      );
      return { program: meridianProgram(provider), provider, isWritable: true };
    }
    const provider = readOnlyProvider(connection);
    return { program: meridianProgram(provider), provider, isWritable: false };
  }, [connection, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);
}

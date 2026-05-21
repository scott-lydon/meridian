"use client";

// Anchor client + program loader.
//
// Per plan.md §2.3 the client wraps the generated IDL into a typed Program
// instance, exposed via the useMeridian() hook. Read paths can use a
// read-only provider; write paths bind to the connected wallet.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";

import idlJson from "@/idl/meridian.json";
import { cluster } from "@/lib/cluster";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Meridian = anchor.Idl & Record<string, any>;

export function programIdPubkey(): PublicKey {
  return new PublicKey(cluster.programId);
}

export function readOnlyProvider(connection: Connection): anchor.AnchorProvider {
  const dummyWallet: AnchorWallet = {
    publicKey: PublicKey.default,
    signTransaction: async () => {
      throw new Error("read-only provider cannot sign");
    },
    signAllTransactions: async () => {
      throw new Error("read-only provider cannot sign");
    },
  };
  return new anchor.AnchorProvider(connection, dummyWallet, {
    commitment: "confirmed",
  });
}

export function meridianProgram(
  provider: anchor.AnchorProvider,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): anchor.Program<any> {
  // Anchor 0.30 client signature: new Program(idl, provider).
  // The IDL already carries the program-id (anchor 0.30+).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (anchor as any).Program(idlJson as Meridian, provider);
}

// === Seeds + PDA helpers (mirror programs/meridian/src/constants.rs) ===
export const PROGRAM_VERSION_BYTE = Buffer.from([1]);
export const CONFIG_SEED = Buffer.from("config");
export const MARKET_SEED = Buffer.from("market");
export const VAULT_AUTH_SEED = Buffer.from("vault_auth");
export const YES_MINT_SEED = Buffer.from("yes_mint");
export const NO_MINT_SEED = Buffer.from("no_mint");
export const ORDER_BOOK_SEED = Buffer.from("book");
export const BOOK_AUTH_SEED = Buffer.from("book_auth");
export const TICKER_LEN = 6;

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CONFIG_SEED, PROGRAM_VERSION_BYTE],
    programIdPubkey(),
  )[0];
}

export function marketPda(
  tradingDayUnix: bigint,
  ticker: string,
  strikeUsdMicros: bigint,
): PublicKey {
  const tickerBuf = Buffer.alloc(TICKER_LEN);
  tickerBuf.write(ticker.toUpperCase(), "ascii");
  const day = Buffer.alloc(8);
  day.writeBigInt64LE(tradingDayUnix);
  const strike = Buffer.alloc(8);
  strike.writeBigUInt64LE(strikeUsdMicros);
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, day, tickerBuf, strike, PROGRAM_VERSION_BYTE],
    programIdPubkey(),
  )[0];
}

export function tickerFromBytes(bytes: number[] | Uint8Array): string {
  const buf = Buffer.from(bytes);
  // Trim trailing nulls.
  const end = buf.indexOf(0);
  return end === -1 ? buf.toString("ascii") : buf.slice(0, end).toString("ascii");
}

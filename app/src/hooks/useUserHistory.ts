"use client";

// useUserHistory — recent Meridian-program transactions for the connected wallet.
//
// Approach:
//   1. `getSignaturesForAddress(user, limit=100)` returns the user's recent sigs
//      across all programs.
//   2. We batch-fetch the parsed transactions (chunked at 50) and keep only
//      those that contain at least one instruction whose `programId` matches
//      Meridian.
//   3. We decode the Anchor instruction name from the first 8 bytes of the
//      instruction data (Anchor's discriminator = sha256("global:<method>")[:8]).
//      Discriminators are pre-baked below so this hook stays synchronous.
//
// This is the audit view US-14 calls for: real transactions the connected user
// signed against the Meridian program, with timestamp, success/fail, and one
// click to Solana Explorer.

import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { type ParsedInstruction, type PartiallyDecodedInstruction } from "@solana/web3.js";

import { programIdPubkey } from "@/lib/anchor";

export interface UserTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Anchor instruction name when we recognise the discriminator. */
  method: string;
  success: boolean;
  /** Truncated error log when the tx failed. */
  errLog?: string;
}

// Precomputed Anchor discriminators (hex of first 8 bytes of sha256("global:<method>")).
// Keep aligned with programs/meridian/src/lib.rs. Generated once via:
//   node -e "const c=require('crypto'); const m=['initialize_config',...]; ..."
const DISCRIMINATORS: Record<string, string> = {
  d07f1501c2bec446: "initialize_config",
  "15a2327744dadd23": "create_strike_market",
  "13955e6eb5ba216b": "mint_pair",
  b80c569546c461e1: "redeem",
  a487a59f0941c1fd: "settle_market_manual",
  "8adadd7660dc4b0b": "admin_settle",
  c1995fd8a60690d9: "settle_market",
  d316ddfb4a79c12f: "pause",
  a99004260a8dbcff: "unpause",
  e113585ae9f68c54: "init_order_book",
  "33c29baf6d82606a": "place_order",
  "5f81edf00831df84": "cancel_order",
  "1101c95d0733fb86": "match_orders",
  "59f0f410c4c9bea3": "buy_no",
  bdc2842a50f99a67: "sell_no",
};

// Minimal base58 decoder so we don't pull in `bs58` for 8 bytes.
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58decode(s: string): Uint8Array {
  const map: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) map[B58_ALPHABET[i]!] = i;
  const bytes: number[] = [0];
  for (const c of s) {
    const v = map[c];
    if (v === undefined) throw new Error(`invalid base58 char: ${c}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i]!.toString(16).padStart(2, "0");
  return h;
}

function decodeMethod(ix: ParsedInstruction | PartiallyDecodedInstruction): string {
  if ("data" in ix && typeof ix.data === "string") {
    try {
      const bytes = bs58decode(ix.data);
      if (bytes.length >= 8) {
        const hex = bytesToHex(bytes.slice(0, 8));
        const m = DISCRIMINATORS[hex];
        if (m) return m;
      }
    } catch {
      /* fall through */
    }
    return "meridian:unknown";
  }
  return "meridian:unknown";
}

export function useUserHistory(limit = 50) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery<UserTx[]>({
    queryKey: ["user-history", publicKey?.toBase58() ?? "?", limit],
    enabled: !!publicKey,
    queryFn: async () => {
      if (!publicKey) return [];
      const sigs = await connection.getSignaturesForAddress(publicKey, {
        limit: Math.min(limit * 4, 200),
      });
      if (sigs.length === 0) return [];
      const signatures = sigs.map((s) => s.signature);
      const chunks: string[][] = [];
      for (let i = 0; i < signatures.length; i += 50) chunks.push(signatures.slice(i, i + 50));
      const meridianPid = programIdPubkey().toBase58();
      const out: UserTx[] = [];
      for (const chunk of chunks) {
        const txs = await connection.getParsedTransactions(chunk, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        for (let i = 0; i < txs.length; i++) {
          const tx = txs[i];
          if (!tx) continue;
          const ixs = tx.transaction.message.instructions;
          const meridianIxs = ixs.filter((ix) => ix.programId.toBase58() === meridianPid);
          if (meridianIxs.length === 0) continue;
          const method = decodeMethod(meridianIxs[0]!);
          const err = tx.meta?.err;
          const success = err == null;
          const errLogLine = success
            ? undefined
            : tx.meta?.logMessages?.find((l) => l.toLowerCase().includes("err"));
          const base = {
            signature: chunk[i]!,
            slot: tx.slot,
            blockTime: tx.blockTime ?? null,
            method,
            success,
          };
          out.push(errLogLine ? { ...base, errLog: errLogLine.slice(0, 160) } : base);
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      return out;
    },
    refetchInterval: 8_000,
  });
}

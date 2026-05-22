"use client";

// useUserHistory (US-14) — connected wallet's Meridian-program transactions
// from the last 30 days, with:
//   - human-friendly action label (e.g. "Buy Yes 5 @ $0.62"),
//   - resulting USDC balance change (positive = USDC received, negative = paid),
//   - timestamp, success/fail, explorer-linked signature.
//
// Decoding:
//   * 8-byte Anchor discriminator → instruction name (sha256("global:<m>")[:8]).
//     Discriminators are precomputed once below so this hook stays sync.
//   * Args are packed little-endian after the discriminator. We decode only
//     the families we actually surface: place_order, buy_no, sell_no, redeem,
//     mint_pair, cancel_order. Anything else gets a generic label.
//   * USDC delta comes from tx.meta.preTokenBalances vs postTokenBalances
//     filtered by owner === user and mint === USDC mint.

import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";

import { programIdPubkey } from "@/lib/anchor";
import { cluster } from "@/lib/cluster";
import { formatUsdc, usdcFromBase } from "@/lib/usdc";

export interface UserTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Human action label, e.g. "Buy Yes 5 @ $0.62" or "Redeem Yes 10". */
  label: string;
  /** Underlying Anchor method name, kept for advanced users. */
  method: string;
  success: boolean;
  /**
   * Net USDC change in the user's USDC ATA from this tx, in USDC micros.
   * Positive = user received USDC. Negative = user paid USDC. Undefined =
   * no change or no token balance metadata available.
   */
  usdcDeltaMicros?: bigint;
  /** Truncated error log when the tx failed. */
  errLog?: string;
}

// Anchor discriminators (hex of first 8 bytes of sha256("global:<method>")).
// Generated once via:
//   node -e "const c=require('crypto'); for (const m of [...]) console.log(c.createHash('sha256').update('global:'+m).digest('hex').slice(0,16), m)"
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

// Minimal base58 decoder (avoids pulling in bs58 just for 8-byte decoding).
//
// IMPORTANT — bug history: the accumulator MUST start as `[]`, not `[0]`.
// Caught by qa-adversary property test on 2026-05-21 with counterexample
// `Uint8Array.from([0])`: an `[0]` init silently adds one extra leading zero
// byte to every decoded result. For non-leading-zero inputs the artifact
// gets shifted into a real byte position and works by accident; for inputs
// that decode to bytes starting with 0x00 (≈1/256 of Anchor tx data), the
// extra byte makes `bytes.slice(0, 8)` read the wrong discriminator and the
// instruction label silently falls through to "meridian:unknown".
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58decode(s: string): Uint8Array {
  const map: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) map[B58_ALPHABET[i]!] = i;
  const bytes: number[] = [];
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

function readU64LE(b: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(b[offset + i]!) << BigInt(i * 8);
  return v;
}

function readU32LE(b: Uint8Array, offset: number): number {
  return b[offset]! | (b[offset + 1]! << 8) | (b[offset + 2]! << 16) | (b[offset + 3]! << 24);
}

interface DecodedIx {
  method: string;
  /** Anchor arg bytes (everything after the 8-byte discriminator). */
  args: Uint8Array;
}

function decodeIx(ix: ParsedInstruction | PartiallyDecodedInstruction): DecodedIx | null {
  if (!("data" in ix) || typeof ix.data !== "string") return null;
  let bytes: Uint8Array;
  try {
    bytes = bs58decode(ix.data);
  } catch {
    return null;
  }
  if (bytes.length < 8) return null;
  const disc = bytesToHex(bytes.slice(0, 8));
  const method = DISCRIMINATORS[disc];
  if (!method) return null;
  return { method, args: bytes.slice(8) };
}

// price_ticks are in 0.01 USDC increments (1 tick = $0.01 = 10_000 micros).
function ticksToUsdcMicros(ticks: number): bigint {
  return BigInt(ticks) * 10_000n;
}

function humanLabel(ix: DecodedIx): string {
  const { method, args } = ix;
  try {
    switch (method) {
      case "place_order": {
        // side(1) + price_ticks(4) + qty(8)
        if (args.length < 13) return method;
        const side = args[0]! === 0 ? "Bid" : args[0]! === 1 ? "Ask" : `?${args[0]}`;
        const priceTicks = readU32LE(args, 1);
        const qty = readU64LE(args, 5);
        // Bid on Yes = "Buy Yes"; Ask on Yes = "Sell Yes". The book is single-sided on Yes only.
        const verb = side === "Bid" ? "Buy" : side === "Ask" ? "Sell" : "Place";
        return `${verb} Yes ${qty.toString()} @ ${formatUsdc(usdcFromBase(ticksToUsdcMicros(priceTicks)))}`;
      }
      case "buy_no": {
        // qty(8) + min_bid_price_ticks(4)
        if (args.length < 12) return method;
        const qty = readU64LE(args, 0);
        const minBid = readU32LE(args, 8);
        return `Buy No ${qty.toString()} (min Yes-bid ${formatUsdc(usdcFromBase(ticksToUsdcMicros(minBid)))})`;
      }
      case "sell_no": {
        // qty(8) + max_ask_price_ticks(4)
        if (args.length < 12) return method;
        const qty = readU64LE(args, 0);
        const maxAsk = readU32LE(args, 8);
        return `Sell No ${qty.toString()} (max Yes-ask ${formatUsdc(usdcFromBase(ticksToUsdcMicros(maxAsk)))})`;
      }
      case "redeem": {
        // side(1) + qty(8)
        if (args.length < 9) return method;
        const side = args[0]! === 0 ? "Yes" : args[0]! === 1 ? "No" : `?${args[0]}`;
        const qty = readU64LE(args, 1);
        return `Redeem ${side} ${qty.toString()}`;
      }
      case "mint_pair": {
        if (args.length < 8) return method;
        const qty = readU64LE(args, 0);
        return `Mint pair ${qty.toString()}`;
      }
      case "cancel_order": {
        if (args.length < 9) return method;
        const side = args[0]! === 0 ? "Bid" : args[0]! === 1 ? "Ask" : `?${args[0]}`;
        const seq = readU64LE(args, 1);
        return `Cancel ${side} #${seq.toString()}`;
      }
      case "create_strike_market":
        return "Create strike market (admin)";
      case "settle_market":
      case "settle_market_manual":
        return "Settle market (auto)";
      case "admin_settle":
        return "Settle market (admin)";
      case "pause":
        return "Pause program (admin)";
      case "unpause":
        return "Unpause program (admin)";
      case "init_order_book":
        return "Init order book (admin)";
      case "initialize_config":
        return "Initialize config (admin)";
      case "match_orders":
        return "Match orders (crank)";
      default:
        return method;
    }
  } catch {
    // If decoding ever fails, fall back to the method name rather than crashing
    // the whole history table.
    return method;
  }
}

function usdcDeltaForUser(tx: ParsedTransactionWithMeta, userPubkey: string): bigint | undefined {
  const meta = tx.meta;
  if (!meta?.preTokenBalances || !meta?.postTokenBalances) return undefined;
  const usdcMint = cluster.usdcMint;
  const findEntry = (
    list: NonNullable<typeof meta.preTokenBalances>,
  ): bigint | undefined => {
    const hit = list.find((b) => b.owner === userPubkey && b.mint === usdcMint);
    if (!hit?.uiTokenAmount?.amount) return undefined;
    return BigInt(hit.uiTokenAmount.amount);
  };
  const pre = findEntry(meta.preTokenBalances);
  const post = findEntry(meta.postTokenBalances);
  if (pre === undefined && post === undefined) return undefined;
  return (post ?? 0n) - (pre ?? 0n);
}

export function useUserHistory(limit = 50, days = 30) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  return useQuery<UserTx[]>({
    queryKey: ["user-history", publicKey?.toBase58() ?? "?", limit, days],
    enabled: !!publicKey,
    queryFn: async () => {
      if (!publicKey) return [];
      const sigs = await connection.getSignaturesForAddress(publicKey, {
        // Pull enough to cover the window after we filter out non-Meridian txs.
        limit: Math.min(Math.max(limit * 4, 100), 500),
      });
      if (sigs.length === 0) return [];
      const cutoffUnix = Math.floor(Date.now() / 1000) - days * 24 * 3600;
      const inWindow = sigs.filter((s) => (s.blockTime ?? Number.MAX_SAFE_INTEGER) >= cutoffUnix);
      const signatures = inWindow.map((s) => s.signature);
      if (signatures.length === 0) return [];
      const chunks: string[][] = [];
      for (let i = 0; i < signatures.length; i += 50) chunks.push(signatures.slice(i, i + 50));
      const meridianPid = programIdPubkey().toBase58();
      const userBase58 = publicKey.toBase58();
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
          const firstIx = meridianIxs[0]!;
          const decoded = decodeIx(firstIx);
          const method = decoded?.method ?? "meridian:unknown";
          const label = decoded ? humanLabel(decoded) : method;
          const err = tx.meta?.err;
          const success = err == null;
          const delta = usdcDeltaForUser(tx, userBase58);
          const errLogLine = success
            ? undefined
            : tx.meta?.logMessages?.find((l) => l.toLowerCase().includes("err"));
          const record: UserTx = {
            signature: chunk[i]!,
            slot: tx.slot,
            blockTime: tx.blockTime ?? null,
            label,
            method,
            success,
          };
          if (delta !== undefined && delta !== 0n) record.usdcDeltaMicros = delta;
          if (errLogLine) record.errLog = errLogLine.slice(0, 160);
          out.push(record);
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      return out;
    },
    refetchInterval: 8_000,
  });
}

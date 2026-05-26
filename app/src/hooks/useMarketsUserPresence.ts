"use client";

// useMarketsUserPresence — per-market YES/NO/open-order presence for the
// connected wallet, intended for the Markets index view's "you have
// something here" badge.
//
// Why a dedicated hook instead of reusing useUserPositions +
// useUserOpenOrders:
//   * Both of those hooks loop over markets and issue ONE RPC per ATA
//     plus ONE RPC per order book. On a ladder of ~21 markets that is
//     12+ RPCs every 5s, well above the public devnet's ~5 RPS limit.
//     Adding them as additional hooks on a high-traffic page (the Markets
//     index, which is the default landing) would push us past the
//     soft-fail threshold the History page is already hitting (US-14
//     "Too many requests for a specific RPC call" report on 2026-05-25).
//   * The Markets index only needs YES_BAL > 0 / NO_BAL > 0 / OPEN_BIDS / OPEN_ASKS,
//     not the full mark-to-market calc. A cheaper read is appropriate.
//
// Cost model:
//   * 1 RPC: getMultipleAccountsInfo of all (yesAta, noAta) pairs across
//     every market in one call (Solana caps at 100 keys; we chunk if
//     needed). Decoding token balance is a fixed-offset u64 read.
//   * 1 RPC: program.account.orderBook.fetchMultiple() of all per-market
//     book PDAs. Anchor returns the decoded structs directly.
//   * Total ≈ 2 RPC per refresh, polling at 10s → 0.2 RPS. Safe.
//
// Returned shape is a Map keyed by market.pubkey so the page render can
// O(1) lookup. Empty map when wallet disconnected.

import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { useMeridian } from "@/hooks/useMeridian";
import { useMarkets } from "@/hooks/useMarkets";
import { deriveMarketAddresses } from "@/hooks/useTrade";

export interface UserPresence {
  /** YES SPL token balance for the connected wallet on this market. */
  yes: bigint;
  /** NO SPL token balance for the connected wallet on this market. */
  no: bigint;
  /** Count of resting BIDS the user owns on this market's order book. */
  openBids: number;
  /** Count of resting ASKS the user owns on this market's order book. */
  openAsks: number;
}

const EMPTY_PRESENCE: UserPresence = { yes: 0n, no: 0n, openBids: 0, openAsks: 0 };

/**
 * SPL token-account layout has `amount` (u64 little-endian) at offset 64.
 * See `@solana/spl-token` AccountLayout for the canonical struct definition.
 * Manual decode avoids pulling the full AccountLayout decode dependency in
 * here for a single field; throws on a too-short buffer so a corrupted RPC
 * response shows up as a clear error instead of silently returning 0.
 */
function readTokenAmount(data: Buffer): bigint {
  if (data.length < 72) {
    throw new Error(
      `useMarketsUserPresence: token account data too short (got ${data.length} bytes, expected at least 72). Likely a non-token-program account at the ATA address — check the mint + owner derivation.`,
    );
  }
  // Buffer.readBigUInt64LE handles the LE -> bigint conversion natively.
  return data.readBigUInt64LE(64);
}

export function useMarketsUserPresence() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { program } = useMeridian();
  const markets = useMarkets();

  return useQuery<Map<string, UserPresence>>({
    queryKey: [
      "markets-user-presence",
      publicKey?.toBase58() ?? "?",
      markets.data?.length ?? 0,
    ],
    enabled: !!publicKey && !!markets.data && (markets.data?.length ?? 0) > 0,
    // Markets index page does NOT need real-time freshness. 10s is fine —
    // a position only changes on user action, and the user already sees
    // the authoritative truth on the per-market trade page.
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const result = new Map<string, UserPresence>();
      if (!publicKey || !markets.data) return result;

      // ---- Step 1: derive every YES/NO ATA + book PDA in one pass.
      interface PerMarket {
        marketPubkey: string;
        yesAta: PublicKey;
        noAta: PublicKey;
        bookPda: PublicKey;
      }
      const perMarket: PerMarket[] = [];
      for (const m of markets.data) {
        const marketPk = new PublicKey(m.pubkey);
        const addrs = deriveMarketAddresses(program.programId, marketPk);
        perMarket.push({
          marketPubkey: m.pubkey,
          yesAta: getAssociatedTokenAddressSync(addrs.yesMint, publicKey),
          noAta: getAssociatedTokenAddressSync(addrs.noMint, publicKey),
          // Reuse the same book-PDA derivation as the trade page and
          // useUserOpenOrders. Hard-coding the version byte (1) here would
          // diverge from the source of truth in anchor.ts; the indirection
          // through deriveMarketAddresses + PROGRAM_VERSION_BYTE keeps a
          // future v2 program rebuild from silently breaking this hook.
          bookPda: PublicKey.findProgramAddressSync(
            [Buffer.from("book"), marketPk.toBuffer(), Buffer.from([1])],
            program.programId,
          )[0],
        });
      }

      // ---- Step 2: batched token-balance fetch.
      // getMultipleAccountsInfo accepts up to 100 keys per call; chunk
      // defensively in case a future ladder exceeds that ceiling.
      const tokenKeys: PublicKey[] = perMarket.flatMap((m) => [m.yesAta, m.noAta]);
      const tokenAccounts: ({ data: Buffer } | null)[] = [];
      for (let i = 0; i < tokenKeys.length; i += 100) {
        const chunk = tokenKeys.slice(i, i + 100);
        const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
        for (const info of infos) {
          if (!info) {
            tokenAccounts.push(null);
            continue;
          }
          // AccountInfo.data is a Buffer at runtime even though the type
          // annotation says `Buffer | Uint8Array`. Cast through the parent
          // to keep readBigUInt64LE available.
          tokenAccounts.push({ data: Buffer.from(info.data) });
        }
      }

      // ---- Step 3: batched order-book fetch.
      // Anchor's fetchMultiple does the get-multiple-accounts call AND the
      // borsh decode in one round-trip, returning null for accounts that
      // don't exist yet (book hasn't been init'd for this market).
      const bookPdas = perMarket.map((m) => m.bookPda);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const books = await (program.account as any).orderBook.fetchMultiple(bookPdas);

      // ---- Step 4: stitch results back into per-market presence.
      const userBase58 = publicKey.toBase58();
      for (let i = 0; i < perMarket.length; i++) {
        const { marketPubkey } = perMarket[i]!;
        // Token offsets in the flat array: market i lives at indices 2i
        // (YES) and 2i+1 (NO). This MUST stay in lockstep with the
        // flatMap above; if the order ever changes, the decoded balances
        // would silently swap and a user holding YES would see "NO 4" in
        // the badge. Spelled out as named locals so the invariant is
        // visible at the call site rather than buried in arithmetic.
        const yesInfo = tokenAccounts[2 * i] ?? null;
        const noInfo = tokenAccounts[2 * i + 1] ?? null;
        const yes = yesInfo ? readTokenAmount(yesInfo.data) : 0n;
        const no = noInfo ? readTokenAmount(noInfo.data) : 0n;

        let openBids = 0;
        let openAsks = 0;
        const book = books[i];
        if (book) {
          // book.bids / book.asks are fixed-size slabs; book.bidsLen /
          // book.asksLen are the populated prefix lengths. Iterate only
          // the populated prefix so stale (zeroed) trailing entries don't
          // count.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const b: any = book;
          const bidsLen: number = Number(b.bidsLen ?? 0);
          const asksLen: number = Number(b.asksLen ?? 0);
          for (let j = 0; j < bidsLen; j++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const o: any = b.bids[j];
            if ((o.owner as PublicKey).toBase58() === userBase58) openBids++;
          }
          for (let j = 0; j < asksLen; j++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const o: any = b.asks[j];
            if ((o.owner as PublicKey).toBase58() === userBase58) openAsks++;
          }
        }

        if (yes > 0n || no > 0n || openBids > 0 || openAsks > 0) {
          result.set(marketPubkey, { yes, no, openBids, openAsks });
        }
      }
      return result;
    },
  });
}

/**
 * Tiny helper used by the Markets card render so the badge JSX stays
 * focused on layout, not data shape. Returns the empty-presence sentinel
 * (all zeros) when the wallet is disconnected or the market is missing —
 * the badge then renders nothing, matching the "wallet disconnected = no
 * badge" UX contract.
 */
export function presenceFor(
  map: Map<string, UserPresence> | undefined,
  marketPubkey: string,
): UserPresence {
  return map?.get(marketPubkey) ?? EMPTY_PRESENCE;
}

export function hasAnyPresence(p: UserPresence): boolean {
  return p.yes > 0n || p.no > 0n || p.openBids > 0 || p.openAsks > 0;
}

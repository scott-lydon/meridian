// Dump the current state of one (or all) Meridian order book(s) on devnet.
//
// The CLOB is a live state-of-pending-intent: it is NOT a ledger and only
// shows orders currently resting. Fills and cancels remove their entry; the
// history of those events lives in the Solana chain's transaction log, not
// in the OrderBook account.
//
// Usage:
//   pnpm exec tsx scripts/dump-orderbook.ts                  # list all markets + their books
//   pnpm exec tsx scripts/dump-orderbook.ts <market_pubkey>  # dump one specific book
//   pnpm exec tsx scripts/dump-orderbook.ts --mainnet        # against mainnet-beta (use with care)
//
// Optional env:
//   MERIDIAN_RPC_URL   override the RPC endpoint
//
// Failure cases (each throws with a clear message):
//   - IDL file missing  → run `anchor build` first
//   - market PDA does not exist  → "market <pk> not found on <cluster>"
//   - book PDA does not exist for a known market  → "book PDA missing for market <pk>"
//     (means create_strike_market was called but init_order_book was never run; bug to surface)
//
// CLI output is plain text so it pipes into grep / jq / less without ANSI noise.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const DEFAULT_RPC = "https://api.devnet.solana.com";
const MAINNET_RPC = "https://api.mainnet-beta.solana.com";
const PROGRAM_VERSION = 1; // matches programs/meridian/src/constants.rs

function abbrev(pk: string, head = 6, tail = 4): string {
  return pk.length > head + tail + 3 ? `${pk.slice(0, head)}…${pk.slice(-tail)}` : pk;
}

function fmtCents(priceTicks: number): string {
  // priceTicks 1..=99 maps to $0.01..=$0.99; format as 3-character "27¢"
  return `${String(priceTicks).padStart(2, " ")}¢`;
}

function loadIdl(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idl: any;
  idlPath: string;
} {
  const idlPath = resolvePath(import.meta.dirname, "..", "target", "idl", "meridian.json");
  let raw: string;
  try {
    raw = readFileSync(idlPath, "utf-8");
  } catch (err) {
    throw new Error(
      `dump-orderbook: cannot read IDL at ${idlPath} — run \`anchor build\` first. Underlying: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { idl: JSON.parse(raw), idlPath };
}

function bookPdaFor(programId: PublicKey, marketPda: PublicKey): PublicKey {
  // Seeds match init_order_book: [b"book", market_pubkey, [PROGRAM_VERSION]]
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("book"), marketPda.toBuffer(), Buffer.from([PROGRAM_VERSION])],
    programId,
  );
  return pda;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function dumpOne(program: any, marketPda: PublicKey, marketLabel: string): Promise<void> {
  const bookPda = bookPdaFor(program.programId, marketPda);
  let book: any;
  try {
    book = await program.account.orderBook.fetch(bookPda);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Account does not exist|could not find account/i.test(msg)) {
      console.log(`\n=== ${marketLabel} ===`);
      console.log(`  market: ${marketPda.toBase58()}`);
      console.log(`  book:   ${bookPda.toBase58()}`);
      console.log("  (order book PDA does not exist — init_order_book was not run for this market)");
      return;
    }
    throw new Error(
      `dump-orderbook: failed to decode book PDA ${bookPda.toBase58()} for market ${marketPda.toBase58()}: ${msg}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }

  const bidsLen = Number(book.bidsLen);
  const asksLen = Number(book.asksLen);
  // Order schema (zero-copy): qty u64, sequence u64, owner Pubkey, price_ticks u32, side u8, _pad [u8;3]
  const bids = (book.bids as any[]).slice(0, bidsLen);
  const asks = (book.asks as any[]).slice(0, asksLen);

  console.log(`\n=== ${marketLabel} ===`);
  console.log(`  market: ${marketPda.toBase58()}`);
  console.log(`  book:   ${bookPda.toBase58()}`);
  console.log(`  bids: ${bidsLen} resting   asks: ${asksLen} resting   next_seq: ${book.nextSequence}`);

  if (bidsLen === 0 && asksLen === 0) {
    console.log("  (empty book)");
    return;
  }

  // Print both sides side-by-side at the same row, sorted descending bids / ascending asks
  // (already how the slab is stored — see order_book.rs insert_slab()).
  console.log("");
  console.log("    BIDS (Buy Yes, Sell No view)                ASKS (Sell Yes, Buy No view)");
  console.log("    price   qty        owner                    price   qty        owner");
  console.log("    -----   --------   ----------------------   -----   --------   ----------------------");
  const rows = Math.max(bidsLen, asksLen);
  for (let i = 0; i < rows; i++) {
    const b = bids[i];
    const a = asks[i];
    const bidStr = b
      ? `${fmtCents(Number(b.priceTicks))}   ${String(b.qty).padStart(8, " ")}   ${abbrev(
          (b.owner as PublicKey).toBase58(),
          12,
          6,
        ).padEnd(22, " ")}`
      : "                                       ";
    const askStr = a
      ? `${fmtCents(Number(a.priceTicks))}   ${String(a.qty).padStart(8, " ")}   ${abbrev(
          (a.owner as PublicKey).toBase58(),
          12,
          6,
        ).padEnd(22, " ")}`
      : "";
    console.log(`    ${bidStr}   ${askStr}`);
  }

  // Best-bid / best-ask quote at the bottom, mirrored to No view
  if (bidsLen > 0 || asksLen > 0) {
    console.log("");
    const bestBid = bidsLen > 0 ? Number(bids[0].priceTicks) : null;
    const bestAsk = asksLen > 0 ? Number(asks[0].priceTicks) : null;
    if (bestBid !== null) {
      console.log(`  Yes best bid: ${fmtCents(bestBid)}  →  implied No best ask: ${fmtCents(100 - bestBid)}`);
    }
    if (bestAsk !== null) {
      console.log(`  Yes best ask: ${fmtCents(bestAsk)}  →  implied No best bid: ${fmtCents(100 - bestAsk)}`);
    }
    if (bestBid !== null && bestAsk !== null) {
      const mid = (bestBid + bestAsk) / 2;
      console.log(`  Mid: ${mid.toFixed(1)}¢   spread: ${bestAsk - bestBid}¢`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isMainnet = args.includes("--mainnet");
  const positional = args.filter((a) => !a.startsWith("--"));
  const rpc =
    process.env.MERIDIAN_RPC_URL ?? (isMainnet ? MAINNET_RPC : DEFAULT_RPC);
  const connection = new Connection(rpc, "confirmed");

  // Read-only provider: no wallet needed since we are only fetching accounts.
  const provider = new anchor.AnchorProvider(
    connection,
    {} as anchor.Wallet, // never signs in this script
    { commitment: "confirmed" },
  );
  const { idl, idlPath } = loadIdl();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program: any = new (anchor as any).Program(idl, provider);

  console.log(`Meridian dump-orderbook — RPC: ${rpc}`);
  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(`IDL:        ${idlPath}`);

  // Anchor returns u64 fields as BN (BigNumber), not number — `Number(bn)` is
  // NaN. The right call is `bn.toString()` then BigInt/parseFloat. Helper here
  // so every label uses the same conversion.
  function strikeUsd(strike: unknown): string {
    if (strike == null) return "<no strikeUsdMicros field>";
    const asStr = (strike as { toString(): string }).toString();
    // Strike is stored in 6-decimal USDC base units (micros): e.g. $680.00 == 680_000_000.
    // See programs/meridian/src/state.rs `strike_usd_micros` field.
    const dollars = Number(asStr) / 1_000_000;
    return Number.isFinite(dollars) ? `$${dollars.toFixed(2)}` : `<unparseable strike ${asStr}>`;
  }
  function dayLabel(tradingDayUnix: unknown): string {
    if (tradingDayUnix == null) return "<no tradingDayUnix field>";
    const asStr = (tradingDayUnix as { toString(): string }).toString();
    const secs = Number(asStr);
    if (!Number.isFinite(secs)) return `day ${asStr}`;
    return new Date(secs * 1000).toISOString().slice(0, 10);
  }

  if (positional.length === 1) {
    const marketPda = new PublicKey(positional[0]);
    let label = "explicit market";
    try {
      const market = await program.account.market.fetch(marketPda);
      const ticker = Buffer.from(market.ticker as Uint8Array)
        .toString("utf-8")
        .replace(/\0+$/u, "");
      label = `${ticker} strike ${strikeUsd(market.strikeUsdMicros)} day ${dayLabel(market.tradingDayUnix)}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `dump-orderbook: market ${marketPda.toBase58()} not found on ${rpc}. ${msg}`,
      );
    }
    await dumpOne(program, marketPda, label);
    return;
  }

  // No arg → enumerate all Market accounts. Sort so books with resting orders
  // come first, then empty books, then markets with no book PDA. Within each
  // bucket sort by trading day descending then ticker. The empty-and-missing
  // buckets are noisy on a long-lived devnet so surfacing the interesting rows
  // up top makes the output skimmable.
  const all = await program.account.market.all();
  if (all.length === 0) {
    console.log("\n(no markets found on this cluster)");
    return;
  }

  type Enriched = {
    pda: PublicKey;
    label: string;
    bookPda: PublicKey;
    bookStatus: "with-orders" | "empty" | "missing";
    restingCount: number;
    tradingDayUnix: number;
  };
  const enriched: Enriched[] = [];
  for (const m of all) {
    const ticker = Buffer.from(m.account.ticker as Uint8Array)
      .toString("utf-8")
      .replace(/\0+$/u, "");
    const dayUnix = Number((m.account.tradingDayUnix as { toString(): string }).toString());
    const label = `${ticker} strike ${strikeUsd(m.account.strike)} ${dayLabel(m.account.tradingDayUnix)}`;
    const bookPda = bookPdaFor(program.programId, m.publicKey);
    try {
      const book = await program.account.orderBook.fetch(bookPda);
      const resting = Number(book.bidsLen) + Number(book.asksLen);
      enriched.push({
        pda: m.publicKey,
        label,
        bookPda,
        bookStatus: resting > 0 ? "with-orders" : "empty",
        restingCount: resting,
        tradingDayUnix: dayUnix,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Account does not exist|could not find account/i.test(msg)) {
        enriched.push({
          pda: m.publicKey,
          label,
          bookPda,
          bookStatus: "missing",
          restingCount: 0,
          tradingDayUnix: dayUnix,
        });
      } else {
        throw new Error(
          `dump-orderbook: enumeration failed at market ${m.publicKey.toBase58()}: ${msg}`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }
  }

  const bucketOrder = { "with-orders": 0, empty: 1, missing: 2 } as const;
  enriched.sort((a, b) => {
    if (bucketOrder[a.bookStatus] !== bucketOrder[b.bookStatus]) {
      return bucketOrder[a.bookStatus] - bucketOrder[b.bookStatus];
    }
    if (a.tradingDayUnix !== b.tradingDayUnix) return b.tradingDayUnix - a.tradingDayUnix;
    return a.label.localeCompare(b.label);
  });

  const withOrders = enriched.filter((e) => e.bookStatus === "with-orders").length;
  const empty = enriched.filter((e) => e.bookStatus === "empty").length;
  const missing = enriched.filter((e) => e.bookStatus === "missing").length;
  console.log(
    `\nFound ${all.length} market(s): ${withOrders} with resting orders, ${empty} empty book, ${missing} missing book PDA.`,
  );

  for (const e of enriched) {
    await dumpOne(program, e.pda, e.label);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});

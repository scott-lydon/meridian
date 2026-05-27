// matchSweep — the missing CLOB cranker.
//
// Purpose
// -------
// `programs/meridian/src/instructions/place_order.rs` only INSERTS an order
// into the slab and returns. It never matches. Crossing the book is a
// separate on-chain instruction, `match_orders`, that has to be invoked by
// an external cranker (the program's tooltip on the trade page promises
// "the permissionless cranker crosses them via match_orders (usually within
// one ~400ms slot)"). Until this file existed, NO production process ever
// called `match_orders`:
//
//   - The frontend `buyYes` / `sellYes` flow (app/src/hooks/useTrade.ts:610)
//     only sends `place_order`.
//   - The automation service ran three crons (`morning`, `settlement`,
//     `expirySweep`) — none of which call the matcher.
//   - The only `program.methods.matchOrders()` call anywhere in the repo
//     prior to this commit was the unit-test fixture in
//     `tests/meridian.test.ts:552`.
//
// The user-facing failure mode this fixes:
//
//   1. User A places a YES ask at 50¢, qty 1.
//   2. User B places a YES bid at 50¢, qty 1 (same price, crosses).
//   3. The book is now crossed at 50¢ and stays that way forever — both
//      orders sit there, USDC and YES tokens locked in escrow, neither
//      filling. Reported as "I tapped Buy Yes for the same 50¢ ... I am
//      seeing both a buy to sell yes and neither are settling" on
//      2026-05-26 for market AAPL/3AL4SEZdBuJBo3BbBgRwzmxPmgaxfzNGJ1FJJrn7jmpD.
//
// Cadence
// -------
// 1-second cron (the floor for useful crank cadence on Solana given the
// ~400ms slot time; tighter would not produce faster fills because every
// match_orders tx still has to wait for slot inclusion). UX latency for
// trade fills matters more than for settlement (30s) or the morning
// ladder creation (once-a-day), so the sweep tick has to be fast enough
// that a user clicking Buy Yes against an existing ask sees the fill
// before they switch tabs.
//
// `croner.protect: true` is set in `index.ts` so two sweep ticks cannot
// overlap; `match_orders` mutates the book and a race would either revert
// or produce duplicate maker payouts depending on ordering.
//
// Idempotency
// -----------
// Every iteration re-reads the book before issuing `match_orders`. If the
// book is already uncrossed (because the previous tick or another caller
// already matched it), the inner loop exits with zero work done. The
// on-chain instruction additionally returns a no-op when the book is
// one-sided or uncrossed (`match_orders.rs:128-142`), so even racing
// callers cannot produce a duplicate fill.
//
// ATA creation
// ------------
// `match_orders` requires three maker ATAs as writable accounts:
//   - `askMakerUsdc`: ask maker's USDC ATA (receives USDC on fill)
//   - `bidMakerYes`:  bid maker's YES ATA  (receives YES on fill)
//   - `bidMakerUsdc`: bid maker's USDC ATA (receives the price-improvement
//                     refund per the 2026-05-22 fix; transfer amount is
//                     zero on same-price crosses but the account must
//                     still exist for the IDL to encode)
// The ask maker placed an ask, so they MUST already have a YES ATA (the
// escrow source). But they might NOT have a USDC ATA. Same for the bid
// maker: they have a USDC ATA (escrow source) but maybe not a YES ATA.
// We add `createAssociatedTokenAccountIdempotent` instructions as
// preInstructions when needed, with the AUTOMATION KEYPAIR as the funder.
// This is the standard cranker pattern: the cranker eats the rent so
// makers always have somewhere to receive their fills. The rent is ~0.002
// SOL per ATA per maker, paid once per maker per token type per market.

import { PublicKey, Transaction } from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

/**
 * Minimal shape of an Anchor BN value as it crosses the JS/TS boundary.
 * We deliberately do NOT import `@coral-xyz/anchor`'s BN type here — its
 * exported type is `any` under ESM (see jobs/expirySweep.ts's same dance
 * at lines 57-62), which collapses any union containing it back to
 * `any` and defeats the typing pass below. Defining the minimal call
 * surface inline keeps `Number(value)` and `.toString()` typed properly.
 */
interface BNLike {
  toString(): string;
  toNumber(): number;
}

import type { Env } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import {
  buildAnchor,
  configPda,
  PROGRAM_VERSION_BYTE,
  YES_MINT_SEED,
  type AnchorContext,
} from "../lib/anchor.js";

/**
 * Typed view of one Order slot in the OrderBook slab. Mirrors the
 * `Order` struct in `programs/meridian/src/order_book.rs`:
 *
 *   pub struct Order {
 *       pub qty: u64,
 *       pub sequence: u64,
 *       pub owner: Pubkey,
 *       pub price_ticks: u32,
 *       pub side: u8,
 *       pub _pad: [u8; 3],
 *   }
 *
 * Anchor's JS client deserialises u64 → BN, Pubkey → PublicKey, u32/u8 →
 * number. We type those explicitly here so callers stop fighting
 * `no-unsafe-member-access` on every `.priceTicks` / `.owner`.
 */
interface OrderView {
  readonly qty: BNLike;
  readonly sequence: BNLike;
  readonly owner: PublicKey;
  readonly priceTicks: number;
  readonly side: number;
}

/**
 * Typed view of the OrderBook account. Anchor's `program.account.orderBook.fetch`
 * returns `any` because we keep the Program typed as `Program<any>` (the
 * generated IDL bindings are a 2,000+ line file we did not check in). This
 * is the one cast boundary; everything inside `uncrossOneMarket` reads from
 * `book: OrderBookView` and gets full intellisense.
 *
 * The fixed-capacity slabs `bids` / `asks` always have length =
 * `MAX_ORDERS_PER_SIDE` regardless of how many real orders are present;
 * the resting count is in `bidsLen` / `asksLen`. Callers must respect
 * those lengths, not the slab length.
 */
interface OrderBookView {
  readonly bidsLen: BNLike | number;
  readonly asksLen: BNLike | number;
  readonly bids: readonly OrderView[];
  readonly asks: readonly OrderView[];
}

/**
 * Typed view of one element returned by `program.account.market.all()`.
 * Same casting rationale as OrderBookView above.
 */
interface MarketAllRow {
  readonly publicKey: PublicKey;
  readonly account: {
    /** Discriminated-union from the Anchor IDL — one key, empty value. */
    readonly outcome: { readonly state: Record<string, unknown> };
  };
}

/**
 * Order-book seeds — must stay byte-identical with
 * `programs/meridian/src/instructions/init_order_book.rs:13-14`. The
 * Rust source is the SOLE source of truth; this constant mirrors it
 * because `lib/anchor.ts` does not export book-related seeds.
 */
const ORDER_BOOK_SEED = Buffer.from("book");
const BOOK_AUTH_SEED = Buffer.from("book_auth");

/**
 * Maximum number of match_orders calls per market per tick. The on-chain
 * instruction processes ONE crossing fill at a time (best bid against
 * best ask, qty = min of the two), so a book with N crossing levels
 * needs up to N calls to fully uncross. Cap at 10 to bound a single
 * tick's wall-clock cost; the next tick picks up any residual cross.
 */
const MAX_MATCHES_PER_MARKET_PER_TICK = 10;

/** Result shape — keyed for /health and structured logging. */
export interface MatchSweepResult {
  readonly nowUnix: number;
  /** Markets observed with a crossed book this tick. */
  readonly observedCrossed: number;
  /** Successful `match_orders` invocations this tick. */
  readonly matchesIssued: number;
  /** Markets that errored during the sweep; count only — details in logs. */
  readonly errors: number;
  /** Markets that ran out of iterations (still crossed at tick end). */
  readonly stillCrossed: number;
}

/**
 * Typed error. Mirrors the shape of `EnsureOrderBookError` for HTTP
 * handlers that branch on `.code`. Every failure mode below carries a
 * remediation string in the message body so a log scan is enough to act.
 */
export class MatchSweepError extends Error {
  constructor(
    public readonly code:
      | "CONFIG_MISSING"
      | "MARKET_NOT_FOUND"
      | "ORDER_BOOK_MISSING"
      | "BOOK_DECODE_FAILED"
      | "MATCH_TX_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "MatchSweepError";
  }
}

/**
 * Iterate every market with a `pending` outcome, derive its order book
 * PDA, attempt to uncross the book by issuing `match_orders` repeatedly
 * until either (a) the book is no longer crossed or (b) the per-market
 * iteration cap is hit. Designed to be invoked on a 1-second croner
 * schedule from `index.ts`.
 */
export async function runMatchSweep(env: Env): Promise<MatchSweepResult> {
  const ctx = buildAnchor(env);
  const usdcMint = new PublicKey(env.USDC_MINT);
  const nowUnix = Math.floor(Date.now() / 1000);

  // Same shape as expirySweep — pull every Market in one call. Daily
  // ladder is ~35-49 markets, fine for a single getProgramAccounts.
  // Single cast at the boundary; downstream code reads the typed view.
  const allMarkets = await (
    ctx.program.account as unknown as {
      market: { all: () => Promise<MarketAllRow[]> };
    }
  ).market.all();

  // Filter to pending markets only. A settled market's `match_orders`
  // call reverts with MarketAlreadySettled (match_orders.rs:101-104), so
  // including settled markets here would burn RPC requests for
  // guaranteed reverts.
  const pendingMarkets = allMarkets.filter(
    (m) => Object.keys(m.account.outcome.state)[0] === "pending",
  );

  let observedCrossed = 0;
  let matchesIssued = 0;
  let errors = 0;
  let stillCrossed = 0;

  for (const m of pendingMarkets) {
    const marketPubkey: PublicKey = m.publicKey;
    try {
      const result = await uncrossOneMarket(ctx, marketPubkey, usdcMint);
      if (result.crossedAtStart) observedCrossed += 1;
      matchesIssued += result.matchesIssued;
      if (result.stillCrossed) stillCrossed += 1;
    } catch (err) {
      errors += 1;
      // Surface every per-market failure with the market pubkey AND the
      // specific failure code so the log is grep-able. We do NOT throw
      // out of the sweep — one bad market should not block the rest.
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof MatchSweepError ? err.code : "UNKNOWN";
      logger.error(
        { market: marketPubkey.toBase58(), code, err: message },
        "match-sweep: per-market failure",
      );
    }
  }

  // Only log a summary line when the tick actually did work; an idle tick
  // (no crossed books) logs nothing. Otherwise the log fills with 12
  // "0 observed, 0 issued" lines per minute and real events get buried.
  if (observedCrossed > 0 || matchesIssued > 0 || errors > 0) {
    logger.info(
      {
        nowUnix,
        observedCrossed,
        matchesIssued,
        errors,
        stillCrossed,
      },
      "match-sweep: tick complete",
    );
  }

  return { nowUnix, observedCrossed, matchesIssued, errors, stillCrossed };
}

/**
 * Public-facing single-market entry point. Used by the manual
 * `/admin/match-market` HTTP trigger to unstick one specific market
 * without waiting for the next sweep tick. Throws `MatchSweepError` with
 * a precise `.code` so the HTTP handler can map to a useful status.
 */
export async function runMatchOneMarket(
  env: Env,
  marketPubkey: PublicKey,
): Promise<{
  market: string;
  matchesIssued: number;
  crossedAtStart: boolean;
  stillCrossed: boolean;
}> {
  const ctx = buildAnchor(env);
  const usdcMint = new PublicKey(env.USDC_MINT);
  const marketInfo = await (
    ctx.program.account as unknown as {
      market: {
        fetchNullable: (pk: PublicKey) => Promise<MarketAllRow["account"] | null>;
      };
    }
  ).market.fetchNullable(marketPubkey);
  if (!marketInfo) {
    throw new MatchSweepError(
      "MARKET_NOT_FOUND",
      `No Market account at ${marketPubkey.toBase58()} on cluster ${env.SOLANA_CLUSTER}. ` +
        `Confirm the address; check that SOLANA_RPC_URL points at the same cluster the market was created on.`,
    );
  }
  const result = await uncrossOneMarket(ctx, marketPubkey, usdcMint);
  return {
    market: marketPubkey.toBase58(),
    matchesIssued: result.matchesIssued,
    crossedAtStart: result.crossedAtStart,
    stillCrossed: result.stillCrossed,
  };
}

/**
 * Per-market inner loop. Re-fetches the book each iteration so we always
 * see the post-fill state. Bails when:
 *   - the book is one-sided or uncrossed (best bid < best ask),
 *   - the per-tick iteration cap is hit (next tick picks up the rest),
 *   - any `match_orders` call reverts (we log and bail; one bad market
 *     should not block the next one in the outer sweep).
 */
async function uncrossOneMarket(
  ctx: AnchorContext,
  marketPubkey: PublicKey,
  usdcMint: PublicKey,
): Promise<{
  crossedAtStart: boolean;
  matchesIssued: number;
  stillCrossed: boolean;
}> {
  const [orderBook] = PublicKey.findProgramAddressSync(
    [ORDER_BOOK_SEED, marketPubkey.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const [bookAuth] = PublicKey.findProgramAddressSync(
    [BOOK_AUTH_SEED, marketPubkey.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const [yesMint] = PublicKey.findProgramAddressSync(
    [YES_MINT_SEED, marketPubkey.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const usdcEscrow = getAssociatedTokenAddressSync(usdcMint, bookAuth, true);
  const yesEscrow = getAssociatedTokenAddressSync(yesMint, bookAuth, true);

  // If the book PDA doesn't exist, the market is non-tradable. Nothing
  // to match — return clean. (The trade page's "Order book PDA is not
  // initialized" repair flow handles that separately via
  // /admin/init-order-book.)
  const bookAccountInfo = await ctx.connection.getAccountInfo(orderBook);
  if (!bookAccountInfo) {
    return { crossedAtStart: false, matchesIssued: 0, stillCrossed: false };
  }

  let crossedAtStart = false;
  let matchesIssued = 0;

  for (let i = 0; i < MAX_MATCHES_PER_MARKET_PER_TICK; i += 1) {
    // Fresh fetch every iteration: on-chain state may have changed
    // between iterations (the previous match removed an order; another
    // caller cancelled an order; etc.). Single typed cast at the
    // boundary so downstream reads don't trip no-unsafe-member-access.
    let book: OrderBookView;
    try {
      book = await (
        ctx.program.account as unknown as {
          orderBook: { fetch: (pk: PublicKey) => Promise<OrderBookView> };
        }
      ).orderBook.fetch(orderBook);
    } catch (err) {
      throw new MatchSweepError(
        "BOOK_DECODE_FAILED",
        `Could not decode OrderBook PDA ${orderBook.toBase58()} for market ` +
          `${marketPubkey.toBase58()}. Most likely cause: program upgrade ` +
          `changed the OrderBook layout but the automation service is ` +
          `still on the old IDL. Underlying error: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }

    const bidsLen = Number(book.bidsLen);
    const asksLen = Number(book.asksLen);
    if (bidsLen === 0 || asksLen === 0) {
      // One-sided book — nothing to match.
      return { crossedAtStart, matchesIssued, stillCrossed: false };
    }
    // `bidsLen > 0` is the on-chain invariant that bids[0] is populated
    // (the slab is dense from index 0; insert() shifts up). If TS still
    // sees these as possibly-undefined it means a future layout change
    // broke that invariant — surface it loudly rather than reading
    // garbage into `match_orders`.
    const bestBid = book.bids[0];
    const bestAsk = book.asks[0];
    if (!bestBid || !bestAsk) {
      throw new MatchSweepError(
        "BOOK_DECODE_FAILED",
        `OrderBook PDA ${orderBook.toBase58()} reports bidsLen=${String(
          bidsLen,
        )} asksLen=${String(asksLen)} but bids[0] or asks[0] is undefined. ` +
          `This means the on-chain OrderBook slab layout no longer matches ` +
          `OrderBookView in this file; rebuild the automation service ` +
          `after regenerating the IDL.`,
      );
    }
    const bidPrice = bestBid.priceTicks;
    const askPrice = bestAsk.priceTicks;
    if (bidPrice < askPrice) {
      // Uncrossed — nothing to match.
      return { crossedAtStart, matchesIssued, stillCrossed: false };
    }

    // From here on, we WILL try to match. Record that the book was
    // crossed on entry so the outer sweep can count "observed crossed
    // markets" accurately even when the first iteration succeeds.
    if (i === 0) crossedAtStart = true;

    const bidOwner = bestBid.owner;
    const askOwner = bestAsk.owner;
    const askMakerUsdc = getAssociatedTokenAddressSync(usdcMint, askOwner);
    const bidMakerYes = getAssociatedTokenAddressSync(yesMint, bidOwner);
    const bidMakerUsdc = getAssociatedTokenAddressSync(usdcMint, bidOwner);

    // Build a single tx: createIdempotent for each maker ATA that might
    // not exist + match_orders. The idempotent variant is a no-op when
    // the ATA already exists, so we always include the three ix's; the
    // tx is tiny (3 ATA-create ix's + 1 match_orders ix ≈ ~400 bytes
    // well under the 1232 limit). Cleaner than three separate
    // getAccountInfo round-trips before every tx.
    const cranker = ctx.automationKeypair.publicKey;
    const tx = new Transaction();
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        cranker,
        askMakerUsdc,
        askOwner,
        usdcMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        cranker,
        bidMakerYes,
        bidOwner,
        yesMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        cranker,
        bidMakerUsdc,
        bidOwner,
        usdcMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );

    // The match_orders ix itself. Cast the methods builder at the
    // boundary so we don't sprinkle eslint-disable comments through
    // every account name below. Anchor's IDL-generated method builder
    // chain is typed as `MethodsNamespace<any>` regardless of how the
    // Program is typed, so the cast has to go through `unknown` (TS
    // refuses a direct cast between the two shapes). Same approach
    // every other automation job uses, just localized to one boundary.
    const methods = ctx.program.methods as unknown as {
      matchOrders: () => {
        accounts: (a: Record<string, PublicKey>) => {
          instruction: () => Promise<TransactionInstruction>;
        };
      };
    };
    const matchIx = await methods
      .matchOrders()
      .accounts({
        config: configPda(ctx.programId),
        market: marketPubkey,
        orderBook,
        bookAuthority: bookAuth,
        usdcEscrow,
        yesEscrow,
        askMakerUsdc,
        bidMakerYes,
        bidMakerUsdc,
        cranker,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    tx.add(matchIx);

    try {
      const sig = await ctx.provider.sendAndConfirm(tx, [ctx.automationKeypair]);
      matchesIssued += 1;
      logger.info(
        {
          market: marketPubkey.toBase58(),
          bidPrice,
          askPrice,
          bidQty: Number(bestBid.qty),
          askQty: Number(bestAsk.qty),
          bidOwner: bidOwner.toBase58(),
          askOwner: askOwner.toBase58(),
          sig,
        },
        "match-sweep: filled",
      );
    } catch (err) {
      // We log + re-throw as MatchSweepError so the outer loop counts
      // this market in `errors` and moves on. The next sweep tick will
      // retry; transient RPC issues self-heal.
      throw new MatchSweepError(
        "MATCH_TX_FAILED",
        `match_orders failed for market ${marketPubkey.toBase58()} at ` +
          `bid=${String(bidPrice)}¢ ask=${String(askPrice)}¢. Common causes: ` +
          `(1) the bid or ask maker's required ATA cannot be created ` +
          `(cranker out of SOL or ATA owner pubkey malformed), (2) RPC ` +
          `transient flap, (3) a concurrent cancel removed the order ` +
          `between fetch and send. Underlying error: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
  }

  // Hit the per-tick iteration cap with the book still crossed; next
  // tick continues. Not an error, but worth surfacing on /health.
  return { crossedAtStart, matchesIssued, stillCrossed: true };
}

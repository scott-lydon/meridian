// Admin-triggered custom market creation.
//
// Purpose: lets the admin spin up a fresh on-chain market at any wall-clock
// moment with a chosen ticker, strike price, and expiry. This is the test
// fixture for the end-to-end flow:
//
//   1. Admin creates market (this module) at, e.g., Sunday 17:31 with
//      strike $309 and 2-minute expiry.
//   2. Two wallets connect from separate browsers and trade against it.
//   3. The expiry-sweep cron (jobs/expirySweep.ts) auto-settles at
//      17:33:30 using the last Hermes price for the ticker.
//   4. Wallets click Redeem on the portfolio page.
//
// Why this is additive: this module never runs unless the admin POSTs
// /admin/create-market. It does not race the morning cron (which keys on
// the exact same PDA derivation — if the admin happens to pick the same
// trading-day + ticker + strike the morning cron would pick, the second
// call gets InstructionDidNotDeserialize / "account already exists"
// because Anchor's `init` constraint fires; idempotent at the PDA level).
// It does not affect any other on-chain or off-chain code path.
//
// Wraps TWO on-chain instructions (create_strike_market + init_order_book)
// because a market with no order book accepts mint_pair / redeem_pair but
// will reject place_order / buy_no / sell_no — i.e., the test would fail
// the moment a wallet tried to post a limit order. Doing both in one
// endpoint keeps the end-to-end UX one-click for the admin and prevents
// the "I created a market but trading is mysteriously broken" failure.
// The two transactions are sequential, not atomic — if create succeeds
// and init_order_book fails, the market exists but is non-tradable; the
// admin can retry by hitting the endpoint again (init_order_book is
// idempotent at the order-book PDA).

import * as anchor from "@coral-xyz/anchor";

// Anchor 0.31 ESM/CJS interop, same dance as the other automation modules.
const BN = anchor.BN ?? (anchor as unknown as { default: { BN: typeof anchor.BN } }).default.BN;

import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import type { Env } from "../lib/env.js";
import { MAG7_TICKERS, pythFeedFor, type Ticker } from "../lib/env.js";
import { logger } from "../lib/logger.js";
import {
  buildAnchor,
  configPda,
  marketPda,
  NO_MINT_SEED,
  PROGRAM_VERSION_BYTE,
  VAULT_AUTH_SEED,
  YES_MINT_SEED,
  pad6,
} from "../lib/anchor.js";
import { ensureOrderBook, EnsureOrderBookError } from "./ensureOrderBook.js";

/** USDC base units per dollar. Matches programs/meridian/src/constants.rs. */
const USDC_BASE = 1_000_000n;

/**
 * Order-book seeds. Duplicated from
 * programs/meridian/src/instructions/init_order_book.rs because the
 * automation/src/lib/anchor.ts helper does not export them yet and
 * the alternative is a cross-module import that pulls more than we need.
 * If init_order_book ever changes its seeds, both this constant and the
 * Rust source must change together.
 */
const ORDER_BOOK_SEED = Buffer.from("book");
const BOOK_AUTH_SEED = Buffer.from("book_auth");

/**
 * Domain-shaped input. Validated by callers before reaching the handler;
 * the handler still re-checks for defense in depth, because trusting a
 * single validation layer is exactly how unsafe shapes leak into the
 * Anchor program.
 */
export interface CreateCustomMarketInput {
  readonly ticker: string;
  readonly strikeUsd: number;
  readonly expirySecondsFromNow: number;
}

export interface CreateCustomMarketResult {
  readonly market: string;
  readonly yesMint: string;
  readonly noMint: string;
  readonly orderBook: string;
  readonly tradingDayUnix: number;
  readonly expiryUnix: number;
  readonly createSig: string;
  readonly initOrderBookSig: string | null;
  readonly orderBookAlreadyInitialized: boolean;
  readonly marketAlreadyExisted: boolean;
}

/**
 * Strongly-typed error so the HTTP handler can map back to a 4xx / 5xx
 * cleanly without string-matching. Each variant names the precise
 * remediation. Per the user's preference: "make sure every failure case
 * throws as clear, comprehensive and specific error".
 */
export class CreateCustomMarketError extends Error {
  constructor(
    public readonly code:
      | "INVALID_TICKER"
      | "INVALID_STRIKE"
      | "INVALID_EXPIRY"
      | "CONFIG_MISSING"
      | "ADMIN_INSUFFICIENT_SOL"
      | "CREATE_TX_FAILED"
      | "INIT_BOOK_TX_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "CreateCustomMarketError";
  }
}

/**
 * Run the admin-only create+init flow. Idempotent at the market PDA: if
 * the (trading-day, ticker, strike) tuple already has a market, the
 * existing market is returned and only init_order_book is attempted (and
 * even that is skipped if the book PDA already exists). Returning the
 * existing market instead of throwing means an admin double-click during
 * the test does not surface as a confusing error.
 */
export async function runCreateCustomMarket(
  env: Env,
  input: CreateCustomMarketInput,
): Promise<CreateCustomMarketResult> {
  // ===== Step 0: parse-don't-validate at the boundary. =====
  const ticker = input.ticker.toUpperCase();
  if (!MAG7_TICKERS.includes(ticker as Ticker)) {
    throw new CreateCustomMarketError(
      "INVALID_TICKER",
      `ticker '${input.ticker}' is not one of the supported MAG7: ${MAG7_TICKERS.join(", ")}`,
    );
  }
  // Lower bound: must be positive and finite. Upper bound: capped at $1B
  // so the BigInt(Math.round(strikeUsd * 1_000_000)) math stays well
  // below u64::MAX (~1.84e19). Without an upper cap, strikeUsd = 2e13
  // would silently overflow on the BN side and surface as a confusing
  // on-chain failure several layers below. $1B per share is two orders
  // of magnitude above the most expensive stock anyone has ever traded.
  const STRIKE_USD_MAX = 1_000_000_000;
  if (!Number.isFinite(input.strikeUsd) || input.strikeUsd <= 0) {
    throw new CreateCustomMarketError(
      "INVALID_STRIKE",
      `strikeUsd must be a positive finite number; got ${input.strikeUsd}`,
    );
  }
  if (input.strikeUsd > STRIKE_USD_MAX) {
    throw new CreateCustomMarketError(
      "INVALID_STRIKE",
      `strikeUsd ${input.strikeUsd} exceeds the upper cap of $${STRIKE_USD_MAX}; ` +
        `the cap exists to keep the on-chain u64 micros field from overflowing`,
    );
  }
  if (!Number.isFinite(input.expirySecondsFromNow) || input.expirySecondsFromNow <= 0) {
    throw new CreateCustomMarketError(
      "INVALID_EXPIRY",
      `expirySecondsFromNow must be a positive finite number of seconds; got ${input.expirySecondsFromNow}`,
    );
  }
  // Floor the expiry to whole seconds and apply a 30-second minimum so the
  // expiry-sweep grace period (60s) does not produce an instant settle in
  // the same tick the market is created. Below 30 seconds, the test
  // becomes a race against the sweep and produces confusing results.
  // Above the maximum, an off-by-1 in the JS Date math could overflow i64
  // packed into the on-chain field, which is why we cap at 1 year (well
  // below i64::MAX seconds but easy to reason about).
  const expirySecs = Math.floor(input.expirySecondsFromNow);
  const MIN_EXPIRY_SECS = 30;
  const MAX_EXPIRY_SECS = 365 * 24 * 3600;
  if (expirySecs < MIN_EXPIRY_SECS) {
    throw new CreateCustomMarketError(
      "INVALID_EXPIRY",
      `expirySecondsFromNow=${expirySecs} is less than the minimum ${MIN_EXPIRY_SECS}s (sweep grace period). ` +
        `Increase the value so the market has time to be traded before it settles.`,
    );
  }
  if (expirySecs > MAX_EXPIRY_SECS) {
    throw new CreateCustomMarketError(
      "INVALID_EXPIRY",
      `expirySecondsFromNow=${expirySecs} exceeds the maximum ${MAX_EXPIRY_SECS}s (1 year)`,
    );
  }

  const strikeUsdMicros = BigInt(Math.round(input.strikeUsd * Number(USDC_BASE)));
  if (strikeUsdMicros <= 0n) {
    throw new CreateCustomMarketError(
      "INVALID_STRIKE",
      `strikeUsd ${input.strikeUsd} rounded to <= 0 micros; pick a strike >= $0.000001`,
    );
  }

  // Trading-day is UTC midnight of "now" — same derivation the morning
  // cron and seed-late-market.mjs use, so a custom market on the same
  // ticker+strike as a same-day production market is detected as
  // duplicate-PDA by Anchor's `init` constraint (intentional safety net).
  const nowUnix = Math.floor(Date.now() / 1000);
  const utcMidnight = new Date(
    Date.UTC(
      new Date(nowUnix * 1000).getUTCFullYear(),
      new Date(nowUnix * 1000).getUTCMonth(),
      new Date(nowUnix * 1000).getUTCDate(),
      0,
      0,
      0,
    ),
  );
  const tradingDayUnix = Math.floor(utcMidnight.getTime() / 1000);
  const expiryUnix = nowUnix + expirySecs;

  // ===== Step 1: build Anchor context, derive PDAs. =====
  const ctx = buildAnchor(env);
  const cfg = configPda(ctx.programId);
  const cfgInfo = await ctx.connection.getAccountInfo(cfg);
  if (!cfgInfo) {
    throw new CreateCustomMarketError(
      "CONFIG_MISSING",
      `program config PDA ${cfg.toBase58()} is not initialized. Run scripts/init-config.mjs against this devnet program before retrying.`,
    );
  }

  const market = marketPda(ctx.programId, BigInt(tradingDayUnix), ticker, strikeUsdMicros);
  const [vaultAuth] = PublicKey.findProgramAddressSync(
    [VAULT_AUTH_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const [yesMint] = PublicKey.findProgramAddressSync(
    [YES_MINT_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const [noMint] = PublicKey.findProgramAddressSync(
    [NO_MINT_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const [orderBook] = PublicKey.findProgramAddressSync(
    [ORDER_BOOK_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const [bookAuth] = PublicKey.findProgramAddressSync(
    [BOOK_AUTH_SEED, market.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const usdcMint = new PublicKey(env.USDC_MINT);
  const vault = getAssociatedTokenAddressSync(usdcMint, vaultAuth, true);
  const usdcEscrow = getAssociatedTokenAddressSync(usdcMint, bookAuth, true);
  const yesEscrow = getAssociatedTokenAddressSync(yesMint, bookAuth, true);
  const feedIdHex = pythFeedFor(env, ticker as Ticker);
  const pythFeedIdBytes = Array.from(Buffer.from(feedIdHex, "hex"));

  // ===== Step 2: create_strike_market (idempotent). =====
  let createSig = "";
  let marketAlreadyExisted = false;
  const marketInfo = await ctx.connection.getAccountInfo(market);
  if (marketInfo) {
    marketAlreadyExisted = true;
    logger.info(
      { market: market.toBase58(), ticker, strikeUsd: input.strikeUsd },
      "create-custom-market: market PDA already exists; reusing",
    );
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createSig = await (ctx.program.methods as any)
        .createStrikeMarket(
          new BN(tradingDayUnix),
          Array.from(pad6(ticker)),
          new BN(strikeUsdMicros.toString()),
          new BN(expiryUnix),
          pythFeedIdBytes,
        )
        .accounts({
          config: cfg,
          market,
          vaultAuthority: vaultAuth,
          yesMint,
          noMint,
          vault,
          usdcMint,
          admin: ctx.adminKeypair.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([ctx.adminKeypair])
        .rpc();
      logger.info(
        {
          market: market.toBase58(),
          ticker,
          strikeUsd: input.strikeUsd,
          expiryUnix,
          sig: createSig,
        },
        "create-custom-market: created market",
      );
    } catch (err) {
      throw new CreateCustomMarketError(
        "CREATE_TX_FAILED",
        `create_strike_market transaction failed for ticker=${ticker} strike=$${input.strikeUsd}: ${String(err)}`,
      );
    }
  }

  // ===== Step 3: init_order_book (idempotent). =====
  // Delegates to the shared ensureOrderBook helper so the morning cron,
  // the admin create-market flow, and the new /admin/init-order-book
  // repair endpoint all share one implementation. See
  // automation/src/jobs/ensureOrderBook.ts for the rationale.
  //
  // Map the typed `EnsureOrderBookError` codes to this module's typed
  // `CreateCustomMarketError` codes so the HTTP handler's existing
  // status-code mapping (4xx vs 5xx) keeps working unchanged.
  let initOrderBookSig: string | null = null;
  let orderBookAlreadyInitialized = false;
  try {
    const ensured = await ensureOrderBook(ctx, market, usdcMint);
    initOrderBookSig = ensured.sig;
    orderBookAlreadyInitialized = ensured.alreadyInitialized;
  } catch (err) {
    if (err instanceof EnsureOrderBookError) {
      // ADMIN_INSUFFICIENT_SOL propagates with its own typed code so the
      // HTTP handler can render the precise "top up the admin keypair"
      // remediation; everything else collapses into INIT_BOOK_TX_FAILED.
      if (err.code === "ADMIN_INSUFFICIENT_SOL") {
        throw new CreateCustomMarketError("ADMIN_INSUFFICIENT_SOL", err.message);
      }
      throw new CreateCustomMarketError("INIT_BOOK_TX_FAILED", err.message);
    }
    throw err;
  }

  return {
    market: market.toBase58(),
    yesMint: yesMint.toBase58(),
    noMint: noMint.toBase58(),
    orderBook: orderBook.toBase58(),
    tradingDayUnix,
    expiryUnix,
    createSig: createSig || "(reused-existing-market)",
    initOrderBookSig,
    orderBookAlreadyInitialized,
    marketAlreadyExisted,
  };
}

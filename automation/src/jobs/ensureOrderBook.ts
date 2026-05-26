// ensureOrderBook — single source of truth for "given a Market PDA, make
// sure its OrderBook + escrow ATAs exist". Idempotent at the PDA level.
//
// Why this module exists
// ----------------------
//
// Before this helper, two on-chain instructions had to be paired by every
// caller that wanted a TRADABLE market: `create_strike_market` (which
// creates the Market account, the vault, and the YES/NO mints) and
// `init_order_book` (which allocates the ~7,296-byte order book PDA and
// the YES+USDC escrow ATAs). A market with `create_strike_market` but
// without `init_order_book` accepts `mint_pair` / `redeem_pair` (those
// don't touch the order book) but rejects `place_order`, `buy_no`, and
// `sell_no` because the program's `seeds = [b"book", market, ...]`
// account constraint deserialises an account that doesn't exist.
//
// `automation/src/jobs/createCustomMarket.ts` already does both. The
// 08:00 ET morning cron in `automation/src/jobs/morning.ts` historically
// only did the first one — every market it produced for the daily ladder
// was non-tradable. The user could mint a pair, but `Sell Yes` failed
// with `Simulation failed → Internal error` from Solflare because the
// program tried to deserialise an order book account that the morning
// cron never allocated. See `programs/meridian/src/instructions/place_order.rs`
// for the constraint that fires:
//
//     #[account(
//         mut,
//         seeds = [ORDER_BOOK_SEED, market.key().as_ref(), &[PROGRAM_VERSION]],
//         bump,
//     )]
//     pub order_book: AccountLoader<'info, OrderBook>,
//
// Extracting `ensureOrderBook` here means morning.ts, createCustomMarket.ts,
// and the new `/admin/init-order-book` repair endpoint all share one tested
// implementation. If `init_order_book.rs` ever grows another account, every
// caller picks up the change automatically.
//
// What "idempotent" means here
// ----------------------------
//
// The helper does a `connection.getAccountInfo(orderBook)` BEFORE issuing
// the init transaction. If the account already exists, it short-circuits
// and reports `alreadyInitialized: true` with `sig: null`. Callers can
// therefore re-run this helper safely on every boot, every cron tick, and
// every retry without paying rent twice. The Anchor `init` constraint on
// `init_order_book` would also reject a duplicate call, but the pre-check
// produces a faster + clearer result and saves an RPC round trip.

import * as anchor from "@coral-xyz/anchor";

// Anchor 0.31 ESM/CJS interop: under `import * as anchor` the BN is on
// `anchor.default.BN`. Same dance every other module here does.
const _BN = anchor.BN ?? (anchor as unknown as { default: { BN: typeof anchor.BN } }).default.BN;

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

import { logger } from "../lib/logger.js";
import type { AnchorContext } from "../lib/anchor.js";
import { PROGRAM_VERSION_BYTE, YES_MINT_SEED, configPda } from "../lib/anchor.js";

/**
 * Order-book seeds. Duplicated from
 * programs/meridian/src/instructions/init_order_book.rs because the
 * automation/src/lib/anchor.ts helper does not export them.
 * If `init_order_book.rs` ever changes its seeds, both this constant and
 * the Rust source must change together; the qa-adversary harness covers
 * the pair so a mismatch surfaces as a failing test.
 */
const ORDER_BOOK_SEED = Buffer.from("book");
const BOOK_AUTH_SEED = Buffer.from("book_auth");

/**
 * Result shape. `sig` is null when the book was already initialized
 * (no transaction issued); non-null when this call performed the init.
 *
 * `bookPubkey` and `bookAuthority` are returned because every caller
 * downstream (logs, response bodies, the trade-page repair toast) wants
 * the addresses without re-deriving them.
 */
export interface EnsureOrderBookResult {
  readonly bookPubkey: string;
  readonly bookAuthority: string;
  readonly usdcEscrow: string;
  readonly yesEscrow: string;
  readonly sig: string | null;
  readonly alreadyInitialized: boolean;
}

/**
 * Typed error. Mirrors the shape of `CreateCustomMarketError` in
 * createCustomMarket.ts so HTTP handlers can branch on `.code`.
 *
 *   - `MARKET_NOT_FOUND`: the Market account at the supplied pubkey does
 *     not exist on the configured cluster. Most likely cause: caller
 *     passed a stale base58 string, OR the cluster URL in env points at
 *     a different network than the one the market lives on.
 *   - `CONFIG_MISSING`: the program's `config` PDA hasn't been
 *     initialized. Run `scripts/init-config.mjs` once per program
 *     deploy.
 *   - `ADMIN_INSUFFICIENT_SOL`: the admin keypair is the payer for the
 *     OrderBook account (7,296 bytes ~= 0.052 SOL) plus the two escrow
 *     ATAs (~0.002 SOL each) plus tx fees. If the admin balance is
 *     below the rent threshold, the on-chain init reverts deep inside
 *     the System Program's transfer with "Transfer: insufficient
 *     lamports", which is unactionable without log parsing. We
 *     pre-check the balance and surface a one-liner remediation
 *     instead.
 *   - `INIT_BOOK_TX_FAILED`: the on-chain `init_order_book` instruction
 *     reverted for any other reason. Wrap the underlying error in the
 *     message; common causes are RPC instability or a stale IDL after a
 *     program upgrade.
 */
export class EnsureOrderBookError extends Error {
  constructor(
    public readonly code:
      | "MARKET_NOT_FOUND"
      | "CONFIG_MISSING"
      | "ADMIN_INSUFFICIENT_SOL"
      | "INIT_BOOK_TX_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "EnsureOrderBookError";
  }
}

/**
 * Minimum admin SOL balance required to safely run `init_order_book`.
 * Breakdown at the 2026-05-26 rent schedule:
 *   - OrderBook account, 7,296 bytes: ~0.05167 SOL rent-exempt
 *   - usdc_escrow ATA, 165 bytes:    ~0.00204 SOL rent-exempt
 *   - yes_escrow ATA, 165 bytes:     ~0.00204 SOL rent-exempt
 *   - transaction fees (priority + base): ~0.00005 SOL
 *   - safety margin so we don't fail at exactly the threshold:        ~0.01 SOL
 *   --------------------------------------------------------------
 *   total: ~0.066 SOL. We require 0.08 SOL to leave headroom for
 *   subsequent init runs on the same admin without re-airdropping.
 */
const ADMIN_INIT_BOOK_MIN_LAMPORTS = 80_000_000n;

/**
 * Idempotently initialize the order book for a given Market PDA.
 *
 * Inputs:
 *   ctx          — shared AnchorContext (program, connection, admin keypair)
 *   marketPubkey — PublicKey of the Market PDA (typed, not stringly-typed)
 *   usdcMint     — USDC mint PublicKey from env.USDC_MINT
 *
 * Behavior:
 *   1. Read the market account; throw `MARKET_NOT_FOUND` if absent.
 *   2. Read the config PDA; throw `CONFIG_MISSING` if absent.
 *   3. Derive the book PDA + book authority + escrow ATAs.
 *   4. If the book account exists, return `alreadyInitialized: true`.
 *   5. Otherwise call `init_order_book` and return the signature.
 *
 * All four steps map to clear error messages so a failure in production
 * is debuggable from the response body or the log line alone (per the
 * user's "every failure case throws clear, comprehensive, specific
 * error" rule).
 */
export async function ensureOrderBook(
  ctx: AnchorContext,
  marketPubkey: PublicKey,
  usdcMint: PublicKey,
): Promise<EnsureOrderBookResult> {
  // ===== Step 1: Verify the market exists. =====
  const marketInfo = await ctx.connection.getAccountInfo(marketPubkey);
  if (!marketInfo) {
    throw new EnsureOrderBookError(
      "MARKET_NOT_FOUND",
      `Market PDA ${marketPubkey.toBase58()} does not exist on the configured cluster. ` +
        `Likely causes: the base58 pubkey is stale, the cluster URL points at a different ` +
        `network than the market lives on, or the market was never created. Confirm by ` +
        `opening the address on Solana Explorer for the active cluster before retrying.`,
    );
  }

  // ===== Step 2: Verify the config PDA exists. =====
  // Without config, every program instruction (including init_order_book)
  // would revert during constraint evaluation. Surface the precise
  // remediation rather than letting the Anchor error bubble up.
  const cfg = configPda(ctx.programId);
  const cfgInfo = await ctx.connection.getAccountInfo(cfg);
  if (!cfgInfo) {
    throw new EnsureOrderBookError(
      "CONFIG_MISSING",
      `program config PDA ${cfg.toBase58()} is not initialized. Run ` +
        `scripts/init-config.mjs against this devnet program before retrying.`,
    );
  }

  // ===== Step 3: Derive everything init_order_book needs. =====
  // These derivations match init_order_book.rs verbatim. If either
  // source changes, both must change together.
  const [yesMint] = PublicKey.findProgramAddressSync(
    [YES_MINT_SEED, marketPubkey.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const [orderBook] = PublicKey.findProgramAddressSync(
    [ORDER_BOOK_SEED, marketPubkey.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const [bookAuth] = PublicKey.findProgramAddressSync(
    [BOOK_AUTH_SEED, marketPubkey.toBuffer(), PROGRAM_VERSION_BYTE],
    ctx.programId,
  );
  const usdcEscrow = getAssociatedTokenAddressSync(usdcMint, bookAuth, true);
  const yesEscrow = getAssociatedTokenAddressSync(yesMint, bookAuth, true);

  // ===== Step 3b: Verify the admin has enough SOL to pay rent + fees. =====
  // Pre-empts the deep-inside-System-Program "Transfer: insufficient
  // lamports" log line which an operator cannot act on without log
  // parsing. Surface the exact remediation (top up the admin keypair at
  // faucet.solana.com) instead.
  const adminBalance = await ctx.connection.getBalance(ctx.adminKeypair.publicKey);
  if (BigInt(adminBalance) < ADMIN_INIT_BOOK_MIN_LAMPORTS) {
    throw new EnsureOrderBookError(
      "ADMIN_INSUFFICIENT_SOL",
      `Admin keypair ${ctx.adminKeypair.publicKey.toBase58()} has only ` +
        `${(adminBalance / 1e9).toFixed(6)} SOL on the configured cluster, but ` +
        `init_order_book needs at least ${(Number(ADMIN_INIT_BOOK_MIN_LAMPORTS) / 1e9).toFixed(3)} ` +
        `SOL to pay rent for the order-book account (~0.052 SOL), two escrow ATAs (~0.004 SOL), ` +
        `and transaction fees. Top up the admin keypair at https://faucet.solana.com (paste the ` +
        `pubkey above) or send SOL from any funded devnet wallet, then retry. ` +
        `Until this is fixed, no new market can be made tradable.`,
    );
  }

  // ===== Step 4: Short-circuit if the book already exists. =====
  const bookInfo = await ctx.connection.getAccountInfo(orderBook);
  if (bookInfo) {
    logger.info(
      { market: marketPubkey.toBase58(), orderBook: orderBook.toBase58() },
      "ensureOrderBook: book already initialized; no-op",
    );
    return {
      bookPubkey: orderBook.toBase58(),
      bookAuthority: bookAuth.toBase58(),
      usdcEscrow: usdcEscrow.toBase58(),
      yesEscrow: yesEscrow.toBase58(),
      sig: null,
      alreadyInitialized: true,
    };
  }

  // ===== Step 5: Issue the init_order_book transaction. =====
  // Same account shape as createCustomMarket.ts's existing call. The
  // admin keypair lives on this server (Render env vars) — the program's
  // `address = config.admin` constraint enforces that only this key can
  // sign init_order_book. The browser cannot call this instruction
  // directly; the HTTP /admin/init-order-book endpoint is the gateway.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig: string = await (ctx.program.methods as any)
      .initOrderBook()
      .accounts({
        config: cfg,
        market: marketPubkey,
        orderBook,
        bookAuthority: bookAuth,
        usdcEscrow,
        yesEscrow,
        usdcMint,
        yesMint,
        admin: ctx.adminKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([ctx.adminKeypair])
      .rpc();
    logger.info(
      { market: marketPubkey.toBase58(), orderBook: orderBook.toBase58(), sig },
      "ensureOrderBook: initialized order book",
    );
    return {
      bookPubkey: orderBook.toBase58(),
      bookAuthority: bookAuth.toBase58(),
      usdcEscrow: usdcEscrow.toBase58(),
      yesEscrow: yesEscrow.toBase58(),
      sig,
      alreadyInitialized: false,
    };
  } catch (err) {
    // Wrap underlying error verbatim so the operator can read the Anchor
    // / RPC message without a second round of digging. Keeping the
    // original error in the message string (vs `cause`) because the
    // automation server pipeline strings these through HTTP responses
    // and Node's serializer drops `cause` by default.
    throw new EnsureOrderBookError(
      "INIT_BOOK_TX_FAILED",
      `init_order_book transaction failed for market=${marketPubkey.toBase58()}; ` +
        `the market exists but is not yet tradable. Retry once the underlying ` +
        `issue is resolved (init_order_book is idempotent at the book PDA so ` +
        `retries are safe). Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
